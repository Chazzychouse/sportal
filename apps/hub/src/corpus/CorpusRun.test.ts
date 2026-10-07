import { assert, describe, it } from "@effect/vitest"
import { bounds, GameDay } from "@sportal/domain/GameDay"
import { type GameEvent, GameEventKind } from "@sportal/domain/GameEvent"
import { LiveGame } from "@sportal/domain/LiveGame"
import type { Slate } from "@sportal/domain/Slate"
import { liveSnapshot, team } from "@sportal/domain/TestGame"
import {
  Array as Arr,
  Cause,
  Chunk,
  Context,
  DateTime,
  Effect,
  Equal,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schedule,
  Schema,
  Stream
} from "effect"
import { TestClock } from "effect/testing"
import { Worker, WorkerError } from "effect/workers"
import type { FeedFrame } from "../Frame.ts"
import { FeedLog } from "../feed-log/FeedLog.ts"
import * as Ingest from "../Ingest.ts"
import { LiveSlate } from "../LiveSlate.ts"
import * as EspnDecoder from "../provider/espn/EspnDecoder.ts"
import * as ScenarioProvider from "../provider/espn/ScenarioProvider.ts"
import { fixtures, neAtBufFrames, recordedNeAtBuf, recordedPlays } from "../provider/espn/TestEspn.ts"
import { Scenarios } from "../scenario/Scenarios.ts"
import { withEnv } from "../TestHubConfig.ts"
import * as TestSnapshotFeed from "../TestSnapshotFeed.ts"
import { CorpusDay, CorpusDays, CorpusDayUnreadable } from "./CorpusDay.ts"
import { CorpusInput, CorpusLine } from "./CorpusLine.ts"
import * as CorpusRun from "./CorpusRun.ts"
import { built, inCorpus, local } from "./TestCorpus.ts"

