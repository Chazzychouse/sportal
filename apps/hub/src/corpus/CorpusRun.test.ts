import { assert, describe, it } from "@effect/vitest"
import { type GameEvent, GameEventKind } from "@sportal/domain/GameEvent"
import { LiveGame } from "@sportal/domain/LiveGame"
import { liveSnapshot, team } from "@sportal/domain/TestGame"
import { Array as Arr, DateTime, Effect, Equal, Fiber, Layer, Option, Ref, Schedule, Stream } from "effect"
import { TestClock } from "effect/testing"
import { FeedLog } from "../FeedLog.ts"
import type { FeedFrame } from "../Frame.ts"
import * as Ingest from "../Ingest.ts"
import * as EspnDecode from "../provider/espn/EspnDecode.ts"
import { fixtures, neAtBufFrames } from "../provider/espn/TestEspn.ts"
import { Slate } from "../Slate.ts"
import * as ScenarioProvider from "../scenario/ScenarioProvider.ts"
import { Scenarios } from "../scenario/Scenarios.ts"
import { withEnv } from "../TestHubConfig.ts"
import * as TestSnapshotFeed from "../TestSnapshotFeed.ts"
import { CorpusDay, CorpusDays } from "./CorpusDay.ts"
import { CorpusInput, CorpusLine } from "./CorpusInput.ts"
import * as CorpusRun from "./CorpusRun.ts"
import { built, inCorpus, local, logged, recorded } from "./TestCorpus.ts"

// As Slate.replay.test.ts measured it: every play id the recording's patches add.
const recordedPlays = 182

describe("CorpusRun.day", () => {
  it.effect(
    "runs the recorded NE at BUF day to the same events twice, every play played once",
    () =>
      inCorpus(EspnDecode.layer, () =>
        Effect.gen(function* () {
          yield* logged(yield* recorded)
          yield* built("2026-10-04")
          const first = yield* CorpusRun.day("2026-10-04", CorpusRun.events)
          const second = yield* CorpusRun.day("2026-10-04", CorpusRun.events)
          assert.strictEqual(first.filter(({ what }) => what._tag === "Played").length, recordedPlays)
          assert.isTrue(Equal.equals(first, second))
        })
      ),
    { timeout: 60_000 }
  )

  it.effect(
    "gives the events the Hub's slate published live, the day played through Ingest on the test clock",
    () =>
      inCorpus(EspnDecode.layer, () =>
        Effect.gen(function* () {
          const frames = yield* recorded
          const live = yield* playedLive(frames, (yield* CorpusDay.bounds("2026-10-04")).until)
          yield* built("2026-10-04")
          const run = yield* CorpusRun.day("2026-10-04", CorpusRun.events)

          assert.strictEqual(live.filter(({ what }) => what._tag === "Played").length, recordedPlays)
          const told = (event: GameEvent | undefined) =>
            event === undefined
              ? "none"
              : `${event.game} ${event.what._tag} at ${DateTime.formatIso(event.at)}`
          const parted = live.findIndex((event, index) => !Equal.equals(event, run[index]))
          assert.strictEqual(
            parted,
            -1,
            `live and run part at event ${parted}: live ${told(live[parted])}, run ${told(run[parted])}`
          )
          assert.isTrue(Equal.equals(live, run), `${live.length} events live, ${run.length} run`)
        })
      ),
    { timeout: 120_000 }
  )

  it.effect("a hold with nothing after it falls back at its deadline, in the day's last tick", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const pushedAt = local("2026-10-04T13:00:00")
        const polledAt = local("2026-10-04T13:00:05")
        const scored = (score: number) => liveSnapshot({ home: { team: team("HOME"), score } })
        yield* (yield* CorpusDays).write(
          new CorpusDay({
            date: "2026-10-04",
            kind: "captured",
            format: CorpusLine.format,
            leagues: ["fbs"],
            games: 1,
            built: polledAt
          }),
          {
            push: Stream.make(
              new CorpusLine({
                seq: 1,
                at: pushedAt,
                input: CorpusInput.cases.Snapshot.make({ snapshot: scored(7) })
              })
            ),
            poll: Stream.make(
              new CorpusLine({
                seq: 2,
                at: polledAt,
                input: CorpusInput.cases.ListingChanged.make({ league: "fbs", games: [scored(14)] })
              })
            )
          }
        )
        const events = yield* CorpusRun.day("2026-10-04", CorpusRun.events)
        const last = Arr.last(events)
        assert.isTrue(Option.exists(last, ({ what }) => GameEventKind.$is("ScoreChanged")(what)))
        assert.deepStrictEqual(
          Option.map(last, ({ at }) => at),
          Option.some(DateTime.addDuration(polledAt, LiveGame.fallbackAfter))
        )
      })
    )
  )

  it.effect("a day that is not there is CorpusDayUnreadable, Missing", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const error = yield* CorpusRun.day("2026-10-04", CorpusRun.events).pipe(Effect.flip)
        assert.deepStrictEqual(
          [error._tag, error.date, error.reason],
          ["CorpusDayUnreadable", "2026-10-04", "Missing"]
        )
      })
    )
  )
})

