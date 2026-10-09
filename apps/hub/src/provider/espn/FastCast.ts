import {
  type Cause,
  Channel,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  FiberMap,
  HashMap,
  HashSet,
  Layer,
  Metric,
  Option,
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
import * as HubStopping from "../../HubStopping.ts"
import * as FastCastMessage from "./FastCastMessage.ts"
import { Frame } from "./Frame.ts"
import { ProviderUnavailable } from "./ProviderUnavailable.ts"
import { Topic, tcOf, topicOf } from "./Topic.ts"

/**
 * ESPN FastCast as the ESPN provider's push: one socket that follows the topics it is told to, reads a topic's
 * checkpoint again when told its document was lost, and opens again when it closes, ends or goes quiet. Every socket text
 * is a frame, each `H` followed by its checkpoint. A topic whose checkpoint fails is followed again on the checkpoint
 * retry `FastCast.make` is given; `FastCast.layer` gives it `layer`'s own.
 */
export class FastCast extends Context.Service<
  FastCast,
  {
    /**
     * Every socket text and checkpoint, as frames, for as long as it runs, following what `wanted` last said. On each
     * socket it follows every wanted topic, then each topic that becomes wanted, and each whose document goes from synced
     * back to waiting for its checkpoint; it leaves each topic no longer wanted. When the socket closes, ends or goes
     * silent, it reconnects on its backoff and reads `wanted` again. Never fails.
     */
    follow(wanted: Stream.Stream<Wanted>): Stream.Stream<Frame>
  }
>()("sportal/hub/provider/espn/FastCast") {
  /**
   * FastCast following a topic whose checkpoint failed again on `retry.checkpoint`, then leaving it to polling until the
   * socket reconnects, and opening the socket again on `retry.reconnect` after each failure, which it logs and counts by
   * its reason. Once `retry.reconnect` is done, it logs that the live feed stopped and emits nothing more.
   */
  static readonly make = (retry: {
    readonly checkpoint: Schedule.Schedule<unknown, CheckpointUnread>
    readonly reconnect: Schedule.Schedule<unknown, ProviderUnavailable>
  }) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<HttpClient.HttpClient | Socket.WebSocketConstructor>()
      const follow = (wanted: Stream.Stream<Wanted>) =>
        Stream.unwrap(connect(wanted, retry.checkpoint)).pipe(
          Stream.concat(
            Stream.fail(new ProviderUnavailable({ reason: "Closed", cause: "FastCast ended the stream" }))
          ),
          Stream.timeoutOrElse({ duration: silence, orElse: () => Stream.fail(silent()) }),
          Stream.tapError(failed),
          Stream.retry(retry.reconnect),
          Stream.catchCause(stopped),
          Stream.provideContext(context)
        )
      return FastCast.of({ follow })
    })

  /**
   * FastCast whose checkpoint retry is every 30 s, five tries in all, then the topic is left to polling; it opens the
   * socket again after about 1 second, then twice as long each time, jittered, up to a minute. `Stream.retry` resets
   * that backoff once the socket delivers again.
   */
  static readonly layer: Layer.Layer<FastCast, never, HttpClient.HttpClient | Socket.WebSocketConstructor> =
    Layer.effect(
      FastCast,
      FastCast.make({
        checkpoint: Schedule.spaced("30 seconds").pipe(
          Schedule.setInputType<CheckpointUnread>(),
          Schedule.upTo({ times: 4 })
        ),
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
export class CheckpointUnread extends Schema.TaggedError<CheckpointUnread>()("CheckpointUnread", {
  topic: Schema.String,
  reason: Schema.Literals(["Unloaded", "Undecodable"]),
  cause: Schema.Defect()
}) {}

/**
 * Opens the socket, then follows what `wanted` says, returning the frames that follow, the handshake's first. To follow
 * a topic is to subscribe to it and wait for its checkpoint; one that fails is followed again on `retry`, one follow per
 * topic at a time, and once `retry` is done the topic is left to polling until the socket reconnects.
 */
const connect = Effect.fn("FastCast.connect")(function* (
  wanted: Stream.Stream<Wanted>,
  retry: Schedule.Schedule<unknown, CheckpointUnread>
) {
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

  // Each follow waiting on its topic's checkpoint, by topic; the `H` that answers it completes it.
  const pending = yield* Ref.make(HashMap.empty<Topic, Deferred.Deferred<void, CheckpointUnread>>())
  // The topics left to polling on this socket: nothing follows them until it reconnects.
  const gaveUp = yield* Ref.make(HashSet.empty<Topic>())
  const follows = yield* FiberMap.make<Topic>()

  const attempt = Effect.fnUntraced(function* (topic: Topic) {
    const answered = yield* Deferred.make<void, CheckpointUnread>()
    yield* Ref.update(pending, HashMap.set(topic, answered))
    yield* Queue.offer(outgoing, JSON.stringify({ op: "S", sid, tc: tcOf(topic) }))
    yield* Deferred.await(answered)
  })
  const answer = Effect.fnUntraced(function* (topic: Topic, outcome: Exit.Exit<void, CheckpointUnread>) {
    const waiting = yield* Ref.modify(pending, (all) => [HashMap.get(all, topic), HashMap.remove(all, topic)])
    yield* Effect.forEach(Option.toArray(waiting), (answered) => Deferred.done(answered, outcome), {
      discard: true
    })
  })
  const follow = Effect.fnUntraced(function* (topic: Topic) {
    const leftToPolling = yield* Ref.get(gaveUp)
    if (HashSet.has(leftToPolling, topic)) return

    const followed = attempt(topic).pipe(
      Effect.retry(retry),
      Effect.catch((error) =>
        Effect.logWarning(
          `FastCast: ${tcOf(topic)} is left to polling until the socket reconnects; its checkpoint kept failing`,
          error
        ).pipe(
          Effect.annotateLogs({ topic: tcOf(topic) }),
          Effect.andThen(Ref.update(gaveUp, HashSet.add(topic)))
        )
      )
    )
    yield* FiberMap.run(follows, topic, followed, { onlyIfMissing: true })
  })
  const steerTo = Steer.$match({
    Follow: ({ topic }) =>
      Effect.logInfo(`FastCast: subscribed to ${tcOf(topic)}`).pipe(Effect.andThen(follow(topic))),
    Leave: ({ topic }) =>
      Effect.logInfo(`FastCast: left ${tcOf(topic)}; it is no longer wanted`).pipe(
        Effect.andThen(FiberMap.remove(follows, topic))
      ),
    FollowAgain: ({ topic }) =>
      Effect.logInfo(`FastCast: following ${tcOf(topic)} again from its checkpoint`).pipe(
        Effect.andThen(follow(topic))
      )
  })
  const steer = (one: Steer) =>
    Metric.update(Metric.withAttributes(steersTaken, { steer: one._tag }), 1).pipe(
      Effect.andThen(steerTo(one))
    )

  yield* Metric.update(connected, 1)
  yield* Effect.addFinalizer(() =>
    Metric.update(connected, 0).pipe(Effect.andThen(Metric.update(topicsFollowed, 0)))
  )
  yield* Metric.update(connects, 1)
  yield* Effect.logInfo(`FastCast: connected to ${host.ip}`)

  // From nothing on this socket to what is wanted, then each change after.
  yield* wanted.pipe(
    Stream.mapAccum(
      (): Wanted => HashMap.empty(),
      (previous, next) => [next, [{ next, steers: steersBetween(previous, next) }]] as const
    ),
    Stream.runForEach(({ next, steers }) =>
      Metric.update(topicsFollowed, [...HashMap.keys(next)].filter(Topic.$is("Game")).length).pipe(
        Effect.andThen(Effect.forEach(steers, steer, { discard: true }))
      )
    ),
    Effect.forkScoped
  )

  return Stream.concat(Stream.make(opened), rest).pipe(
    Stream.mapEffect((text) => framed(text, answer)),
    Stream.flattenIterable
  )
})

/** One turn of the socket: follow a topic, leave it, or follow again a topic whose document was lost. */
type Steer = Data.TaggedEnum<{
  Follow: { readonly topic: Topic }
  Leave: { readonly topic: Topic }
  FollowAgain: { readonly topic: Topic }
}>
const Steer = Data.taggedEnum<Steer>()

/**
 * How to steer the socket from following `previous` to `next`: follow each topic newly wanted, leave each no longer
 * wanted, and follow again each whose document went from synced back to waiting for its checkpoint.
 */
function steersBetween(previous: Wanted, next: Wanted): ReadonlyArray<Steer> {
  const followed = [...HashMap.keys(next)]
    .filter((topic) => !HashMap.has(previous, topic))
    .map((topic) => Steer.Follow({ topic }))
  const left = [...HashMap.keys(previous)]
    .filter((topic) => !HashMap.has(next, topic))
    .map((topic) => Steer.Leave({ topic }))
  const lost = [...HashMap.entries(next)]
    .filter(
      ([topic, document]) =>
        document === "AwaitingCheckpoint" &&
        Option.exists(HashMap.get(previous, topic), (had) => had === "Synced")
    )
    .map(([topic]) => Steer.FollowAgain({ topic }))
  return [...followed, ...left, ...lost]
}

/**
 * A socket text as its frame, an `H`'s followed by its checkpoint once it loads and decodes. An `H` whose topic has
 * no name FastCast reads loads nothing. Every text is counted by its op. Either way the `H`'s outcome answers the
 * follow waiting on its topic, if any; a checkpoint that fails is logged and counted, and only its `H` is framed.
 */
const framed = Effect.fnUntraced(function* (
  text: string,
  answer: (topic: Topic, outcome: Exit.Exit<void, CheckpointUnread>) => Effect.Effect<void>
) {
  const envelope = Option.getOrUndefined(decodeEnvelope(text))
  const topic = Option.fromUndefinedOr(envelope?.channel).pipe(Option.flatMap(topicOf))
  const league = Option.map(topic, (on) => on.league)
  const op = envelope?.message.op ?? "unknown"
  yield* Metric.update(Metric.withAttributes(textsReceived, { op, ...Record.getSomes({ league }) }), 1)
  const frame = Frame.Pushed({ topic, mid: Option.fromUndefinedOr(envelope?.mid), body: text })
  if (envelope === undefined) {
    yield* Effect.logDebug("FastCast: framed a text of an unknown op", text)
    return [frame]
  }
  const { message } = envelope
  if (message.op !== "H" || Option.isNone(topic)) return [frame]

  const loaded = yield* checkpoint(topic.value, message.pl).pipe(Effect.result)
  if (Result.isSuccess(loaded)) {
    yield* answer(topic.value, Exit.void)
    return [frame, Frame.Checkpoint({ topic: topic.value, mid: message.mid, body: loaded.success })]
  }

  const error = loaded.failure
  yield* Effect.logWarning(
    `FastCast: the checkpoint of ${message.tc} at ${message.mid} failed`,
    error.cause
  ).pipe(Effect.annotateLogs({ topic: message.tc, reason: error.reason }))
  yield* Metric.update(Metric.withAttributes(checkpointFailures, Record.getSomes({ league })), 1)
  yield* answer(topic.value, Exit.fail(error))
  return [frame]
})

/** The body of the checkpoint at `url`, as served, once it decodes as `topic`'s checkpoint. */
function checkpoint(topic: Topic, url: string) {
  const tc = tcOf(topic)
  return HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.timeout(checkpointTimeout),
    Effect.mapError((cause) => new CheckpointUnread({ topic: tc, reason: "Unloaded", cause })),
    Effect.tap((body) =>
      Schema.decodeEffect(FastCastMessage.Checkpoint(topic))(body).pipe(
        Effect.mapError((cause) => new CheckpointUnread({ topic: tc, reason: "Undecodable", cause }))
      )
    ),
    Effect.trackDuration(checkpointDuration)
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

/** A failure of the live feed, logged and counted by its reason. */
const failed = Effect.fnUntraced(function* (error: ProviderUnavailable) {
  yield* Effect.logWarning(`FastCast: the live feed failed (${error.reason}); subscribing again`, error)
  yield* Metric.update(Metric.withAttributes(liveFeedErrors, { reason: error.reason }), 1)
})

/** The end of the live feed, logged unless the Hub is stopping; nothing follows it, so `frames` never ends. */
function stopped(cause: Cause.Cause<ProviderUnavailable>): Stream.Stream<never> {
  const logged = Effect.failCause(cause).pipe(
    HubStopping.loggedUnlessStopping(
      "FastCast: the live feed stopped; only the poll reaches the slate until the Hub restarts",
      "the feed's stream ended"
    ),
    Effect.catchCause(() => Effect.never)
  )
  return Stream.fromEffectDrain(logged)
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

const liveFeedErrors = Metric.counter("sportal_live_feed_errors", {
  description: "Times the live feed failed and was subscribed to again, by why it failed",
  incremental: true
})

const textsReceived = Metric.counter("sportal_live_feed_received", {
  description:
    "FastCast socket texts, by op (unknown when it does not decode) and, when its topic has one, league",
  incremental: true
})

const topicsFollowed = Metric.gauge("sportal_live_feed_topics", {
  description:
    "Game topics the live feed is told to follow, beside each league's scoreboard; 0 while it is not subscribed"
})

const steersTaken = Metric.counter("sportal_live_feed_steers", {
  description:
    "Times the live feed followed a topic, left one, or followed one again after its document was lost",
  incremental: true
})

const checkpointDuration = Metric.timer("sportal_checkpoint_duration", {
  description: "How long a FastCast checkpoint took to load and decode, whether or not it succeeded"
})
