import { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import {
  Array as Arr,
  type Cause,
  Channel,
  Context,
  Data,
  DateTime,
  Effect,
  FiberMap,
  HashMap,
  Layer,
  Metric,
  Option,
  PubSub,
  Queue,
  Record,
  Result,
  Schedule,
  Schema,
  Sink,
  Stream
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { HubConfig } from "../../HubConfig.ts"
import * as HubStopping from "../../HubStopping.ts"
import * as EspnDecoder from "./EspnDecoder.ts"
import * as FastCastDocument from "./FastCastDocument.ts"
import * as FastCastMessage from "./FastCastMessage.ts"
import { ownerOf, topicOf } from "./FastCastTopic.ts"
import { Frame } from "./Frame.ts"
import { ProviderUnavailable } from "./ProviderUnavailable.ts"

/**
 * ESPN FastCast as the ESPN provider's push: one socket that decides what it follows from its own scoreboard topics,
 * reads a topic's checkpoint again when its document resets, and opens again when it closes, ends or goes quiet. Every
 * socket text is a frame, each `H` followed by its checkpoint. A topic whose checkpoint fails is followed again on the
 * checkpoint retry `FastCast.make` is given; `FastCast.layer` gives it `layer`'s own.
 */
export class FastCast extends Context.Service<
  FastCast,
  {
    /**
     * Every socket text and checkpoint, as frames, for as long as it runs. It follows each league's scoreboard topic.
     * It follows a game's topic while that scoreboard shows the game live or within 30 minutes of kickoff, and leaves
     * it at final. When a topic's document resets (a message missed, or one that will not apply), it reads the checkpoint again. When the
     * socket closes, ends or goes silent, it reconnects on its backoff. Never fails.
     */
    readonly frames: Stream.Stream<Frame>
  }
>()("sportal/hub/provider/espn/FastCast") {
  /**
   * FastCast for the leagues `HubConfig` names, following a topic whose checkpoint failed again on `retry.checkpoint`,
   * then leaving it to polling, and opening the socket again on `retry.reconnect` after each failure, which it logs and
   * counts by its reason. Once `retry.reconnect` is done, it logs that the live feed stopped and emits nothing more.
   */
  static readonly make = (retry: {
    readonly checkpoint: Schedule.Schedule<unknown, CheckpointUnread>
    readonly reconnect: Schedule.Schedule<unknown, ProviderUnavailable>
  }) =>
    Effect.gen(function* () {
      const { leagues } = yield* HubConfig
      const context = yield* Effect.context<HttpClient.HttpClient | Socket.WebSocketConstructor>()
      const frames = Stream.unwrap(connect(leagues, retry.checkpoint)).pipe(
        Stream.concat(
          Stream.fail(new ProviderUnavailable({ reason: "Closed", cause: "FastCast ended the stream" }))
        ),
        Stream.timeoutOrElse({ duration: silence, orElse: () => Stream.fail(silent()) }),
        Stream.tapError(failed),
        Stream.retry(retry.reconnect),
        Stream.catchCause(stopped),
        Stream.provideContext(context)
      )
      return FastCast.of({ frames })
    })

  /**
   * FastCast whose checkpoint retry is every 30 s, five tries in all, then the topic is left to polling; it opens the
   * socket again after about 1 second, then twice as long each time, jittered, up to a minute. `Stream.retry` resets
   * that backoff once the socket delivers again.
   */
  static readonly layer: Layer.Layer<
    FastCast,
    never,
    HttpClient.HttpClient | Socket.WebSocketConstructor | HubConfig
  > = Layer.effect(
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

  /** FastCast as a test drives it: `frames`, whatever it would follow. */
  static layerTest(frames: Stream.Stream<Frame>): Layer.Layer<FastCast> {
    return Layer.succeed(FastCast, FastCast.of({ frames }))
  }
}

/** A topic's checkpoint was not read: it could not be loaded (unreachable, refused, timed out) or did not decode. */
export class CheckpointUnread extends Schema.TaggedError<CheckpointUnread>()("CheckpointUnread", {
  topic: Schema.String,
  reason: Schema.Literals(["Unloaded", "Undecodable"]),
  cause: Schema.Defect()
}) {}

/**
 * Opens the socket and follows each league's topic, returning the frames that follow, the handshake's first. What else
 * it follows comes from those frames, as `steered` says. To follow a topic is to subscribe to it and wait for its
 * checkpoint; one that fails is followed again on `retry`, one follow per topic at a time, and once `retry` is done the
 * topic is left to polling until the socket reconnects.
 */
const connect = Effect.fn("FastCast.connect")(function* (
  leagues: ReadonlyArray<LeagueId>,
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
  // A topic left to polling keeps its place in `follows` until the socket reconnects, so nothing follows it before.
  const follow = (tc: string) => {
    const followed = attempt(tc).pipe(
      Effect.retry(retry),
      Effect.catch((error) =>
        Effect.logWarning(
          `FastCast: ${tc} is left to polling until the socket reconnects; its checkpoint kept failing`,
          error
        ).pipe(Effect.annotateLogs({ topic: tc }), Effect.andThen(Effect.never))
      )
    )
    return Effect.asVoid(FiberMap.run(follows, tc, followed, { onlyIfMissing: true }))
  }
  const steerTo = Steer.$match({
    Follow: ({ tc }) => Effect.logInfo(`FastCast: subscribed to ${tc}`).pipe(Effect.andThen(follow(tc))),
    Leave: ({ tc }) =>
      Effect.logInfo(`FastCast: left ${tc}; its scoreboard shows it neither live nor about to kick off`).pipe(
        Effect.andThen(FiberMap.remove(follows, tc))
      ),
    FollowAgain: ({ tc, detail }) =>
      Effect.logWarning(`FastCast: ${tc} lost its document (${detail}); following it again`).pipe(
        Effect.andThen(follow(tc))
      )
  })
  const steer = (one: Steer) =>
    Metric.update(Metric.withAttributes(steersTaken, { steer: one._tag }), 1).pipe(
      Effect.andThen(steerTo(one))
    )

  yield* Effect.forEach(topics, follow, { discard: true })
  yield* Metric.update(connected, 1)
  yield* Effect.addFinalizer(() =>
    Metric.update(connected, 0).pipe(Effect.andThen(Metric.update(topicsFollowed, 0)))
  )
  yield* Metric.update(connects, 1)
  yield* Effect.logInfo(`FastCast: connected to ${host.ip}, subscribed to ${topics.join(", ")}`)

  return Stream.concat(Stream.make(opened), rest).pipe(
    Stream.mapEffect((received) => framed(received, (outcome) => PubSub.publish(outcomes, outcome))),
    Stream.flattenIterable,
    Stream.mapAccumEffect(
      (): Following => ({ documents: FastCastDocument.empty, games: HashMap.empty(), followed: [] }),
      (following, frame) =>
        steered(following, frame, topics).pipe(
          Effect.tap(([next, steers]) =>
            Metric.update(topicsFollowed, next.followed.length).pipe(
              Effect.andThen(Effect.forEach(steers, steer, { discard: true }))
            )
          ),
          Effect.map(([next]) => [next, [frame]] as const)
        )
    )
  )
})

/**
 * What the socket follows, as its own frames say: each topic's document, each league's games as its scoreboard last
 * showed them, and the game topics it follows. Kept only to steer the socket; the Hub decodes the frames on its own.
 */
interface Following {
  readonly documents: typeof FastCastDocument.empty
  readonly games: HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly followed: ReadonlyArray<string>
}

/** One turn of the socket: follow a game's topic, leave it, or follow again a topic whose document reset. */
type Steer = Data.TaggedEnum<{
  Follow: { readonly tc: string }
  Leave: { readonly tc: string }
  FollowAgain: { readonly tc: string; readonly detail: string }
}>
const Steer = Data.taggedEnum<Steer>()

/**
 * What the socket follows after `frame`, and how to steer it there. Each game topic is followed while its scoreboard
 * shows the game live, or upcoming within 30 minutes of kickoff by the time the frame is read, and left once it does
 * not; a followed topic whose document reset is followed again. A scoreboard is read again only when the frame changed
 * it, and one waiting for its checkpoint keeps the games it last showed. A frame that does not decode changes nothing.
 */
const steered = Effect.fnUntraced(function* (
  following: Following,
  frame: Frame,
  scoreboards: ReadonlyArray<string>
) {
  const advanced = yield* FastCastDocument.advance(following.documents, frame).pipe(
    Effect.orElseSucceed(() => FastCastDocument.unchanged(following.documents))
  )
  const shown = Option.flatMap(advanced.change, () =>
    FastCastDocument.scoreboard(advanced.documents, frame.channel)
  )
  const games = yield* Option.match(shown, {
    onNone: () => Effect.succeed(following.games),
    onSome: ({ league, events }) =>
      Effect.map(EspnDecoder.gamesOf(league, events), (shownGames) =>
        HashMap.set(following.games, league, shownGames)
      )
  })
  const now = yield* DateTime.now

  const followed = followedAt(games, now)
  const reset = Option.filter(advanced.change, FastCastDocument.Change.$is("Reset")).pipe(
    Option.filter(({ topic }) => [...scoreboards, ...followed].includes(topic))
  )
  const steers = [
    ...Arr.difference(followed, following.followed).map((tc) => Steer.Follow({ tc })),
    ...Arr.difference(following.followed, followed).map((tc) => Steer.Leave({ tc })),
    ...Option.toArray(reset).map(({ topic, detail }) => Steer.FollowAgain({ tc: topic, detail }))
  ]
  const next: Following = { documents: advanced.documents, games, followed }
  return [next, steers] as const
})

/** The topic of each game live at `now`, or upcoming with its kickoff within `GameSnapshot.kickoffWindow` of it. */
function followedAt(
  games: HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>,
  now: DateTime.Utc
): ReadonlyArray<string> {
  return [...HashMap.values(games)]
    .flat()
    .filter((game) => game.isLiveOrKicksOffWithin(GameSnapshot.kickoffWindow, now))
    .map((game) => topicOf(game.league, game.id))
}

/**
 * A socket text as its frame, an `H`'s followed by its checkpoint once it loads and decodes. Either way the `H`'s
 * outcome is handed to `published`; a checkpoint that fails is logged and counted, and only its `H` is framed. Every text is counted by its op.
 */
const framed = Effect.fnUntraced(function* (
  received: { readonly text: string; readonly receivedAt: DateTime.Utc },
  published: (outcome: Result.Result<string, CheckpointUnread>) => Effect.Effect<boolean>
) {
  const { text, receivedAt } = received
  const envelope = Option.getOrUndefined(decodeEnvelope(text))
  const league = Option.fromUndefinedOr(envelope?.channel).pipe(
    Option.flatMap(ownerOf),
    Option.map((owner) => owner.league)
  )
  const op = envelope?.message.op ?? "unknown"
  yield* Metric.update(Metric.withAttributes(textsReceived, { op, ...Record.getSomes({ league }) }), 1)
  const frame = new Frame({
    receivedAt,
    source: "push",
    channel: envelope?.channel ?? "socket",
    kind: "change",
    body: text,
    number: envelope?.mid
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
  yield* Metric.update(Metric.withAttributes(checkpointFailures, Record.getSomes({ league })), 1)
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
    "Game topics the live feed follows, beside each league's scoreboard; 0 while it is not subscribed"
})

const steersTaken = Metric.counter("sportal_live_feed_steers", {
  description:
    "Times the live feed followed a game topic, left one, or followed one again after its document reset",
  incremental: true
})
