import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import {
  Array as Arr,
  Channel,
  Context,
  DateTime,
  Effect,
  FiberMap,
  Layer,
  Metric,
  Option,
  PubSub,
  Queue,
  Record,
  Ref,
  Result,
  Schedule,
  Schema,
  Sink,
  Stream
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { Frame } from "../../Frame.ts"
import { HubConfig } from "../../HubConfig.ts"
import { type LiveFeed, LiveFeedDemand, ProviderUnavailable } from "../Provider.ts"
import * as FastCastMessage from "./FastCastMessage.ts"
import { ownerOf, topicOf } from "./FastCastTopic.ts"

/**
 * ESPN FastCast as the ESPN provider's push: one socket subscribed to each league's scoreboard topic, and to the game
 * topic of each game its demand names while it is open, each channel its demand resyncs followed again. Every socket
 * text is a frame, each `H` followed by its checkpoint; fails when the socket closes, ends, or goes quiet. A topic whose
 * checkpoint fails is followed again on the retry `FastCast.make` is given; `FastCast.layer` gives it `layer`'s own.
 */
export class FastCast extends Context.Service<
  FastCast,
  {
    readonly push: LiveFeed
  }
>()("sportal/hub/FastCast") {
  /**
   * FastCast for the leagues `HubConfig` names, following a topic whose checkpoint failed again on `checkpointRetry`,
   * then leaving it to polling.
   */
  static readonly make = (checkpointRetry: Schedule.Schedule<unknown, CheckpointUnread>) =>
    Effect.gen(function* () {
      const { leagues } = yield* HubConfig
      const context = yield* Effect.context<HttpClient.HttpClient | Socket.WebSocketConstructor>()
      const provide = Stream.provideContext(context)
      return FastCast.of({
        push: (demand) =>
          Stream.unwrap(
            Stream.partition(
              demand,
              LiveFeedDemand.$match({
                Games: ({ games }) => Result.succeed(games),
                Resync: ({ channel }) => Result.fail(channel)
              }),
              { capacity: "unbounded" }
            ).pipe(Effect.flatMap(([wanted, resync]) => connect(leagues, wanted, resync, checkpointRetry)))
          ).pipe(
            Stream.concat(
              Stream.fail(new ProviderUnavailable({ reason: "Closed", cause: "FastCast ended the stream" }))
            ),
            Stream.timeoutOrElse({ duration: silence, orElse: () => Stream.fail(silent()) }),
            provide
          )
      })
    })

  /** FastCast whose `checkpointRetry` is every 30 s, five tries in all, then the topic is left to polling. */
  static readonly layer: Layer.Layer<
    FastCast,
    never,
    HttpClient.HttpClient | Socket.WebSocketConstructor | HubConfig
  > = Layer.effect(
    FastCast,
    FastCast.make(
      Schedule.spaced("30 seconds").pipe(
        Schedule.setInputType<CheckpointUnread>(),
        Schedule.upTo({ times: 4 })
      )
    )
  )
}

/** A topic's checkpoint was not read: it could not be loaded (unreachable, refused, timed out) or did not decode. */
export class CheckpointUnread extends Schema.TaggedError<CheckpointUnread>()("CheckpointUnread", {
  topic: Schema.String,
  reason: Schema.Literals(["Unloaded", "Undecodable"]),
  cause: Schema.Defect()
}) {}

/**
 * Opens the socket and follows each league's topic, returning the frames that follow, the handshake's first. Each
 * game newly in `wanted` is followed beside them, once per socket, and each followed topic in `resync` again. To follow
 * a topic is to subscribe to it and wait for its checkpoint; one that fails is followed again on `retry`, one follow
 * per topic at a time, and once `retry` is done the topic is left to polling until the socket reconnects.
 */
const connect = Effect.fn("FastCast.connect")(function* (
  leagues: ReadonlyArray<LeagueId>,
  wanted: Stream.Stream<ReadonlyArray<GameSnapshot>>,
  resync: Stream.Stream<string>,
  retry: Schedule.Schedule<unknown, CheckpointUnread>
) {
  const topics = leagues.map((league) => topicOf(league))
  yield* Effect.annotateCurrentSpan("sportal.topics", topics)

  const host = yield* websocketHost
  const outgoing = yield* Queue.unbounded<string>()
  yield* Queue.offer(outgoing, JSON.stringify({ op: "C" }))
  const socket = yield* Socket.makeWebSocket(
    `wss://${host.ip}:${host.securePort}/FastcastService/pubsub/profiles/12000?TrafficManager-Token=${encodeURIComponent(host.token)}`
  )
  const [first, rest] = yield* Channel.fromQueueArray(outgoing).pipe(
    Channel.pipeTo(Socket.toChannelString(socket)),
    Stream.fromChannel,
    Stream.mapError((cause) => new ProviderUnavailable({ reason: "Closed", cause })),
    // One text per chunk, so peeling the first leaves the rest of its batch in the stream.
    Stream.rechunk(1),
    Stream.mapEffect((text) => Effect.map(DateTime.now, (receivedAt) => ({ text, receivedAt }))),
    Stream.peel(Sink.head()),
    Effect.timeoutOrElse({ duration: silence, orElse: () => Effect.fail(silent()) })
  )
  const opened = yield* Effect.fromOption(
    first,
    () => new ProviderUnavailable({ reason: "Closed", cause: "FastCast closed before connecting" })
  )
  const sid = yield* Option.match(decodeEnvelope(opened.text), {
    onNone: () =>
      Effect.fail(
        new ProviderUnavailable({ reason: "Refused", cause: "FastCast opened with an unknown op" })
      ),
    onSome: ({ message }) =>
      message.op === "C"
        ? Effect.succeed(message.sid)
        : Effect.fail(
            new ProviderUnavailable({ reason: "Refused", cause: `FastCast opened with ${message.op}` })
          )
  })

  const subscribe = (tc: string) => Queue.offer(outgoing, JSON.stringify({ op: "S", sid, tc }))
  // Each checkpoint's outcome, by topic: its topic on success, or why it failed.
  const outcomes = yield* PubSub.unbounded<Result.Result<string, CheckpointUnread>>()
  const follows = yield* FiberMap.make<string>()
  const followed = yield* Ref.make<ReadonlySet<string>>(new Set())
  const leftToPolling = yield* Ref.make<ReadonlySet<string>>(new Set())
  const attempt = Effect.fnUntraced(function* (tc: string) {
    const outcome = yield* PubSub.subscribe(outcomes)
    yield* subscribe(tc)
    const result = yield* Stream.fromSubscription(outcome).pipe(
      Stream.filter((one) =>
        Result.match(one, {
          onSuccess: (topic) => topic === tc,
          onFailure: (error) => error.topic === tc
        })
      ),
      Stream.runHead
    )
    yield* Option.match(result, {
      onNone: () => Effect.void,
      onSome: (one) => Effect.asVoid(Effect.fromResult(one))
    })
  }, Effect.scoped)
  const follow = Effect.fnUntraced(function* (tc: string) {
    const left = yield* Ref.get(leftToPolling)
    if (left.has(tc)) return
    yield* Ref.update(followed, (topics) => new Set([...topics, tc]))
    yield* FiberMap.run(
      follows,
      tc,
      attempt(tc).pipe(
        Effect.retry(retry),
        Effect.catch((error) =>
          Ref.update(leftToPolling, (topics) => new Set([...topics, tc])).pipe(
            Effect.andThen(
              Effect.logWarning(
                `FastCast: ${tc} is left to polling until the socket reconnects; its checkpoint kept failing`,
                error
              )
            ),
            Effect.annotateLogs({ topic: tc })
          )
        )
      ),
      { onlyIfMissing: true }
    )
  })
  // A topic its decoder resyncs is followed again only if this socket follows it.
  const followAgain = (tc: string) =>
    Effect.flatMap(Ref.get(followed), (topics) =>
      topics.has(tc)
        ? Effect.logInfo(`FastCast: ${tc} lost its document; following it again`).pipe(
            Effect.andThen(follow(tc))
          )
        : Effect.void
    )

  yield* Effect.forEach(topics, follow, { discard: true })
  yield* Metric.update(connected, 1)
  yield* Effect.addFinalizer(() => Metric.update(connected, 0))
  yield* Metric.update(connects, 1)
  yield* Effect.logInfo(`FastCast: connected to ${host.ip}, subscribed to ${topics.join(", ")}`)

  return Stream.concat(Stream.make(opened), rest).pipe(
    Stream.mapEffect((received) => framed(received, (outcome) => PubSub.publish(outcomes, outcome))),
    Stream.flattenIterable,
    Stream.merge(resync.pipe(Stream.mapEffect(followAgain), Stream.drain), { haltStrategy: "left" }),
    Stream.merge(subscriptions(wanted, follow), { haltStrategy: "left" })
  )
})

/** Follows the game topic of each game in `wanted` not yet followed on this socket. */
function subscriptions(
  wanted: Stream.Stream<ReadonlyArray<GameSnapshot>>,
  follow: (tc: string) => Effect.Effect<void>
): Stream.Stream<never> {
  return wanted.pipe(
    Stream.mapAccumEffect(
      (): ReadonlySet<string> => new Set(),
      (subscribed, games) => {
        const fresh = Arr.dedupe(games.map((game) => topicOf(game.league, game.id))).filter(
          (tc) => !subscribed.has(tc)
        )
        return Effect.forEach(fresh, follow, { discard: true }).pipe(
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
 * A socket text as its frame, an `H`'s followed by its checkpoint once it loads and decodes. Either way the `H`'s
 * outcome is handed to `published`; a checkpoint that fails is logged and counted, and only its `H` is framed.
 */
const framed = Effect.fnUntraced(function* (
  received: { readonly text: string; readonly receivedAt: DateTime.Utc },
  published: (outcome: Result.Result<string, CheckpointUnread>) => Effect.Effect<boolean>
) {
  const { text, receivedAt } = received
  const envelope = Option.getOrUndefined(decodeEnvelope(text))
  const frame = new Frame({
    receivedAt,
    source: "push",
    channel: envelope?.channel ?? "socket",
    kind: "change",
    body: text,
    number: envelope?.mid,
    sentAt: envelope?.sentAt
  })
  if (envelope === undefined) {
    yield* Effect.logDebug("FastCast: framed a text of an unknown op", text)
    return [frame]
  }
  const { message } = envelope
  if (message.op !== "H") return [frame]

  const loaded = yield* checkpoint(message).pipe(Effect.result)
  if (Result.isSuccess(loaded)) {
    yield* published(Result.succeed(message.tc))
    return [frame, new Frame({ ...frame, kind: "whole", body: loaded.success })]
  }

  const error = loaded.failure
  yield* Effect.logWarning(
    `FastCast: the checkpoint of ${message.tc} at ${message.mid} failed`,
    error.cause
  ).pipe(Effect.annotateLogs({ topic: message.tc, reason: error.reason }))
  yield* Metric.update(
    Metric.withAttributes(
      checkpointFailures,
      Record.getSomes({ league: Option.map(ownerOf(message.tc), (owner) => owner.league) })
    ),
    1
  )
  yield* published(Result.fail(error))
  return [frame]
})

/** The body of the checkpoint an `H` points to, as served, once it decodes as its topic's checkpoint. */
function checkpoint(envelope: { readonly tc: string; readonly pl: string }) {
  return HttpClient.get(envelope.pl).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.timeout(checkpointTimeout),
    Effect.mapError((cause) => new CheckpointUnread({ topic: envelope.tc, reason: "Unloaded", cause })),
    Effect.tap((body) =>
      Option.match(ownerOf(envelope.tc), {
        onNone: () => Effect.void,
        onSome: (owner) =>
          Schema.decodeEffect(FastCastMessage.Checkpoint(owner))(body).pipe(
            Effect.mapError(
              (cause) => new CheckpointUnread({ topic: envelope.tc, reason: "Undecodable", cause })
            )
          )
      })
    )
  )
}

// Well inside `silence`, so a checkpoint that hangs fails its topic rather than the whole socket.
const checkpointTimeout = "20 seconds"

const decodeEnvelope = Schema.decodeUnknownOption(FastCastMessage.Envelope)

// FastCast sends `B` itself after 10 s without another frame (it answers a client's `B` with an error, so the client
// never sends one); live, a subscribed socket went at most 20 s between frames.
const silence = "45 seconds"

function silent(): ProviderUnavailable {
  return new ProviderUnavailable({ reason: "Silent", cause: `No FastCast message for ${silence}` })
}

const websocketHost = HttpClient.get("https://fastcast.semfs.engsvc.go.com/public/websockethost").pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.flatMap(HttpClientResponse.schemaBodyJson(FastCastMessage.Host)),
  Effect.mapError((cause) => new ProviderUnavailable({ reason: "Refused", cause }))
)

const connected = Metric.gauge("sportal_live_feed_connected", {
  description: "Whether the live feed is subscribed (1) or not (0)"
})

const checkpointFailures = Metric.counter("sportal_live_feed_checkpoint_failures", {
  description: "FastCast checkpoints that did not load or did not decode, by league",
  incremental: true
})

const connects = Metric.counter("sportal_live_feed_connects", {
  description: "Times the live feed connected and subscribed",
  incremental: true
})