describe("CorpusRun.day", () => {
  // NE at BUF's recorded day is logged, built and run twice once for both tests: seconds alone, more under a full
  // suite's load.
  it.layer(neAtBufRunTwiceLayer(), { timeout: "60 seconds" })(
    "the recorded NE at BUF day, run twice",
    (it) => {
      it.effect("should play every recorded play once", () =>
        Effect.gen(function* () {
          const { first } = yield* NeAtBufRunTwice

          const played = first.filter(({ what }) => what._tag === "Played")

          assert.strictEqual(played.length, recordedPlays)
        })
      )

      it.effect("should run to the same events twice", () =>
        Effect.gen(function* () {
          const { first, second } = yield* NeAtBufRunTwice

          assert.isTrue(Equal.equals(first, second))
        })
      )
    }
  )

  // Plays NE at BUF's whole recorded day through Ingest, then builds and runs it: many seconds under a full suite.
  it.effect(
    "should give the events the Hub's slate published live, the day played through Ingest on the test clock",
    () =>
      inCorpus(EspnDecoder.layer, () =>
        Effect.gen(function* () {
          const frames = yield* recordedNeAtBuf
          const zone = yield* DateTime.CurrentTimeZone
          const { until } = bounds(recordedDay, zone)
          const live = yield* playedLive(frames, until)
          yield* built(recordedDay)

          const run = yield* CorpusRun.day(recordedDay, CorpusRun.events)

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

  it.effect("should fall a hold with nothing after it back at its deadline, in the day's last tick", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const days = yield* CorpusDays
        const pushedAt = local("2026-10-04T13:00:00")
        const polledAt = local("2026-10-04T13:00:05")
        const scored = (score: number) => liveSnapshot({ home: { team: team("HOME"), score } })
        const day = new CorpusDay({
          date: recordedDay,
          kind: "captured",
          format: CorpusLine.format,
          leagues: ["fbs"],
          games: 1,
          built: polledAt
        })
        const pushed = new CorpusLine({
          seq: 1,
          at: pushedAt,
          input: CorpusInput.cases.Snapshot.make({ snapshot: scored(7) })
        })
        const polled = new CorpusLine({
          seq: 2,
          at: polledAt,
          input: CorpusInput.cases.ListingChanged.make({ league: "fbs", games: [scored(14)] })
        })
        yield* days.write(day, { push: Stream.make(pushed), poll: Stream.make(polled) })

        const events = yield* CorpusRun.day(recordedDay, CorpusRun.events)

        const last = Arr.last(events)
        assert.isTrue(Option.exists(last, ({ what }) => GameEventKind.$is("ScoreChanged")(what)))
        assert.deepStrictEqual(
          Option.map(last, ({ at }) => at),
          Option.some(DateTime.addDuration(polledAt, LiveGame.fallbackAfter))
        )
      })
    )
  )

  it.effect("should fail a day that is not there as CorpusDayUnreadable, Missing", () =>
    inCorpus(TestSnapshotFeed.decoder, () =>
      Effect.gen(function* () {
        const error = yield* CorpusRun.day(recordedDay, CorpusRun.events).pipe(Effect.flip)

        assert.deepStrictEqual(
          [error._tag, error.date, error.reason],
          ["CorpusDayUnreadable", recordedDay, "Missing"]
        )
      })
    )
  )
})

describe("RunDay.run", () => {
  // Builds and runs NE at BUF's whole recorded day, through ESPN's decode: seconds alone, more under a full suite.
  it.effect(
    "should answer RunDay for the recorded NE at BUF day with the event count its run gives",
    () =>
      inCorpus(EspnDecoder.layer, () =>
        Effect.gen(function* () {
          const frames = yield* recordedNeAtBuf
          yield* built(recordedDay, frames)

          const run = yield* new CorpusRun.RunDay({ date: recordedDay }).run()

          const events = yield* CorpusRun.day(recordedDay, CorpusRun.events)
          assert.strictEqual(run.date, recordedDay)
          assert.strictEqual(run.events, events.length)
          assert.isAbove(run.events, 0)
          assert.isAtLeast(run.millis, 0)
        })
      ),
    { timeout: 60_000 }
  )

  it.effect("should fail a day that has not been built as CorpusDayUnreadable Missing", () =>
    inCorpus(EspnDecoder.layer, () =>
      Effect.gen(function* () {
        const error = yield* new CorpusRun.RunDay({ date: recordedDay }).run().pipe(Effect.flip)

        assert.deepStrictEqual([error.date, error.reason], [recordedDay, "Missing"])
      })
    )
  )
})

describe("DayRun.reply", () => {
  it.effect("should cross a thread as the run it holds", () =>
    Effect.gen(function* () {
      const run = Exit.succeed(new CorpusRun.DayRun({ date: recordedDay, events: 266, millis: 95 }))

      const received = yield* crossed(run)

      assert.deepStrictEqual(received, run)
    })
  )

  it.effect("should cross a thread as the typed failure it holds", () =>
    Effect.gen(function* () {
      const missing = Exit.fail(
        new CorpusDayUnreadable({ date: GameDay.make("2026-10-05"), reason: "Missing", cause: "day.json" })
      )

      const failed = yield* crossed(missing)

      assert.isTrue(Exit.isFailure(failed))
      if (Exit.isFailure(failed)) {
        const error = Cause.findErrorOption(failed.cause)
        assert.deepStrictEqual(
          Option.map(error, ({ _tag, date, reason }) => [_tag, date, reason]),
          Option.some(["CorpusDayUnreadable", "2026-10-05", "Missing"])
        )
      }
    })
  )
})

describe("CorpusRun.runDays", () => {
  it.effect("should run every day, succeeding when none failed", () =>
    Effect.gen(function* () {
      const threads = yield* stubThreads()

      yield* CorpusRun.runDays([ok, other], 2).pipe(Effect.provide(threads.layer))

      const answered = yield* Ref.get(threads.answered)
      const spawned = yield* Ref.get(threads.spawned)
      assert.deepStrictEqual(answered.toSorted(), [ok, other])
      assert.strictEqual(spawned, 2)
    })
  )

  it.effect(
    "should fail a crashed thread's day alone, running the rest on a fresh thread, and fail the run DaysFailed",
    () =>
      Effect.gen(function* () {
        const threads = yield* stubThreads()

        const error = yield* CorpusRun.runDays([ok, crash, missing, other], 1).pipe(
          Effect.provide(threads.layer),
          Effect.flip
        )

        const answered = yield* Ref.get(threads.answered)
        const spawned = yield* Ref.get(threads.spawned)
        assert.instanceOf(error, CorpusRun.DaysFailed)
        assert.deepStrictEqual([error.failed, error.days], [2, 4])
        assert.deepStrictEqual(answered, [ok, other])
        assert.strictEqual(spawned, 2)
      })
  )
})

// NE at BUF's recorded day, and the day of every day-run test.
const recordedDay = GameDay.make("2026-10-04")

/** The events of two corpus runs of NE at BUF's recorded day, logged and built once. */
class NeAtBufRunTwice extends Context.Service<
  NeAtBufRunTwice,
  { readonly first: ReadonlyArray<GameEvent>; readonly second: ReadonlyArray<GameEvent> }
>()("test/NeAtBufRunTwice") {}

function neAtBufRunTwiceLayer() {
  return Layer.effect(
    NeAtBufRunTwice,
    inCorpus(EspnDecoder.layer, () =>
      Effect.gen(function* () {
        const frames = yield* recordedNeAtBuf
        yield* built(recordedDay, frames)

        const first = yield* CorpusRun.day(recordedDay, CorpusRun.events)
        const second = yield* CorpusRun.day(recordedDay, CorpusRun.events)

        return { first, second }
      })
    )
  )
}

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
    const slate = yield* LiveSlate
    const seen = yield* Ref.make(Chunk.empty<GameEvent>())
    const subscriber = yield* slate.events.pipe(
      Stream.runForEach((published) => Ref.update(seen, Chunk.append(published))),
      Effect.forkChild({ startImmediately: true })
    )
    const appended = yield* Ref.make({ seq: 0, polled: first })

    // Until no fiber woken at this instant appends anything the slate has not taken, for at most `rounds` rounds.
    const settled = (rounds: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (rounds === 0) return yield* Effect.die(new Error("frames kept being appended at one instant"))
        yield* TestClock.adjust(0)
        const { seq } = yield* Ref.get(appended)
        if (seq > 0) yield* slate.through(seq)
        yield* TestClock.adjust(0)
        const after = yield* Ref.get(appended)
        if (after.seq !== seq) yield* settled(rounds - 1)
      })
    // ScenarioProvider pushes each frame at its instant and polls at a poll's instant or 10 s after the last, its
    // `longest`.
    const steppedTo = (to: DateTime.Utc): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* settled(100)
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
    const tickedThrough = (latest: Slate) =>
      Option.match(latest.earliestDue(), {
        onNone: () => true,
        onSome: (due) => DateTime.isGreaterThan(due, until)
      })
    // For at most 5 s of real time.
    const ticked = yield* slate.latest.pipe(
      Effect.repeat({ until: tickedThrough, schedule: Schedule.spaced("1 millis"), times: 5000 }),
      TestClock.withLive
    )
    if (!tickedThrough(ticked)) {
      return yield* Effect.die(new Error("the slate's timer did not tick to the next day's start"))
    }
    yield* TestClock.adjust(0)
    yield* Fiber.interrupt(subscriber)
    const published = yield* Ref.get(seen)
    return Chunk.toReadonlyArray(published)
  }).pipe(Effect.provide(LiveSlate.layer.pipe(Layer.provideMerge(FeedLog.layer))), Effect.scoped)
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
    Layer.provide(ScenarioProvider.layer.pipe(Layer.provide(Scenarios.layerFrom(fixtures)))),
    // Fresh, or HubConfig.layer is the one the corpus days were built with, memoized, which names no scenario.
    Layer.provide(Layer.fresh(withEnv({ SPORTAL_SCENARIO: neAtBufFrames, SPORTAL_LEAGUES: "nfl" }))),
    Layer.orDie
  )
}

