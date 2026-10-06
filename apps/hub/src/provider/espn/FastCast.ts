import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import {
  Array as Arr,
  Channel,
  Data,
  DateTime,
  Effect,
  FiberMap,
  Layer,
  Metric,
  Option,
  Queue,
  Record,
  Schema,
  Sink,
  Stream
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import type { FeedFrame } from "../../feed-log/Frame.ts"
import { LiveFeed, LiveFeedError } from "../LiveFeed.ts"
import * as FastCastMessage from "./FastCastMessage.ts"

/**
 * ESPN FastCast as the live feed: one socket subscribed to each league's scoreboard topic, and to the game topic of
 * each game wanted while it is open.
 */
export const layer: Layer.Layer<LiveFeed, never, HttpClient.HttpClient | Socket.WebSocketConstructor> =
  Layer.effect(
    LiveFeed,
    Effect.gen(function* () {
      const provide = Stream.provideContext(
        yield* Effect.context<HttpClient.HttpClient | Socket.WebSocketConstructor>()
      )
      return LiveFeed.of({
        frames: (leagues, wanted, resync) => provide(frames(leagues, wanted, resync))
      })
    })
  )

/** Every socket text as a frame, each `H` followed by its checkpoint; fails when the socket closes, ends, or goes quiet. */
function frames(
  leagues: ReadonlyArray<LeagueId>,
  wanted: Stream.Stream<ReadonlyArray<GameSnapshot>>,
  resync: Stream.Stream<string>
): Stream.Stream<FeedFrame, LiveFeedError, HttpClient.HttpClient | Socket.WebSocketConstructor> {
  return Stream.unwrap(connect(leagues, wanted, resync)).pipe(
    Stream.concat(Stream.fail(new LiveFeedError({ reason: "Closed", cause: "FastCast ended the stream" }))),
    Stream.timeoutOrElse({ duration: silence, orElse: () => Stream.fail(silent()) })
  )
}

/**
 * Opens the socket and subscribes to each league's topic, returning the frames that follow, the handshake's first.
 * Each game newly in `wanted` is subscribed to beside them, once per socket, and each topic in `resync` again.
 */
function connect(
  leagues: ReadonlyArray<LeagueId>,
  wanted: Stream.Stream<ReadonlyArray<GameSnapshot>>,
  resync: Stream.Stream<string>
) {
  const topics = leagues.map((league) => FastCastMessage.topic(league))
  return Effect.gen(function* () {
    const host = yield* websocketHost
    const outgoing = yield* Queue.unbounded<string>()
    yield* Queue.offer(outgoing, JSON.stringify({ op: "C" }))
    const socket = yield* Socket.makeWebSocket(
      `wss://${host.ip}:${host.securePort}/FastcastService/pubsub/profiles/12000?TrafficManager-Token=${encodeURIComponent(host.token)}`
    )
    const [first, rest] = yield* Channel.fromQueueArray(outgoing).pipe(
      Channel.pipeTo(Socket.toChannelString(socket)),
      Stream.fromChannel,
      Stream.mapError((cause) => new LiveFeedError({ reason: "Closed", cause })),
      // One text per chunk, so peeling the first leaves the rest of its batch in the stream.
      Stream.rechunk(1),
      Stream.mapEffect((text) => Effect.map(DateTime.now, (receivedAt) => ({ text, receivedAt }))),
      Stream.peel(Sink.head()),
      Effect.timeoutOrElse({ duration: silence, orElse: () => Effect.fail(silent()) })
    )
    const opened = yield* Option.match(first, {
      onNone: () =>
        Effect.fail(new LiveFeedError({ reason: "Closed", cause: "FastCast closed before connecting" })),
      onSome: Effect.succeed
    })
    const sid = yield* Option.match(decodeEnvelope(opened.text), {
      onNone: () =>
        Effect.fail(new LiveFeedError({ reason: "Refused", cause: "FastCast opened with an unknown op" })),
      onSome: ({ message }) =>
        message.op === "C"
          ? Effect.succeed(message.sid)
          : Effect.fail(new LiveFeedError({ reason: "Refused", cause: `FastCast opened with ${message.op}` }))
    })
    const subscribe = (tc: string) => Queue.offer(outgoing, JSON.stringify({ op: "S", sid, tc }))
    // At most one subscription waiting per topic, however many of its checkpoints fail meanwhile.
    const pending = yield* FiberMap.make<string>()
    const subscribeLater = (tc: string) =>
      FiberMap.run(pending, tc, subscribe(tc).pipe(Effect.delay(checkpointBackoff)), {
        onlyIfMissing: true
      }).pipe(Effect.asVoid)
    yield* Effect.forEach(topics, subscribe, { discard: true })
    yield* Metric.update(connected, 1)
    yield* Effect.addFinalizer(() => Metric.update(connected, 0))
    yield* Metric.update(connects, 1)
    yield* Effect.logInfo(`FastCast: connected to ${host.ip}, subscribed to ${topics.join(", ")}`)
    return Stream.concat(Stream.make(opened), rest).pipe(
      Stream.map((received) => Inbound.Received(received)),
      Stream.merge(resync.pipe(Stream.map((tc) => Inbound.Resync({ tc }))), { haltStrategy: "left" }),
      Stream.mapAccumEffect(
        (): Followed => new Map(),
        (followed, inbound) => framed(followed, inbound, subscribe, subscribeLater)
      ),
      Stream.merge(subscriptions(wanted, subscribe), { haltStrategy: "left" })
    )
  }).pipe(Effect.withSpan("FastCast.connect", { attributes: { "sportal.topics": topics } }))
}

/** Subscribes to the game topic of each game in `wanted` not yet subscribed on this socket. */
function subscriptions(
  wanted: Stream.Stream<ReadonlyArray<GameSnapshot>>,
  subscribe: (tc: string) => Effect.Effect<boolean>
): Stream.Stream<never> {
  return wanted.pipe(
    Stream.mapAccumEffect(
      (): ReadonlySet<string> => new Set(),
      (subscribed, games) => {
        const fresh = Arr.dedupe(games.map((game) => FastCastMessage.topic(game.league, game.id))).filter(
          (tc) => !subscribed.has(tc)
        )
        return Effect.forEach(fresh, subscribe, { discard: true }).pipe(
          Effect.tap(() =>
            fresh.length === 0 ? Effect.void : Effect.logInfo(`FastCast: subscribed to ${fresh.join(", ")}`)
          ),
          Effect.as([new Set([...subscribed, ...fresh]), []] as const)
        )
      }
    ),
    Stream.drain
  )
}

/**
 * Where the socket is in each topic's messages: waiting for a checkpoint (after `failures` in a row did not load),
 * following on from its checkpoint, or given up on until the socket reconnects.
 */
type Sequence = Data.TaggedEnum<{
  AwaitingCheckpoint: { readonly failures: number }
  Following: object
  GivenUp: object
}>
const Sequence = Data.taggedEnum<Sequence>()

type Followed = ReadonlyMap<string, Sequence>

/** What reaches the socket's fold: a text the socket received, or a topic its decoder resyncs. */
type Inbound = Data.TaggedEnum<{
  Received: { readonly text: string; readonly receivedAt: DateTime.Utc }
  Resync: { readonly tc: string }
}>
const Inbound = Data.taggedEnum<Inbound>()

/**
 * A socket text as its frame, an `H`'s followed by its checkpoint. A resync of a topic this socket follows (its
 * decoder's document missed a message, or could not apply one) subscribes to the topic again, so FastCast sends a
 * fresh `H` to resync from. A checkpoint that does not load is logged and counted, and its topic subscribed to again
 * after a backoff, until `givenUpAfter` have failed in a row.
 */
function framed(
  followed: Followed,
  inbound: Inbound,
  subscribe: (tc: string) => Effect.Effect<boolean>,
  subscribeLater: (tc: string) => Effect.Effect<void>
): Effect.Effect<readonly [Followed, ReadonlyArray<FeedFrame>], never, HttpClient.HttpClient> {
  if (inbound._tag === "Resync") {
    const { tc } = inbound
    // A topic waiting for its checkpoint already has one coming, or has been given up on.
    return followed.get(tc)?._tag === "Following"
      ? Effect.logInfo(`FastCast: ${tc} lost its document; subscribing to it again`).pipe(
          Effect.andThen(subscribe(tc)),
          Effect.as([new Map([...followed, [tc, Sequence.AwaitingCheckpoint({ failures: 0 })]]), []] as const)
        )
      : Effect.succeed([followed, []] as const)
  }
  const { text, receivedAt } = inbound
  const envelope = Option.getOrUndefined(decodeEnvelope(text))
  const frame: FeedFrame = {
    receivedAt,
    feed: "fastcast",
    channel: envelope?.channel ?? "socket",
    kind: "message",
    body: text,
    sourceId: envelope?.sourceId,
    sentAt: envelope?.sentAt
  }
  if (envelope === undefined) {
    return Effect.logDebug("FastCast: framed a text of an unknown op", text).pipe(
      Effect.as([followed, [frame]] as const)
    )
  }
  const { message } = envelope
  if (message.op !== "H") return Effect.succeed([followed, [frame]] as const)
  return checkpoint(message).pipe(
    Effect.map(
      (body) =>
        [
          new Map([...followed, [message.tc, Sequence.Following()]]),
          [frame, { ...frame, kind: "checkpoint", body }]
        ] as const
    ),
    Effect.catch((cause) =>
      checkpointFailed(followed.get(message.tc), message, cause, subscribeLater).pipe(
        Effect.map((next) => [new Map([...followed, [message.tc, next]]), [frame]] as const)
      )
    )
  )
}

/**
 * Where a topic is once a checkpoint of it did not load, counted and logged: subscribed to again after the backoff,
 * or, at `givenUpAfter` failures in a row, given up on, said once.
 */
function checkpointFailed(
  sequence: Sequence | undefined,
  envelope: { readonly tc: string; readonly mid: number },
  cause: unknown,
  subscribeLater: (tc: string) => Effect.Effect<void>
): Effect.Effect<Sequence> {
  const { tc, mid } = envelope
  const counted = Metric.update(
    Metric.withAttributes(
      checkpointFailures,
      Record.getSomes({ league: Option.map(FastCastMessage.owner(tc), (owner) => owner.league) })
    ),
    1
  )
  const failures = Sequence.$match(sequence ?? Sequence.AwaitingCheckpoint({ failures: 0 }), {
    AwaitingCheckpoint: ({ failures }) => Option.some(failures + 1),
    Following: () => Option.some(1),
    GivenUp: () => Option.none()
  })
  return Option.match(failures, {
    onNone: () => Effect.succeed(Sequence.GivenUp()),
    onSome: (failures): Effect.Effect<Sequence> =>
      failures < givenUpAfter
        ? Effect.logWarning(
            `FastCast: the checkpoint of ${tc} at ${mid} did not load; subscribing to it again in ${checkpointBackoff}`,
            cause
          ).pipe(Effect.andThen(subscribeLater(tc)), Effect.as(Sequence.AwaitingCheckpoint({ failures })))
        : Effect.logWarning(
            `FastCast: the checkpoint of ${tc} did not load ${failures} times in a row; not subscribing to it again until the socket reconnects`,
            cause
          ).pipe(Effect.as(Sequence.GivenUp()))
  }).pipe(
    Effect.annotateLogs({ topic: tc }),
    Effect.tap(() => counted)
  )
}

/** The body of the checkpoint an `H` points to, as served. */
function checkpoint(envelope: { readonly pl: string }) {
  return HttpClient.get(envelope.pl).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.timeout(checkpointTimeout)
  )
}

