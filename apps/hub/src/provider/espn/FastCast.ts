import {
  Channel,
  Context,
  type Duration,
  Effect,
  FiberMap,
  HashMap,
  Layer,
  Option,
  Queue,
  Ref,
  Result,
  Schedule,
  Schema,
  Sink,
  Stream
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import * as FastCastMessage from "./FastCastMessage.ts"
import { Frame } from "./Frame.ts"
import { ProviderUnavailable } from "./ProviderUnavailable.ts"
import { type Topic, tcOf, topicOf } from "./Topic.ts"

/**
 * ESPN FastCast as the ESPN provider's push: one socket that subscribes to the topics it is told to follow, subscribes
 * to a topic again when told its document was lost or a while after its checkpoint fails, and opens again when it
 * closes, ends or goes quiet. Every socket text is a frame, each `H` followed by its checkpoint.
 */
export class FastCast extends Context.Service<
  FastCast,
  {
    /**
     * Every socket text and checkpoint, as frames, for as long as it runs, following what `wanted` last said. On each
     * socket it subscribes to every wanted topic, then to each topic that becomes wanted, and to each whose document goes
     * from synced back to waiting for its checkpoint. When the socket closes, ends or goes silent, it reconnects on its
     * backoff and reads `wanted` again. Fails only as a defect, once a reconnect that ends is done.
     */
    follow(wanted: Stream.Stream<Wanted>): Stream.Stream<Frame>
  }
>()("sportal/hub/provider/espn/FastCast") {
  /**
   * FastCast subscribing again to a topic whose checkpoint failed once `refollow` has passed, if it is still wanted,
   * and opening the socket again on `reconnect` after each failure, which it logs with its reason.
   */
  static readonly make = (retry: {
    readonly refollow: Duration.Input
    readonly reconnect: Schedule.Schedule<unknown, ProviderUnavailable>
  }) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<HttpClient.HttpClient | Socket.WebSocketConstructor>()
      const follow = (wanted: Stream.Stream<Wanted>) =>
        Stream.unwrap(connect(wanted, retry.refollow)).pipe(
          Stream.concat(
            Stream.fail(new ProviderUnavailable({ reason: "Closed", cause: "FastCast ended the stream" }))
          ),
          Stream.timeoutOrElse({ duration: silence, orElse: () => Stream.fail(silent()) }),
          Stream.tapError((error) =>
            Effect.logWarning(`FastCast: the live feed failed (${error.reason}); subscribing again`, error)
          ),
          Stream.retry(retry.reconnect),
          Stream.orDie,
          Stream.provideContext(context)
        )
      return FastCast.of({ follow })
    })

  /**
   * FastCast subscribing again to a topic whose checkpoint failed after 30 s; it opens the socket again after about 1
   * second, then twice as long each time, jittered, up to a minute, without end. `Stream.retry` resets that backoff once
   * the socket delivers again.
   */
  static readonly layer: Layer.Layer<FastCast, never, HttpClient.HttpClient | Socket.WebSocketConstructor> =
    Layer.effect(
      FastCast,
      FastCast.make({
        refollow: "30 seconds",
        reconnect: Schedule.min([
          Schedule.exponential("1 second").pipe(Schedule.jittered),
          Schedule.spaced("1 minute")
        ])
      })
    )

  /** FastCast as a test drives it: the frames `follow` gives for what it is told to follow. */
  static layerTest(follow: (wanted: Stream.Stream<Wanted>) => Stream.Stream<Frame>): Layer.Layer<FastCast> {
    return Layer.succeed(FastCast, FastCast.of({ follow }))
  }
}

/** The topics FastCast follows, each with whether its document is synced or waits for its checkpoint. */
export type Wanted = HashMap.HashMap<Topic, "Synced" | "AwaitingCheckpoint">

/** A topic's checkpoint was not read: it could not be loaded (unreachable, refused, timed out) or did not decode. */
class CheckpointUnread extends Schema.TaggedError<CheckpointUnread>()("CheckpointUnread", {
  topic: Schema.String,
  reason: Schema.Literals(["Unloaded", "Undecodable"]),
  cause: Schema.Defect()
}) {}

/**
 * Opens the socket, then subscribes as `wanted` says, returning the frames that follow, the handshake's first. A topic
 * whose checkpoint fails is subscribed to again once `refollow` has passed, if it is still wanted; one wait per topic.
 */
