import type { LeagueId } from "@sportal/domain/League"
import { LiveGame } from "@sportal/domain/LiveGame"
import {
  Array as Arr,
  Cause,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Equivalence,
  Exit,
  Fiber,
  Layer,
  Metric,
  Option,
  PubSub,
  Pull,
  Queue,
  Ref,
  Result,
  Schedule,
  Stream
} from "effect"
import { FeedLog } from "../feed/FeedLog.ts"
import { LiveGames } from "../LiveGames.ts"
import { LiveFeed } from "../provider/LiveFeed.ts"
import { Provider } from "../provider/Provider.ts"
import * as Cadence from "./Cadence.ts"

/**
 * Replays the current game day from the feed log into the live games, then polls each league at the Cadence and runs
 * the live feed, appending every frame to the log and taking what each says. The layer is built once the replay is
 * done, so nothing is served from a fold that is still catching up.
 */
export class Ingest extends Context.Service<Ingest, object>()("sportal/hub/Ingest") {
  static readonly layer = (leagues: ReadonlyArray<LeagueId>) =>
    Layer.effect(
      Ingest,
      Effect.gen(function* () {
        const provider = yield* Provider
        const liveFeed = yield* LiveFeed
        const feedLog = yield* FeedLog
        const liveGames = yield* LiveGames
        const from = dayStart(DateTime.setZone(yield* DateTime.now, DateTime.zoneMakeLocal()))

        const replayed = yield* Queue.unbounded<Replayed, Cause.Done>()
        const phase = yield* Ref.make<Phase>(Phase.Replaying({ deliveries: replayed }))
        const frames = yield* Ref.make(0)
        const resyncs = yield* PubSub.unbounded<string>()

        // Decoding pulls the next frame only once it has handed on what the last one said, so when it reaches the end
        // of the replayed frames every delivery they gave has gone to the replay.
        const endReplay = Ref.getAndSet(phase, Phase.Following()).pipe(
          Effect.flatMap((was) =>
            Phase.$match(was, {
              Replaying: ({ deliveries }) => Queue.end(deliveries),
              Following: () => Effect.void
            })
          )
        )
        const route = (said: Stream.Success<ReturnType<Provider["Service"]["decode"]>>) =>
          Effect.flatMap(Ref.get(phase), (current) =>
            Phase.$match(current, {
              // No socket follows a topic yet; once one does, it starts the topic from a fresh checkpoint anyway.
              Replaying: ({ deliveries }) =>
                said._tag === "Delivered" ? Queue.offer(deliveries, said) : Effect.void,
              Following: () =>
                said._tag === "Delivered"
                  ? liveGames.take(said.delivery, said.at, Option.some(said.seq))
                  : PubSub.publish(resyncs, said.channel)
            })
          )

        // One decode over the day's log and then every frame appended after it, so each topic's document carries over
        // from replay to live. Nothing is appended until the replay is over: the feeds start below, after it. Ending
        // the replay wakes this layer, but the decoding fiber goes straight on to subscribe to `frames`, and it is
        // scheduled ahead of the feeds' fibers, which are not forked yet; so it never misses their first frame.
        const decoding = yield* provider
          .decode(
            feedLog.replay(from).pipe(
              Stream.tap(() => Ref.update(frames, (count) => count + 1)),
              Stream.concat(Stream.fromEffect(endReplay).pipe(Stream.drain)),
              Stream.concat(feedLog.frames)
            )
          )
          .pipe(
            Stream.runForEach(route),
            Effect.onExitIf(
              (exit) => !stopping(exit),
              (exit) =>
                Effect.logError(
                  "Ingest: frames are no longer taken into the fold until the Hub restarts",
                  Exit.isFailure(exit) ? exit.cause : "the log's stream ended"
                )
            ),
            Effect.forkScoped
          )

        const replay = Effect.fn("Ingest.replay")(function* () {
          const deliveries = yield* Ref.make(0)
          yield* liveGames.replay(
            Stream.fromQueue(replayed).pipe(Stream.tap(() => Ref.update(deliveries, (count) => count + 1)))
          )
          yield* Effect.annotateCurrentSpan({
            "sportal.frames": yield* Ref.get(frames),
            "sportal.deliveries": yield* Ref.get(deliveries)
          })
        })
        // Decoding that dies during the replay fails the layer, rather than leaving the replay waiting.
        yield* Effect.raceFirst(replay(), Fiber.join(decoding))

        const poll = Effect.fn("Ingest.poll")(function* () {
          const results = yield* Effect.forEach(leagues, (league) =>
            provider.poll(league).pipe(
              Effect.flatMap(feedLog.append),
              Effect.tapError((error) =>
                Effect.logWarning(
                  "Ingest: provider failed; keeping the last good listing for this league, if any",
                  error
                ).pipe(Effect.andThen(Metric.update(Metric.withAttributes(providerErrors, { league }), 1)))
              ),
              Effect.result
            )
          )
          const failed = results.filter(Result.isFailure).map((result) => result.failure.league)
          yield* Effect.annotateCurrentSpan({ "sportal.leagues": leagues, "sportal.failed_leagues": failed })
          return {
            failed,
            last: Arr.last(results.filter(Result.isSuccess).map((result) => result.success.seq))
          }
        }, Effect.trackDuration(pollDuration))

        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const { failed, last } = yield* poll()
              yield* Option.match(last, { onNone: () => Effect.void, onSome: (seq) => taken(liveGames, seq) })
              const folded = yield* liveGames.latest
              const slate = leagues.flatMap((league) =>
                LiveGame.asFolded(folded.listed.get(league) ?? [], folded.live)
              )
              yield* Effect.sleep(Cadence.interval(slate, yield* DateTime.now, failed.length > 0))
            })
          )
        )

        // The current games' snapshots, again on each change to which games they are. Each subscriber gets the
        // current ones first, so a reconnecting live feed subscribes to them all again.
        const wanted = liveGames.changes.pipe(
          Stream.mapEffect((folded) =>
            Effect.map(DateTime.now, (now) =>
              [...folded.live.values()]
                .filter((liveGame) => liveGame.isCurrent(now))
                .map((liveGame) => liveGame.snapshot)
            )
          ),
          Stream.changesWith((self, that) =>
            sameIds(
              self.map((game) => game.id),
              that.map((game) => game.id)
            )
          )
        )

        yield* Effect.forkScoped(
          liveFeed.frames(leagues, wanted, Stream.fromPubSub(resyncs)).pipe(
            Stream.tapError((error) =>
              Effect.logWarning(
                `Ingest: the live feed failed (${error.reason}); subscribing again`,
                error
              ).pipe(
                Effect.andThen(
                  Metric.update(Metric.withAttributes(liveFeedErrors, { reason: error.reason }), 1)
                )
              )
            ),
            Stream.retry(reconnect),
            Stream.runForEach(feedLog.append),
            // Every failure is retried, so the feed ends only by completing or by a defect, and nothing pushes again.
            Effect.onExitIf(
              (exit) => !stopping(exit),
              (exit) =>
                Effect.logError(
                  "Ingest: the live feed stopped; only the poll reaches the fold until the Hub restarts",
                  Exit.isFailure(exit) ? exit.cause : "the feed's stream ended"
                )
            )
          )
        )

        return Ingest.of({})
      })
    )
}