// Well inside `silence`, so a checkpoint that hangs fails its topic rather than the whole socket.
const checkpointTimeout = "20 seconds"

// A checkpoint that did not load is asked for again, by subscribing again, after this long, until this many in a row
// have failed.
const checkpointBackoff = "30 seconds"
const givenUpAfter = 5

const decodeEnvelope = Schema.decodeUnknownOption(FastCastMessage.Envelope)

// FastCast sends `B` itself after 10 s without another frame (it answers a client's `B` with an error, so the client
// never sends one); live, a subscribed socket went at most 20 s between frames.
const silence = "45 seconds"

function silent(): LiveFeedError {
  return new LiveFeedError({ reason: "Silent", cause: `No FastCast message for ${silence}` })
}

const websocketHost = HttpClient.get("https://fastcast.semfs.engsvc.go.com/public/websockethost").pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.flatMap(HttpClientResponse.schemaBodyJson(FastCastMessage.Host)),
  Effect.mapError((cause) => new LiveFeedError({ reason: "Refused", cause }))
)

const connected = Metric.gauge("sportal_live_feed_connected", {
  description: "Whether the live feed is subscribed (1) or not (0)"
})

const checkpointFailures = Metric.counter("sportal_live_feed_checkpoint_failures", {
  description: "FastCast checkpoints that did not load, by league",
  incremental: true
})

const connects = Metric.counter("sportal_live_feed_connects", {
  description: "Times the live feed connected and subscribed",
  incremental: true
})
