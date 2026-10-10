import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import {
  Array as Arr,
  type Cause,
  Channel,
  Context,
  Data,
  type DateTime,
  type Duration,
  Effect,
  FiberMap,
  HashMap,
  HashSet,
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
import * as HubStopping from "../../HubStopping.ts"
import * as FastCastMessage from "./FastCastMessage.ts"

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
     * backoff and reads `wanted` again. It never fails or ends: once a reconnect that ends is done, or on a defect, it logs
     * at Error (unless the Hub is stopping) that the live feed stopped, and emits nothing more.
     */
    follow(wanted: Stream.Stream<Wanted>): Stream.Stream<Frame>
  }
>()("sportal/hub/provider/espn/FastCast") {
  /**
   * FastCast subscribing again to a topic whose checkpoint failed after 30 s; it opens the socket again after about 1
   * second, then twice as long each time, jittered, up to a minute, without end. `Stream.retry` resets that backoff once
   * the socket delivers again.
   */
  static readonly layer: Layer.Layer<FastCast, never, HttpClient.HttpClient | Socket.WebSocketConstructor> =
    Layer.effect(
      FastCast,
      Effect.gen(function* () {
        const context = yield* Effect.context<HttpClient.HttpClient | Socket.WebSocketConstructor>()
        const reconnect = Schedule.min([
          Schedule.exponential("1 second").pipe(Schedule.jittered),
          Schedule.spaced("1 minute")
        ])
        const follow = (wanted: Stream.Stream<Wanted>) =>
          Stream.unwrap(connect(wanted, "30 seconds")).pipe(
            Stream.concat(
              Stream.fail(new ProviderUnavailable({ reason: "Closed", cause: "FastCast ended the stream" }))
            ),
            Stream.timeoutOrElse({ duration: silence, orElse: () => Stream.fail(silent()) }),
            Stream.tapError((error) =>
              Effect.logWarning(`FastCast: the live feed failed (${error.reason}); subscribing again`, error)
            ),
            Stream.retry(reconnect),
            Stream.catchCause(stopped),
            Stream.provideContext(context)
          )
        return FastCast.of({ follow })
      })
    )

  /** FastCast as a test drives it: the frames `follow` gives for what it is told to follow. */
  static layerTest(follow: (wanted: Stream.Stream<Wanted>) => Stream.Stream<Frame>): Layer.Layer<FastCast> {
    return Layer.succeed(FastCast, FastCast.of({ follow }))
  }
}

/** The topics FastCast follows, each with whether its document is synced or waits for its checkpoint. */
export type Wanted = HashMap.HashMap<Topic, "Synced" | "AwaitingCheckpoint">

/** One thing FastCast delivered, as received, before its decode reads it. */
export type Frame = Data.TaggedEnum<{
  /**
   * A socket text, read once as its envelope: a change to its topic's document, or any other op. No envelope when the
   * text is not JSON with an op; no topic or mid unless it frames as a known op naming them.
   */
  Pushed: {
    readonly topic: Option.Option<Topic>
    readonly mid: Option.Option<number>
    readonly envelope: Option.Option<FastCastMessage.Envelope>
  }
  /** The checkpoint an `H` pointed to, decoded: `topic`'s whole document as of `mid`. */
  Checkpoint: { readonly topic: Topic; readonly mid: number; readonly document: Schema.Json }
}>
export const Frame = Data.taggedEnum<Frame>()

/** A FastCast game topic: one game's package, which carries its plays. */
export class Topic extends Data.Class<{ readonly league: LeagueId; readonly game: GameId }> {
  /** The topic FastCast's `tc` names, when it is a game's. */
  static fromTc(tc: string): Option.Option<Topic> {
    return Arr.findFirst(LeagueId.literals, (league) => {
      const prefix = prefixOf(league)
      return tc.startsWith(prefix) && tc.length > prefix.length
        ? Option.some(new Topic({ league, game: GameId.make(tc.slice(prefix.length)) }))
        : Option.none()
    })
  }

  /**
   * The topic of each of `games` live or kicking off within `GameSnapshot.kickoffWindow` at `now`: those FastCast
   * follows.
   */
  static wantedAt(games: Iterable<GameSnapshot>, now: DateTime.Utc): HashSet.HashSet<Topic> {
    const wanted = [...games].filter((game) => game.isLiveOrKicksOffWithin(GameSnapshot.kickoffWindow, now))
    return HashSet.fromIterable(wanted.map((game) => new Topic({ league: game.league, game: game.id })))
  }

  /** This topic as FastCast's `tc` names it. */
  tc(): string {
    return `${prefixOf(this.league)}${this.game}`
  }
}

/** FastCast could not be followed: it refused, closed, or went silent. `FastCast` logs it and opens the socket again. */
class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()("ProviderUnavailable", {
  reason: Schema.Literals(["Refused", "Closed", "Silent"]),
  cause: Schema.Defect()
}) {}

/** A topic's checkpoint was not read: it could not be loaded (unreachable, refused, timed out) or did not decode. */
class CheckpointUnread extends Schema.TaggedError<CheckpointUnread>()("CheckpointUnread", {
  topic: Schema.String,
  reason: Schema.Literals(["Unloaded", "Undecodable"]),
  cause: Schema.Defect()
}) {}

function prefixOf(league: LeagueId): string {
  return league === "nfl" ? "gp-football-nfl-" : "gp-football-college-football-"
}