/** `exit` as a reply, cloned as a message crossing a thread is, and read back. */
function crossed(exit: Exit.Exit<CorpusRun.DayRun, CorpusDayUnreadable>) {
  return CorpusRun.DayRun.reply(exit).pipe(
    Effect.flatMap((reply) => CorpusRun.DayRun.fromReply(structuredClone(reply)))
  )
}

const ok = GameDay.make("2026-10-03")
const crash = GameDay.make("2026-10-04")
const missing = GameDay.make("2026-10-05")
const other = GameDay.make("2026-10-06")

/**
 * Worker threads in this one: each answers a day with one event, a day not built as `CorpusDayUnreadable`, and stops
 * with a `WorkerError` on `crash`'s, as a thread that crashed would.
 */
function stubThreads() {
  return Effect.gen(function* () {
    const answered = yield* Ref.make<ReadonlyArray<string>>([])
    const spawned = yield* Ref.make(0)
    const platform = Worker.WorkerPlatform.of({
      spawn: () =>
        Effect.gen(function* () {
          yield* Ref.update(spawned, (count) => count + 1)
          const inbox = yield* Queue.unbounded<unknown>()
          return Worker.makeUnsafe({
            send: (message) => Queue.offer(inbox, message).pipe(Effect.asVoid),
            run: (handler) =>
              Queue.take(inbox).pipe(
                Effect.flatMap((message) =>
                  Schema.decodeUnknownEffect(CorpusRun.RunDay)(message).pipe(Effect.orDie)
                ),
                Effect.flatMap(({ date }) =>
                  date === crash
                    ? Effect.fail(
                        new WorkerError.WorkerError({
                          reason: new WorkerError.WorkerReceiveError({ message: "exited with code 1" })
                        })
                      )
                    : CorpusRun.DayRun.reply(
                        date === missing
                          ? Exit.fail(new CorpusDayUnreadable({ date, reason: "Missing", cause: "day.json" }))
                          : Exit.succeed(new CorpusRun.DayRun({ date, events: 1, millis: 1 }))
                      ).pipe(
                        Effect.tap(() =>
                          date === missing ? Effect.void : Ref.update(answered, (dates) => [...dates, date])
                        )
                      )
                ),
                Effect.flatMap((reply) => handler([1, reply])),
                Effect.forever
              )
          })
        })
    })
    return {
      answered,
      spawned,
      layer: Layer.merge(
        Layer.succeed(Worker.WorkerPlatform, platform),
        Worker.layerSpawner(() => undefined)
      )
    }
  })
}
