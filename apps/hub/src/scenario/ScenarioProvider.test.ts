import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
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
import type { HubConfig } from "../HubConfig.ts"
import * as Ingest from "../Ingest.ts"
import { LiveGames } from "../LiveGames.ts"
import type { Decoder } from "../provider/Decoder.ts"
import * as EspnDecode from "../provider/espn/EspnDecode.ts"
import * as EspnScript from "../provider/espn/EspnScript.ts"
import { Provider } from "../provider/Provider.ts"
import { decodedFrames, listedBy, pushed, writtenScenarios } from "../TestFeed.ts"
import { withEnv } from "../TestHubConfig.ts"
import * as TestSnapshotFeed from "../TestSnapshotFeed.ts"
import { recordingSpans } from "../TestTelemetry.ts"
import type { Scenario } from "./Scenario.ts"
import * as ScenarioClock from "./ScenarioClock.ts"
import * as ScenarioProvider from "./ScenarioProvider.ts"
import { ScenarioScript } from "./ScenarioScript.ts"
import {
  type ScenarioDuplicate,
  Scenarios,
  type ScenarioUnknown,
  type ScenarioUnreadable
} from "./Scenarios.ts"

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
      const dir = yield* recorded("seven", [polledAt(0, [scoring(0)]), polledAt(7, [scoring(7)])])
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0)
        yield* TestClock.adjust("6 seconds")
        assert.strictEqual((yield* listed("fbs"))[0]?.home.score, 0)
        yield* TestClock.adjust("1 second")
        assert.strictEqual((yield* listed("fbs"))[0]?.home.score, 7)
      }).pipe(Effect.provide(playing("seven", { from: dir, decoder: TestSnapshotFeed.decoder })))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("a written scenario's poll decodes through ESPN's decode to the league's listing", () =>
    Effect.gen(function* () {
      const [decoded] = yield* decodedFrames([yield* (yield* Provider).poll("fbs")])
      const [listing] = decoded?.deliveries ?? []
      assert.strictEqual(listing?._tag, "Listing")
      assert.deepStrictEqual(listing?._tag === "Listing" && [listing.league, listing.games.length], [
        "fbs",
        4
      ])
      assert.deepStrictEqual(decoded?.notices, [])
    }).pipe(Effect.provide(scenario("two-minute-drill-tie")))
  )

  it.effect("a scenario's poll that does not decode is noted by ESPN's decode, not dropped", () =>
    Effect.gen(function* () {
      const [decoded] = yield* decodedFrames([
        { receivedAt: DateTime.makeUnsafe(0), feed: "poll", channel: "fbs", kind: "response", body: "{" }
      ])
      assert.deepStrictEqual(decoded?.deliveries, [])
      assert.deepStrictEqual(
        decoded?.notices.map((notice) => notice._tag),
        ["FrameUndecoded"]
      )
    }).pipe(Effect.provide(scenario("two-minute-drill-tie")))
  )

  it.effect(
    "a recorded scenario is played with only its settings and the scenarios, read by ESPN's decode",
    () =>
      Effect.gen(function* () {
        const provider = ScenarioProvider.layer satisfies Layer.Layer<
          Provider,
          ScenarioUnknown | ScenarioUnreadable | ScenarioDuplicate,
          HubConfig | Scenarios
        >
        const games = yield* listedBy("fbs").pipe(
          Effect.provide(
            Layer.merge(provider, EspnDecode.layer).pipe(
              Layer.provide([
                Scenarios.layer(writtenScenarios),
                withEnv({ SPORTAL_SCENARIO: "crowded-fourth-quarter" }).pipe(Layer.orDie)
              ]),
              Layer.provide(NodeServices.layer)
            )
          )
        )
        assert.isNotEmpty(games)
      })
  )

  it.effect("holds a written scenario's last slate once it has ended", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("1 hour")
      const tie = (yield* listed("fbs")).find((game) => game.id === "tie-uga-ala")
      assert.deepStrictEqual([tie?.status, tie?.home.score], ["final", 27])
    }).pipe(Effect.provide(playing("two-minute-drill-tie")))
  )

  it.effect("a written scenario pushes each play's message at its offset", () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      yield* Effect.gen(function* () {
        const provider = yield* Provider
        const received = yield* Ref.make<ReadonlyArray<number>>([])
        yield* provider.push(Stream.never).pipe(
          Stream.filter((frame) => frame.kind === "message"),
          Stream.runForEach((frame) =>
            Ref.update(received, (all) => [...all, frame.receivedAt.epochMilliseconds])
          ),
          Effect.forkScoped({ startImmediately: true })
        )
        yield* TestClock.adjust("30 seconds")
        assert.deepStrictEqual(yield* Ref.get(received), [])
        yield* TestClock.adjust("2 millis")
        assert.deepStrictEqual(yield* Ref.get(received), [30_002])
        yield* TestClock.adjust("30 seconds")
        assert.deepStrictEqual(yield* Ref.get(received), [30_002, 60_002])
      }).pipe(Effect.provide(scenario("a-drive", { from: dir, written: [EspnScript.scenarioOf(aDrive)] })))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("a recorded scenario polls the recorded poll current at that moment, received now", () =>
    Effect.gen(function* () {
      const dir = yield* recorded("two-polls", [polledAt(0, [scoring(3)]), polledAt(30, [scoring(10)])])
      yield* Effect.gen(function* () {
        const provider = yield* Provider
        yield* TestClock.adjust("20 seconds")
        const first = yield* provider.poll("fbs")
        const none = yield* provider.poll("nfl")
        yield* TestClock.adjust("15 seconds")
        const second = yield* provider.poll("fbs")

        assert.deepStrictEqual(
          [first, second].map(({ body, receivedAt }) => [
            JSON.parse(body).games[0].home.score,
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
        polledAt(0, [scoring(0)]),
        pushedAt(5, scoring(3)),
        pushedAt(12, scoring(7))
      ])
      yield* Effect.gen(function* () {
        const provider = yield* Provider
        const received = yield* Ref.make<ReadonlyArray<number>>([])
        yield* provider.push(Stream.never).pipe(
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
        polledAt(0, [scoring(0)]),
        pushedAt(1, scoring(7)),
        polledAt(10, [scoring(0)])
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
      }).pipe(Effect.provide(playing("tie", { from: dir, decoder: TestSnapshotFeed.decoder })))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect(
    "every committed scenario, recorded or written, plays to a non-empty final slate",
    () =>
      Effect.gen(function* () {
        const recorded = yield* Scenarios
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
        Effect.provide([
          Scenarios.layer(writtenScenarios).pipe(Layer.provide(NodeServices.layer)),
          NodeServices.layer
        ])
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
          Effect.repeat({ until: (frames) => frames.length >= 6, schedule: Schedule.spaced("5 millis") }),
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
          ["poll", "fbs"],
          ...["tie-uga-ala", "tie-osu-mich", "tie-tex-ou", "tie-lsu-miss"].map((game) => [
            "fastcast",
            `gp-football-college-football-${game}`
          ])
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
      const fold = yield* Layer.buildWithScope(
        following(onFile).pipe(Layer.provide(scenario("two-minute-drill-tie", onFile))),
        scope
      )
      const events = yield* Ref.make(0)
      yield* Context.get(fold, LiveGames).events.pipe(
        Stream.runForEach(() => Ref.update(events, (count) => count + 1)),
        Effect.forkIn(scope, { startImmediately: true })
      )
      yield* Layer.buildWithScope(
        Ingest.layer.pipe(
          Layer.provide(scenario("two-minute-drill-tie", onFile)),
          Layer.provide(Layer.succeedContext(fold))
        ),
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
 * Scenario `name` as the provider and its decoder, played as `HubMode` plays it and configured by `env` beside its
 * name: a written one, or a recorded one read from `from` (the committed ones, unless given), its frames decoded by
 * `decoder` (ESPN's, unless given).
 */
function scenario(name: string, options: Options = {}) {
  return Layer.merge(
    ScenarioProvider.layer.pipe(
      Layer.provide(
        options.from === undefined
          ? Scenarios.layer(writtenScenarios)
          : Scenarios.in(options.from, options.written ?? writtenScenarios)
      )
    ),
    options.decoder ?? EspnDecode.layer
  ).pipe(
    Layer.provideMerge(withEnv({ SPORTAL_SCENARIO: name, ...options.env }).pipe(Layer.orDie)),
    Layer.provide(NodeServices.layer)
  )
}

/**
 * Ingest over `scenario(name, options)`, onto a feed log in memory or, with `scenarioFeedLog`, the scenario's own one
 * as its settings say, with the fold provided to the test.
 */
function playing(name: string, options: Options & { readonly ended?: Array<Tracer.Span> } = {}) {
  return Ingest.layer.pipe(
    Layer.provideMerge(following(options)),
    Layer.provide(scenario(name, options)),
    Layer.provide(recordingSpans(options.ended ?? []))
  )
}

/**
 * The live games following a feed log in memory or, with `scenarioFeedLog`, the scenario's own one as its settings say,
 * which is provided too.
 */
function following(options: Options) {
  return LiveGames.layer.pipe(
    Layer.provideMerge(
      options.scenarioFeedLog === true
        ? FeedLog.forScenario
        : FeedLog.layer.pipe(Layer.provide([Database.at(":memory:"), NodeCrypto.layer]))
    ),
    Layer.provide(DateTime.layerCurrentZoneLocal),
    Layer.provide([NodeServices.layer, NodeCrypto.layer])
  )
}

/**
 * How a test sets a scenario up; one HubConfig, from `env`, serves the whole Hub under test. `written` replaces the
 * written scenarios beside the recorded ones in `from`.
 */
type Options = {
  readonly from?: string
  readonly decoder?: Layer.Layer<Decoder>
  readonly env?: Record<string, string>
  readonly scenarioFeedLog?: boolean
  readonly written?: ReadonlyArray<Scenario>
}

/** Writes recorded scenario `name`, of `frames`, to a fresh folder, and gives the folder. */
function recorded(name: string, frames: ReadonlyArray<Effect.Effect<FeedFrame>>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped()
    const lines = (yield* Effect.all(frames)).map(
      (frame) => `${Schema.encodeSync(Schema.fromJsonString(FeedFrame))(frame)}\n`
    )
    const bytes = yield* Gzip.compress(lines.join(""))
    yield* fs.writeFile((yield* Path.Path).join(dir, `${name}.frames.jsonl.gz`), bytes)
    return dir
  })
}

// A written scenario of one drive, with a play at 0:30 and another at 1:00.
const aDrive = ScenarioScript.build("a-drive", [
  {
    id: "drive-uga-ala",
    home: "UGA",
    away: "ALA",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 1,
          clock: "15:00",
          ball: { team: "home", yardLine: 75, down: 1, distance: 10 }
        }
      ],
      [
        "0:30",
        {
          clock: "14:30",
          ball: { team: "home", yardLine: 71, down: 2, distance: 6 },
          play: { kind: "rush", yards: 4 }
        }
      ],
      [
        "1:00",
        {
          clock: "14:00",
          ball: { team: "home", yardLine: 59, down: 1, distance: 10 },
          play: { kind: "pass", yards: 12 }
        }
      ]
    ]
  }
])

// When the recorded scenarios here were recorded.
const recordedAt = DateTime.makeUnsafe("2026-10-04T18:00:00Z")

/** An fbs poll of `games` as the snapshot feed says it, as recorded `seconds` into the recording. */
function polledAt(seconds: number, games: ReadonlyArray<GameSnapshot>) {
  return recordedAs(seconds, "poll", pushed(Delivery.cases.Listing.make({ league: "fbs", games }), "fbs"))
}

/** A live feed frame of `game` pushed, as the snapshot feed says it, as recorded `seconds` into the recording. */
function pushedAt(seconds: number, game: GameSnapshot) {
  return recordedAs(
    seconds,
    "fastcast",
    pushed(Delivery.cases.Snapshot.make({ snapshot: game, from: "push" }), "fbs")
  )
}

/**
 * `said` as a recording from `feed` holds it, received `seconds` into the recording. The frame is synthetic: a snapshot
 * feed body under an ESPN feed's name, for a recorded scenario decoded by `TestSnapshotFeed.decoder`.
 */
function recordedAs(seconds: number, feed: "poll" | "fastcast", said: Effect.Effect<FeedFrame>) {
  return Effect.map(
    said,
    (frame) =>
      new FeedFrame({
        ...frame,
        receivedAt: DateTime.add(recordedAt, { seconds }),
        feed,
        kind: feed === "poll" ? "response" : "message"
      })
  )
}

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
