import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import {
  Array as Arr,
  Channel,
  Data,
  DateTime,
  Effect,
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
import { Frame } from "../../feed/Frame.ts"
import { LiveFeed, LiveFeedError } from "../LiveFeed.ts"
import * as EspnDecode from "./EspnDecode.ts"
import * as FastCastDocument from "./FastCastDocument.ts"
import * as FastCastPayload from "./FastCastPayload.ts"

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
        frames: (leagues, wanted) => provide(frames(leagues, wanted)),
        games: (leagues) =>
          EspnDecode.pushedGames(
            provide(frames(leagues, Stream.empty)).pipe(
              Stream.zipWithIndex,
              Stream.map(([frame, seq]) => new Frame({ ...frame, seq }))
            )
          )
      })
    })
  )

/** Every socket text as a frame, each `H` followed by its checkpoint; fails when the socket closes, ends, or goes quiet. */
function frames(
  leagues: ReadonlyArray<LeagueId>,
  wanted: Stream.Stream<ReadonlyArray<GameSnapshot>>
): Stream.Stream<Omit<Frame, "seq">, LiveFeedError, HttpClient.HttpClient | Socket.WebSocketConstructor> {
  return Stream.unwrap(connect(leagues, wanted)).pipe(
    Stream.concat(Stream.fail(new LiveFeedError({ reason: "Closed", cause: "FastCast ended the stream" }))),
    Stream.timeoutOrElse({ duration: silence, orElse: () => Stream.fail(silent()) })
  )
}

/**
 * Opens the socket and subscribes to each league's topic, returning the frames that follow, the handshake's first.
 * Each game newly in `wanted` is subscribed to beside them, once per socket.
 */