const connect = Effect.fnUntraced(function* (wanted: Stream.Stream<Wanted>, refollow: Duration.Input) {
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
    Stream.peel(Sink.head()),
    Effect.timeoutOrElse({ duration: silence, orElse: () => Effect.fail(silent()) })
  )
  const opened = yield* Effect.fromOption(
    first,
    () => new ProviderUnavailable({ reason: "Closed", cause: "FastCast closed before connecting" })
  )
  const sid = yield* Option.match(decodeEnvelope(opened), {
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

  const current = yield* Ref.make<Wanted>(HashMap.empty())
  const pending = yield* FiberMap.make<Topic>()
  const subscribeTo = (topic: Topic) =>
    Queue.offer(outgoing, JSON.stringify({ op: "S", sid, tc: tcOf(topic) }))
  const subscribeNow = (topic: Topic) =>
    FiberMap.remove(pending, topic).pipe(Effect.andThen(subscribeTo(topic)))
  const resubscribeLater = (topic: Topic) =>
    FiberMap.run(
      pending,
      topic,
      Effect.sleep(refollow).pipe(
        Effect.andThen(Ref.get(current)),
        Effect.flatMap((wantedNow) => (HashMap.has(wantedNow, topic) ? subscribeTo(topic) : Effect.void))
      ),
      { onlyIfMissing: true }
    )

  yield* Effect.logInfo(`FastCast: connected to ${host.ip}`)

  // From nothing on this socket to what is wanted, then each change after.
  yield* wanted.pipe(
    Stream.runForEach((next) =>
      Ref.getAndSet(current, next).pipe(
        Effect.flatMap((previous) =>
          Effect.forEach(toSubscribe(previous, next), subscribeNow, { discard: true })
        )
      )
    ),
    Effect.forkScoped
  )

  // Up to four at once, so a reconnect's checkpoints load side by side; frames still leave in the texts' order.
  return Stream.concat(Stream.make(opened), rest).pipe(
    Stream.mapEffect((text) => framed(text, resubscribeLater), { concurrency: 4 }),
    Stream.flattenIterable
  )
})

/**
 * The topics to subscribe to as what is wanted goes from `previous` to `next`: each newly wanted, and each whose
 * document went from synced back to waiting for its checkpoint.
 */
function toSubscribe(previous: Wanted, next: Wanted): ReadonlyArray<Topic> {
  return [...HashMap.entries(next)].flatMap(([topic, document]) => {
    const had = HashMap.get(previous, topic)
    return Option.isNone(had) || (document === "AwaitingCheckpoint" && had.value === "Synced") ? [topic] : []
  })
}

/**
 * A socket text as its frame, an `H`'s followed by its checkpoint once it loads and decodes. An `H` whose topic has
 * no name FastCast reads loads nothing. A checkpoint that fails is logged, its topic is given to `resubscribeLater`,
 * and only its `H` is framed.
 */
const framed = Effect.fnUntraced(function* (
  text: string,
  resubscribeLater: (topic: Topic) => Effect.Effect<unknown>
) {
  const envelope = Option.getOrUndefined(decodeEnvelope(text))
  const topic = Option.fromUndefinedOr(envelope?.channel).pipe(Option.flatMap(topicOf))
  const frame = Frame.Pushed({ topic, mid: Option.fromUndefinedOr(envelope?.mid), body: text })
  if (envelope === undefined) {
    yield* Effect.logDebug("FastCast: framed a text of an unknown op", text)
    return [frame]
  }
  const { message } = envelope
  if (message.op !== "H" || Option.isNone(topic)) return [frame]

  const loaded = yield* checkpoint(topic.value, message.pl).pipe(Effect.result)
  if (Result.isSuccess(loaded)) {
    return [frame, Frame.Checkpoint({ topic: topic.value, mid: message.mid, document: loaded.success })]
  }

  const error = loaded.failure
  yield* Effect.logWarning(
    `FastCast: the checkpoint of ${message.tc} at ${message.mid} failed; subscribing to it again later`,
    error.cause
  ).pipe(Effect.annotateLogs({ topic: message.tc, reason: error.reason }))
  yield* resubscribeLater(topic.value)
  return [frame]
})

/** The document of the checkpoint at `url`, decoded as `topic`'s checkpoint. */
function checkpoint(topic: Topic, url: string) {
  const tc = tcOf(topic)
  return HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.timeout(checkpointTimeout),
    Effect.mapError((cause) => new CheckpointUnread({ topic: tc, reason: "Unloaded", cause })),
    Effect.flatMap((body) =>
      Schema.decodeEffect(FastCastMessage.Checkpoint(topic))(body).pipe(
        Effect.mapError((cause) => new CheckpointUnread({ topic: tc, reason: "Undecodable", cause }))
      )
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