/**
 * Opens the socket, then subscribes as `wanted` says, returning the frames that follow, the handshake's first. A topic
 * whose checkpoint fails is subscribed to again once `refollow` has passed, if it is still wanted; one wait per topic,
 * cancelled by a later checkpoint of that topic that succeeds.
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
  const openingEnvelope = decodeEnvelope(opened)
  const opening = Option.flatMap(openingEnvelope, decodeFramed)
  const sid = yield* Option.match(opening, {
    onNone: () =>
      Effect.fail(
        new ProviderUnavailable({ reason: "Refused", cause: "FastCast opened with an unknown op" })
      ),
    onSome: (message) =>
      message.op === "C"
        ? Effect.succeed(message.sid)
        : Effect.fail(
            new ProviderUnavailable({ reason: "Refused", cause: `FastCast opened with ${message.op}` })
          )
  })

  const current = yield* Ref.make<Wanted>(HashMap.empty())
  const pending = yield* FiberMap.make<Topic>()
  const subscribeTo = (topic: Topic) =>
    Queue.offer(outgoing, JSON.stringify({ op: "S", sid, tc: topic.tc() }))
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

  // Up to four at once, so a reconnect's checkpoints load side by side; frames still leave in the texts' order, and each
  // checkpoint's outcome is applied in that order too, so a later success cancels an earlier failure's re-subscribe.
  return Stream.concat(
    Stream.make({ text: opened, envelope: openingEnvelope }),
    rest.pipe(Stream.map((text) => ({ text, envelope: decodeEnvelope(text) })))
  ).pipe(
    Stream.mapEffect(({ text, envelope }) => framed(text, envelope), { concurrency: 4 }),
    Stream.mapEffect((loaded) =>
      Effect.gen(function* () {
        if (Option.isSome(loaded.checkpoint)) {
          const outcome = loaded.checkpoint.value
          if (Option.isNone(outcome.unread)) {
            yield* FiberMap.remove(pending, outcome.topic)
          } else {
            const error = outcome.unread.value
            yield* Effect.logWarning(
              `FastCast: the checkpoint of ${outcome.topic.tc()} failed; subscribing to it again later`,
              error.cause
            ).pipe(Effect.annotateLogs({ topic: outcome.topic.tc(), reason: error.reason }))
            yield* resubscribeLater(outcome.topic)
          }
        }
        return loaded.frames
      })
    ),
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
 * A socket text, read once as `envelope`, as its frame, an `H`'s followed by its checkpoint once it loads and decodes,
 * with that checkpoint's outcome: none unless an `H` names a topic, then whether its checkpoint was unread. An `H` whose
 * topic has no name FastCast reads loads nothing. It subscribes to nothing and logs no failure: its caller applies the
 * outcome in the texts' order.
 */
const framed = Effect.fnUntraced(function* (
  text: string,
  envelope: Option.Option<FastCastMessage.Envelope>
): Effect.fn.Return<
  {
    readonly frames: ReadonlyArray<Frame>
    readonly checkpoint: Option.Option<{
      readonly topic: Topic
      readonly unread: Option.Option<CheckpointUnread>
    }>
  },
  never,
  HttpClient.HttpClient
> {
  const message = Option.getOrUndefined(Option.flatMap(envelope, decodeFramed))
  const topic = message !== undefined && "tc" in message ? Topic.fromTc(message.tc) : Option.none<Topic>()
  const mid = message !== undefined && "mid" in message ? Option.some(message.mid) : Option.none<number>()
  const frame = Frame.Pushed({ topic, mid, envelope })
  if (message === undefined) {
    yield* Effect.logDebug("FastCast: framed a text of an unknown op", text)
    return { frames: [frame], checkpoint: Option.none() }
  }
  if (message.op !== "H" || Option.isNone(topic)) return { frames: [frame], checkpoint: Option.none() }

  const loaded = yield* checkpoint(topic.value, message.pl).pipe(Effect.result)
  if (Result.isSuccess(loaded)) {
    const whole = Frame.Checkpoint({ topic: topic.value, mid: message.mid, document: loaded.success })
    return {
      frames: [frame, whole],
      checkpoint: Option.some({ topic: topic.value, unread: Option.none<CheckpointUnread>() })
    }
  }
  return {
    frames: [frame],
    checkpoint: Option.some({ topic: topic.value, unread: Option.some(loaded.failure) })
  }
})

/** The document of the checkpoint at `url`, decoded as `topic`'s checkpoint. */
function checkpoint(topic: Topic, url: string) {
  const tc = topic.tc()
  return HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.timeout(checkpointTimeout),
    Effect.mapError((cause) => new CheckpointUnread({ topic: tc, reason: "Unloaded", cause })),
    Effect.flatMap((body) =>
      Schema.decodeEffect(FastCastMessage.Checkpoint)(body).pipe(
        Effect.mapError((cause) => new CheckpointUnread({ topic: tc, reason: "Undecodable", cause }))
      )
    )
  )
}

// Well inside `silence`, so a checkpoint that hangs fails its topic rather than the whole socket.
const checkpointTimeout = "20 seconds"

const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(FastCastMessage.Envelope))

const decodeFramed = Schema.decodeUnknownOption(FastCastMessage.Framed)

// FastCast sends `B` itself after 10 s without another frame (it answers a client's `B` with an error, so the client
// never sends one); live, a subscribed socket went at most 20 s between frames.
const silence = "45 seconds"

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

function silent(): ProviderUnavailable {
  return new ProviderUnavailable({ reason: "Silent", cause: `No FastCast message for ${silence}` })
}

const websocketHost = HttpClient.get("https://fastcast.semfs.engsvc.go.com/public/websockethost").pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.flatMap(HttpClientResponse.schemaBodyJson(FastCastMessage.Host)),
  Effect.mapError((cause) => new ProviderUnavailable({ reason: "Refused", cause }))
)