function connect(leagues: ReadonlyArray<LeagueId>, wanted: Stream.Stream<ReadonlyArray<GameSnapshot>>) {
  const topics = leagues.map((league) => FastCastDocument.topic(league))
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
      onSome: (envelope) =>
        envelope.op === "C"
          ? Effect.succeed(envelope.sid)
          : Effect.fail(
              new LiveFeedError({ reason: "Refused", cause: `FastCast opened with ${envelope.op}` })
            )
    })
    const subscribe = (tc: string) => Queue.offer(outgoing, JSON.stringify({ op: "S", sid, tc }))
    const scope = yield* Effect.scope
    const subscribeLater = (tc: string) =>
      subscribe(tc).pipe(Effect.delay(checkpointBackoff), Effect.forkIn(scope), Effect.asVoid)
    yield* Effect.forEach(topics, subscribe, { discard: true })
    yield* Metric.update(connected, 1)
    yield* Effect.addFinalizer(() => Metric.update(connected, 0))
    yield* Metric.update(connects, 1)
    yield* Effect.logInfo(`FastCast: connected to ${host.ip}, subscribed to ${topics.join(", ")}`)
    return Stream.concat(Stream.make(opened), rest).pipe(
      Stream.mapAccumEffect(
        (): Followed => new Map(),
        (followed, received) => framed(followed, received, subscribe, subscribeLater)
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
        const fresh = Arr.dedupe(games.map((game) => FastCastDocument.topic(game.league, game.id))).filter(
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

/** Where the socket is in each topic's messages: waiting for a checkpoint, or following on from message `mid`. */
type Sequence = Data.TaggedEnum<{
  AwaitingCheckpoint: object
  Following: { readonly mid: number }
}>
const Sequence = Data.taggedEnum<Sequence>()

type Followed = ReadonlyMap<string, Sequence>

/**
 * A socket text as its frame, an `H`'s followed by its checkpoint. A message that skips a mid on its topic subscribes
 * to the topic again, so FastCast sends a fresh `H` to resync from. A checkpoint that does not load is logged and
 * counted, and its topic subscribed to again after a backoff.
 */
function framed(
  followed: Followed,
  received: { readonly text: string; readonly receivedAt: DateTime.Utc },
  subscribe: (tc: string) => Effect.Effect<boolean>,
  subscribeLater: (tc: string) => Effect.Effect<void>
): Effect.Effect<readonly [Followed, ReadonlyArray<Omit<Frame, "seq">>], never, HttpClient.HttpClient> {
  const { text, receivedAt } = received
  const message = (envelope: Option.Option<typeof FastCastPayload.Envelope.Type>): Omit<Frame, "seq"> => ({
    receivedAt,
    feed: "fastcast",
    channel: Option.getOrElse(
      Option.flatMap(envelope, (known) => ("tc" in known ? Option.some(known.tc) : Option.none())),
      () => "socket"
    ),
    kind: "message",
    body: text,
    sourceId: Option.getOrUndefined(
      Option.flatMap(envelope, (known) => ("mid" in known ? Option.some(known.mid) : Option.none()))
    ),
    sentAt: Option.getOrUndefined(
      Option.flatMap(envelope, (known) =>
        known.op === "R" || known.op === "P"
          ? Option.map(Option.fromUndefinedOr(known.pl.ts), DateTime.makeUnsafe)
          : Option.none()
      )
    )
  })
  return Option.match(decodeEnvelope(text), {
    onNone: () =>
      Effect.logDebug("FastCast: framed a text of an unknown op", text).pipe(
        Effect.as([followed, [message(Option.none())]] as const)
      ),
    onSome: (envelope) => {
      const frame = message(Option.some(envelope))
      switch (envelope.op) {
        case "H":
          return checkpoint(envelope).pipe(
            Effect.map(
              (body) =>
                [
                  new Map([...followed, [envelope.tc, Sequence.Following({ mid: envelope.mid })]]),
                  [frame, { ...frame, kind: "checkpoint", body }]
                ] as const
            ),
            Effect.catch((cause) =>
              Effect.logWarning(
                `FastCast: the checkpoint of ${envelope.tc} at ${envelope.mid} did not load; subscribing to it again in ${checkpointBackoff}`,
                cause
              ).pipe(
                Effect.annotateLogs({ topic: envelope.tc }),
                Effect.andThen(
                  Metric.update(
                    Metric.withAttributes(
                      checkpointFailures,
                      Record.getSomes({
                        league: Option.map(FastCastDocument.owner(envelope.tc), (owner) => owner.league)
                      })
                    ),
                    1
                  )
                ),
                Effect.andThen(subscribeLater(envelope.tc)),
                Effect.as([
                  new Map([...followed, [envelope.tc, Sequence.AwaitingCheckpoint()]]),
                  [frame]
                ] as const)
              )
            )
          )
        case "R":
        case "P":
        case "I":
          return Sequence.$match(followed.get(envelope.tc) ?? Sequence.AwaitingCheckpoint(), {
            AwaitingCheckpoint: () => Effect.succeed([followed, [frame]] as const),
            Following: ({ mid }) =>
              mid + 1 === envelope.mid
                ? Effect.succeed([
                    new Map([...followed, [envelope.tc, Sequence.Following({ mid: envelope.mid })]]),
                    [frame]
                  ] as const)
                : Effect.logWarning(
                    `FastCast: message ${envelope.mid} on ${envelope.tc} came after ${mid}; subscribing to it again`
                  ).pipe(
                    Effect.andThen(subscribe(envelope.tc)),
                    Effect.as([
                      new Map([...followed, [envelope.tc, Sequence.AwaitingCheckpoint()]]),
                      [frame]
                    ] as const)
                  )
          })
        default:
          return Effect.succeed([followed, [frame]] as const)
      }
    }
  })
}

/** The body of the checkpoint an `H` points to, as served. */
function checkpoint(envelope: { readonly pl: string }) {
  return HttpClient.get(envelope.pl).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text)
  )
}

// A checkpoint that did not load is asked for again once, by subscribing again, after this long.
const checkpointBackoff = "30 seconds"

const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(FastCastPayload.Envelope))

// FastCast sends `B` itself after 10 s without another frame (it answers a client's `B` with an error, so the client
// never sends one); live, a subscribed socket went at most 20 s between frames.
const silence = "45 seconds"

function silent(): LiveFeedError {
  return new LiveFeedError({ reason: "Silent", cause: `No FastCast message for ${silence}` })
}

const websocketHost = HttpClient.get("https://fastcast.semfs.engsvc.go.com/public/websockethost").pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.flatMap(HttpClientResponse.schemaBodyJson(FastCastPayload.Host)),
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