/**
 * The game events the Hub's slate publishes while Ingest plays `frames` as the recorded scenario, live on the test
 * clock from the first frame, onto a feed log on the provided database: until `LiveGame.fallbackAfter` past the last
 * frame, then, Ingest stopped, until `until`. The clock moves only once the slate has taken every frame appended so
 * far, and stops at each frame's instant and each poll's, so the timer never ticks past a frame still to be taken.
 */
function playedLive(frames: ReadonlyArray<FeedFrame>, until: DateTime.Utc) {
  const instants = frames.map(({ receivedAt }) => receivedAt)
  const first = Option.getOrElse(Arr.head(instants), () => until)
  const ended = Option.match(Arr.last(instants), {
    onNone: () => until,
    onSome: (last) => DateTime.addDuration(last, LiveGame.fallbackAfter)
  })
  const playing = Effect.gen(function* () {
    const slate = yield* Slate
    const seen = yield* Ref.make<ReadonlyArray<GameEvent>>([])
    const subscriber = yield* slate.events.pipe(
      Stream.runForEach((published) => Ref.update(seen, (all) => [...all, published])),
      Effect.forkChild({ startImmediately: true })
    )
    const appended = yield* Ref.make({ seq: 0, polled: first })

    // Until no fiber woken at this instant appends anything the slate has not taken.
    const settled: Effect.Effect<void> = Effect.gen(function* () {
      yield* TestClock.adjust(0)
      const { seq } = yield* Ref.get(appended)
      if (seq > 0) yield* slate.through(seq)
      yield* TestClock.adjust(0)
      if ((yield* Ref.get(appended)).seq !== seq) yield* settled
    })
    // ScenarioProvider pushes each frame at its instant and polls at a poll's instant or 10 s after the last.
    const steppedTo = (to: DateTime.Utc): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* settled
        const now = yield* DateTime.now
        if (DateTime.isGreaterThanOrEqualTo(now, to)) return
        const { polled } = yield* Ref.get(appended)
        const next = [
          ...Option.toArray(Arr.findFirst(instants, (instant) => DateTime.isGreaterThan(instant, now))),
          DateTime.add(polled, { seconds: 10 }),
          to
        ].reduce((a, b) => DateTime.min(a, b))
        yield* TestClock.setTime(DateTime.toEpochMillis(next))
        yield* steppedTo(to)
      })

    yield* steppedTo(ended).pipe(Effect.provide(ingesting(appended)), Effect.scoped)
    yield* TestClock.setTime(DateTime.toEpochMillis(until))
    yield* slate.latest.pipe(
      Effect.repeat({
        until: (latest) =>
          Option.match(latest.earliestDue(), {
            onNone: () => true,
            onSome: (due) => DateTime.isGreaterThan(due, until)
          }),
        schedule: Schedule.spaced("1 millis")
      }),
      TestClock.withLive
    )
    yield* TestClock.adjust(0)
    yield* Fiber.interrupt(subscriber)
    return yield* Ref.get(seen)
  }).pipe(Effect.provide(Slate.layer.pipe(Layer.provideMerge(FeedLog.layer))), Effect.scoped)
  // Set before the feed log opens, so its writer never wakes through the years before the first frame.
  return TestClock.setTime(DateTime.toEpochMillis(first)).pipe(Effect.andThen(playing))
}

/**
 * Ingest playing the recorded NE at BUF scenario, NFL only, onto the provided feed log, keeping the last `seq` it
 * appended and when it last polled in `appended`.
 */
function ingesting(appended: Ref.Ref<{ readonly seq: number; readonly polled: DateTime.Utc }>) {
  const tracked = Layer.effect(
    FeedLog,
    Effect.map(FeedLog, (log) =>
      FeedLog.of({
        ...log,
        append: (frame) =>
          log.append(frame).pipe(
            Effect.tap((logged) =>
              Ref.update(appended, ({ polled }) => ({
                seq: logged.seq,
                polled: logged.feed === "poll" ? logged.receivedAt : polled
              }))
            )
          )
      })
    )
  )
  return Ingest.layer.pipe(
    Layer.provide(tracked),
    Layer.provide(ScenarioProvider.layer.pipe(Layer.provide(Scenarios.in(fixtures, [])))),
    // Fresh, or HubConfig.layer is the one the corpus days were built with, memoized, which names no scenario.
    Layer.provide(Layer.fresh(withEnv({ SPORTAL_SCENARIO: neAtBufFrames, SPORTAL_LEAGUES: "nfl" }))),
    Layer.orDie
  )
}
