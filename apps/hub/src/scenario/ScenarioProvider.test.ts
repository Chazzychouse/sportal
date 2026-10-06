import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { liveSnapshot, team } from "@sportal/domain/TestGame"
import {
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
  type Tracer
} from "effect"
import { TestClock } from "effect/testing"
import * as Database from "../Database.ts"
import { FeedLog } from "../FeedLog.ts"
import { FeedFrame } from "../Frame.ts"
import * as Gzip from "../Gzip.ts"
import * as Ingest from "../ingest/Ingest.ts"
import { LiveGames } from "../LiveGames.ts"
import type { Decoder } from "../provider/Decoder.ts"
import * as EspnDecode from "../provider/espn/EspnDecode.ts"
import { Provider } from "../provider/Provider.ts"
import { decoder } from "../provider/TestProvider.ts"
import { withEnv } from "../TestHubConfig.ts"
import { recordingSpans } from "../TestTelemetry.ts"
import { RecordedScenarios } from "./RecordedScenarios.ts"
import * as ScenarioClock from "./ScenarioClock.ts"
import * as ScenarioProvider from "./ScenarioProvider.ts"

describe("ScenarioProvider", () => {
  it.effect("each league's listing reaches the fold at its scenario time", () =>
    Effect.gen(function* () {
      const liveGames = yield* LiveGames
      yield* TestClock.adjust(0)
      assert.lengthOf(yield* listed("fbs"), 4)
      assert.deepStrictEqual(yield* listed("nfl"), [])

      yield* TestClock.adjust("119 seconds")
      assert.isFalse(yield* tieInRedZone)
      yield* TestClock.adjust("1 second")
      assert.isTrue(yield* tieInRedZone)
      assert.isTrue((yield* liveGames.latest).seq._tag === "Some", "its frames went through the feed log")
    }).pipe(Effect.provide(playing("two-minute-drill-tie")))
  )

  it.effect("a poll's span has the scenario's poll of each league inside it", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* TestClock.adjust(0)
      const poll = ended.find((span) => span.name === "Ingest.poll")
      const inside = ended.filter(
        (span) =>
          span.name === "ScenarioProvider.poll" &&
          Option.exists(span.parent, (parent) => parent.spanId === poll?.spanId)
      )
      assert.deepStrictEqual(
        inside.map((span) => span.attributes.get("sportal.league")),
        ["nfl", "fbs"]
      )
    }).pipe(Effect.provide(playing("two-minute-drill-tie", { ended })))
  })

  it.effect("the polling Schedule wakes at the next frame and never waits more than 10 s", () =>
    Effect.gen(function* () {
      const step = yield* Schedule.toStep((yield* Provider).polling)
      const after = (seconds: number) =>
        step(seconds * 1000, { slate: [], failed: [] }).pipe(Effect.map(([, delay]) => delay))

      // two-minute-drill-tie has frames at 0:00, 0:40, 1:20, 1:30, 2:00, 3:00, and 3:40.
      assert.deepStrictEqual(yield* after(0), Duration.seconds(10))
      assert.deepStrictEqual(yield* after(35), Duration.seconds(5))
      assert.deepStrictEqual(yield* after(87), Duration.seconds(3))
      assert.deepStrictEqual(yield* after(400), Duration.seconds(10))
    }).pipe(Effect.provide(scenario("two-minute-drill-tie")))
  )

  it.effect("a change recorded at 0:07 lands at 7 s, not at the next 10 s", () =>
    Effect.gen(function* () {
      const dir = yield* recorded("seven", [polled(0, [scoring(0)]), polled(7, [scoring(7)])])
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("6 seconds")
        assert.strictEqual((yield* listed("fbs"))[0]?.home.score, 0)
        yield* TestClock.adjust("1 second")
        assert.strictEqual((yield* listed("fbs"))[0]?.home.score, 7)
      }).pipe(Effect.provide(playing("seven", { from: dir, decoder: slates })))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("a written scenario never pushes", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      const pushed = yield* provider
        .push(LeagueId.literals, Stream.never, Stream.never)
        .pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("1 hour")
      assert.isUndefined(pushed.pollUnsafe())
    }).pipe(Effect.provide(scenario("two-minute-drill-tie")))
  )

  it.effect("a recorded scenario polls the recorded poll current at that moment, received now", () =>
    Effect.gen(function* () {
      const dir = yield* recorded("two-polls", [polled(0, [scoring(3)]), polled(30, [scoring(10)])])
      yield* Effect.gen(function* () {
        const provider = yield* Provider
        yield* TestClock.adjust("20 seconds")
        const first = yield* provider.poll("fbs")
        const none = yield* provider.poll("nfl")
        yield* TestClock.adjust("15 seconds")
        const second = yield* provider.poll("fbs")

        assert.deepStrictEqual(
          [first, second].map(({ body, receivedAt }) => [
            JSON.parse(body)[0].home.score,
            receivedAt.epochMilliseconds
          ]),
          [
            [3, 20_000],
            [10, 35_000]
          ]
        )
        assert.deepStrictEqual(JSON.parse(none.body), { events: [] })
      }).pipe(Effect.provide(scenario("two-polls", { from: dir })))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("a recorded scenario pushes its live feed frames at their recorded offsets", () =>
    Effect.gen(function* () {
      const dir = yield* recorded("pushes", [
        polled(0, [scoring(0)]),
        pushedAt(5, [scoring(3)]),
        pushedAt(12, [scoring(7)])
      ])
      yield* Effect.gen(function* () {
        const provider = yield* Provider
        const received = yield* Ref.make<ReadonlyArray<number>>([])
        yield* provider.push(LeagueId.literals, Stream.never, Stream.never).pipe(
          Stream.runForEach((frame) =>
            Ref.update(received, (all) => [...all, frame.receivedAt.epochMilliseconds])
          ),
          Effect.forkScoped({ startImmediately: true })
        )
        yield* TestClock.adjust("4 seconds")
        assert.deepStrictEqual(yield* Ref.get(received), [])
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(yield* Ref.get(received), [5_000])
        yield* TestClock.adjust("7 seconds")
        assert.deepStrictEqual(yield* Ref.get(received), [5_000, 12_000])
      }).pipe(Effect.provide(scenario("pushes", { from: dir })))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("a push at the same game time as a poll wins the tie", () =>
    Effect.gen(function* () {
      const dir = yield* recorded("tie", [
        polled(0, [scoring(0)]),
        pushedAt(1, [scoring(7)]),
        polled(10, [scoring(0)])
      ])
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("2 seconds")
        assert.strictEqual((yield* slate)[0]?.home.score, 7)
        yield* TestClock.adjust("10 seconds")
        assert.strictEqual(
          (yield* slate)[0]?.home.score,
          7,
          "the tied poll only refreshed the pushed snapshot"
        )
      }).pipe(Effect.provide(playing("tie", { from: dir, decoder: slates })))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect(
    "every committed recorded scenario plays to a non-empty final slate",
    () =>
      Effect.gen(function* () {
        const recorded = yield* RecordedScenarios
        const names = yield* recorded.names
        assert.isAbove(names.length, 0)
        for (const name of names) {
          const { frames } = yield* recorded.load(name)
          const last = frames.at(-1)?.receivedAt ?? DateTime.makeUnsafe(0)
          const length = DateTime.distance(frames[0]?.receivedAt ?? last, last)
          yield* Effect.gen(function* () {
            yield* TestClock.adjust(0)
            yield* TestClock.adjust(length)
            assert.isNotEmpty(yield* slate, name)
          }).pipe(Effect.provide(playing(name)), Effect.scoped)
        }
      }).pipe(
        Effect.provide([RecordedScenarios.layer.pipe(Layer.provide(NodeServices.layer)), NodeServices.layer])
      ),
    120_000
  )

  it.effect("refuses a name it does not know, listing the names it does", () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const error = yield* Layer.build(scenario("../../etc/passwd", { from: dir })).pipe(Effect.flip)
      assert.strictEqual(error._tag, "ScenarioUnknown")
      assert.include(error.message, "two-minute-drill-tie")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("plays at the scenario's speed, while the rest of the Hub keeps real time", () =>
    Effect.gen(function* () {
      // The clock and the scenario share one HubConfig, so the same variables build it.
      const env = { SPORTAL_SCENARIO: "two-minute-drill-tie", SPORTAL_SCENARIO_SPEED: "10" }
      const context = yield* Layer.build(
        playing("two-minute-drill-tie", { env }).pipe(
          Layer.provide(ScenarioClock.layer.pipe(Layer.provide(withEnv(env).pipe(Layer.orDie))))
        )
      )
      // 13 real seconds are 130 scenario seconds: the drive is at the 17, in the red zone, since 2:00.
      yield* TestClock.adjust("13 seconds")
      assert.isTrue(yield* tieInRedZone.pipe(Effect.provide(context)))
      assert.strictEqual(DateTime.toEpochMillis(yield* DateTime.now), 13_000)
    }).pipe(Effect.scoped)
  )

  it.effect("frames go to the scenario's feed log, and nothing reaches feed.sqlite", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { join } = yield* Path.Path
      const dataDir = yield* fs.makeTempDirectoryScoped()
      const logged = yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("100 millis")
        // The log compresses and writes on the event loop, so this waits in real time.
        return yield* Stream.runCollect((yield* FeedLog).replay(DateTime.makeUnsafe(0))).pipe(
          Effect.repeat({ until: (frames) => frames.length >= 2, schedule: Schedule.spaced("5 millis") }),
          Effect.timeout("1 second"),
          TestClock.withLive
        )
      }).pipe(
        Effect.provide(
          playing("two-minute-drill-tie", { env: { SPORTAL_DATA_DIR: dataDir }, scenarioFeedLog: true })
        ),
        Effect.scoped
      )

      assert.deepStrictEqual(
        logged.map(({ feed, channel }) => [feed, channel]),
        [
          ["poll", "nfl"],
          ["poll", "fbs"]
        ]
      )
      assert.isFalse(yield* fs.exists(join(dataDir, "feed.sqlite")))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("a restart replays the scenario's logged frames and publishes no events for them", () =>
    Effect.gen(function* () {
      const dataDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const onFile = {
        env: { SPORTAL_DATA_DIR: dataDir, SPORTAL_SCENARIO_FEED_LOG: "scenario.sqlite" },
        scenarioFeedLog: true
      }
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("3 minutes")
      }).pipe(Effect.provide(playing("two-minute-drill-tie", onFile)), Effect.scoped)

      const scope = yield* Scope.make()
      const fold = yield* Layer.buildWithScope(LiveGames.layer, scope)
      const events = yield* Ref.make(0)
      yield* Context.get(fold, LiveGames).events.pipe(
        Stream.runForEach(() => Ref.update(events, (count) => count + 1)),
        Effect.forkIn(scope, { startImmediately: true })
      )
      yield* Layer.buildWithScope(
        ingestOver("two-minute-drill-tie", onFile).pipe(Layer.provide(Layer.succeedContext(fold))),
        scope
      )

      assert.isTrue(
        Option.isSome((yield* Context.get(fold, LiveGames).latest).seq),
        "the frames were replayed"
      )
      assert.strictEqual(yield* Ref.get(events), 0)
      yield* Scope.close(scope, Exit.void)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/**
 * Scenario `name` as the provider, configured by `env` beside its name: recorded scenarios read from `from` (the
 * committed ones, unless given), their frames decoded by `decoder` (ESPN's, unless given).
 */
function scenario(name: string, options: Options = {}) {
  return ScenarioProvider.layer.pipe(
    Layer.provide([
      options.from === undefined ? RecordedScenarios.layer : RecordedScenarios.in(options.from),
      options.decoder ?? EspnDecode.layer
    ]),
    Layer.provideMerge(withEnv({ SPORTAL_SCENARIO: name, ...options.env }).pipe(Layer.orDie)),
    Layer.provide(NodeServices.layer)
  )
}

/**
 * Ingest over `scenario(name, options)`, onto a feed log in memory or, with `scenarioFeedLog`, the scenario's own one
 * as its settings say, with the fold provided to the test.
 */
function playing(name: string, options: Options & { readonly ended?: Array<Tracer.Span> } = {}) {
  return ingestOver(name, options).pipe(
    Layer.provideMerge(LiveGames.layer),
    Layer.provide(recordingSpans(options.ended ?? []))
  )
}

function ingestOver(name: string, options: Options) {
  return Ingest.layer.pipe(
    Layer.provideMerge(
      options.scenarioFeedLog === true
        ? FeedLog.forScenario
        : FeedLog.layer.pipe(Layer.provide([Database.at(":memory:"), NodeCrypto.layer]))
    ),
    Layer.provide([scenario(name, options), DateTime.layerCurrentZoneLocal]),
    Layer.provide([NodeServices.layer, NodeCrypto.layer])
  )
}

/** How a test sets a scenario up; one HubConfig, from `env`, serves the whole Hub under test. */
type Options = {
  readonly from?: string
  readonly decoder?: Layer.Layer<Decoder>
  readonly env?: Record<string, string>
  readonly scenarioFeedLog?: boolean
}

/** A decode that reads a poll's body as its league's games, and a pushed frame's as pushed snapshots. */
const slates = decoder

/** Writes recorded scenario `name`, of `frames`, to a fresh folder, and gives the folder. */
function recorded(name: string, frames: ReadonlyArray<FeedFrame>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped()
    const lines = frames.map((frame) => `${Schema.encodeSync(Schema.fromJsonString(FeedFrame))(frame)}\n`)
    const bytes = yield* Gzip.compress(lines.join(""))
    yield* fs.writeFile((yield* Path.Path).join(dir, `${name}.frames.jsonl.gz`), bytes)
    return dir
  })
}

// When the recorded scenarios here were recorded.
const recordedAt = DateTime.makeUnsafe("2026-10-04T18:00:00Z")

function polled(seconds: number, games: ReadonlyArray<GameSnapshot>): FeedFrame {
  return new FeedFrame({
    receivedAt: DateTime.add(recordedAt, { seconds }),
    feed: "poll",
    channel: "fbs",
    kind: "response",
    body: encodeGames(games)
  })
}

function pushedAt(seconds: number, games: ReadonlyArray<GameSnapshot>): FeedFrame {
  return new FeedFrame({
    receivedAt: DateTime.add(recordedAt, { seconds }),
    feed: "fastcast",
    channel: "event-football-college-football",
    kind: "message",
    body: encodeGames(games)
  })
}

const encodeGames = Schema.encodeSync(Schema.fromJsonString(Schema.Array(GameSnapshot)))

function scoring(points: number) {
  return liveSnapshot({ id: GameId.make("1"), home: { team: team("HOME"), score: points } })
}

/** League `league`'s last listing in the fold. */
function listed(league: LeagueId) {
  return Effect.map(
    LiveGames.use((liveGames) => liveGames.latest),
    (folded) => folded.listed.get(league) ?? []
  )
}

/** The slate as the fold has it. */
const slate = Effect.map(
  LiveGames.use((liveGames) => liveGames.latest),
  (folded) => folded.slate(LeagueId.literals)
)

const tieInRedZone = Effect.map(
  listed("fbs"),
  (games) => games.find((game) => game.id === "tie-uga-ala")?.situation?.inRedZone() === true
)