/** The start of the game day `now` is in: 04:00 in its zone, or the day before's when it is earlier than that. */
export function dayStart(now: DateTime.Zoned): DateTime.Utc {
  const today = DateTime.setParts(now, { hour: 4, minute: 0, second: 0, millisecond: 0 })
  return DateTime.toUtc(DateTime.isLessThan(now, today) ? DateTime.subtract(today, { days: 1 }) : today)
}

/**
 * Whether `exit` is the Hub stopping: an interruption, or the end a stream over a `PubSub` (the log's frames, the
 * fold's changes) fails with when its subscription is shut down as the Hub's scope closes.
 */
function stopping(exit: Exit.Exit<unknown, unknown>): boolean {
  return Exit.isFailure(exit) && (Cause.hasInterruptsOnly(exit.cause) || Pull.isDoneCause(exit.cause))
}

/** A delivery decoded from a replayed frame, on its way to the fold's replay. */
type Replayed = Extract<
  Stream.Success<ReturnType<Provider["Service"]["decode"]>>,
  { readonly _tag: "Delivered" }
>

/** Where decoded frames go: through `deliveries` to the fold's replay until the replay ends, then to `take`. */
type Phase = Data.TaggedEnum<{
  Replaying: { readonly deliveries: Queue.Queue<Replayed, Cause.Done> }
  Following: object
}>
const Phase = Data.taggedEnum<Phase>()

/**
 * Waits for the fold to have taken frame `seq`, so the Cadence reads the listing it gave. A frame that gives no
 * delivery (one that does not decode) moves no `seq`, so the wait ends after `takenWithin` regardless.
 */
function taken(liveGames: LiveGames["Service"], seq: number): Effect.Effect<void> {
  return liveGames.changes.pipe(
    Stream.filter((folded) => Option.exists(folded.seq, (at) => at >= seq)),
    Stream.take(1),
    Stream.runDrain,
    Effect.timeoutOption(takenWithin),
    Effect.asVoid
  )
}

const takenWithin = Duration.seconds(5)

const sameIds = Arr.makeEquivalence(Equivalence.String)

const pollDuration = Metric.timer("sportal_poll_duration", {
  description: "How long one poll of every league takes"
})

const providerErrors = Metric.counter("sportal_provider_errors", {
  description: "Polls in which a league's provider failed",
  incremental: true
})

const liveFeedErrors = Metric.counter("sportal_live_feed_errors", {
  description: "Times the live feed failed and was subscribed to again, by why it failed",
  incremental: true
})

// Backoff from 1 s, each delay jittered and capped at a minute; Stream.retry resets it once the feed delivers again.
const reconnect = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.minutes(1))))
)
