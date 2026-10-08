import { fileURLToPath } from "node:url"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { liveSnapshot, team } from "@sportal/domain/TestGame"
import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  Schema,
  Stream
} from "effect"
import { TestClock } from "effect/testing"
import * as Database from "../../Database.ts"
import { Frame } from "../../Frame.ts"
import { FeedLog } from "../../feed-log/FeedLog.ts"
import * as Gzip from "../../Gzip.ts"
import { HubConfig } from "../../HubConfig.ts"
import * as Ingest from "../../Ingest.ts"
import { LiveSlate } from "../../LiveSlate.ts"
import * as ScenarioClock from "../../scenario/ScenarioClock.ts"
import { Scenarios, type ScenarioUnknown, type ScenarioUnreadable } from "../../scenario/Scenarios.ts"
import { Delivery } from "../../slate/Delivery.ts"
import * as TestSnapshotFeed from "../../TestSnapshotFeed.ts"
import { pushed } from "../../TestSnapshotFeed.ts"
import { Provider } from "../Provider.ts"
import { decodedFrames, listedBy } from "../TestProvider.ts"
import * as ScenarioProvider from "./ScenarioProvider.ts"

describe("ScenarioProvider", () => {
  it.effect("should bring each league's listing to the slate at the scenario's start", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)

      const fbs = yield* listed("fbs")
      const nfl = yield* listed("nfl")

      assert.lengthOf(fbs, 4)
      assert.deepStrictEqual(nfl, [])
    }).pipe(Effect.provide(playing("two-minute-drill-tie")))
  )

  it.effect("should not bring a change to the slate before its scenario time", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)

      yield* TestClock.adjust("119 seconds")

      const inRedZone = yield* tieInRedZone
      assert.isFalse(inRedZone)
    }).pipe(Effect.provide(playing("two-minute-drill-tie")))
  )

  it.effect("should bring a change to the slate at its scenario time, through the feed log", () =>
    Effect.gen(function* () {
      const slate = yield* LiveSlate
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("119 seconds")

      yield* TestClock.adjust("1 second")

      const inRedZone = yield* tieInRedZone
      const latest = yield* slate.latest
      assert.isTrue(inRedZone)
      assert.isTrue(Option.isSome(latest.seq), "its frames went through the feed log")
    }).pipe(Effect.provide(playing("two-minute-drill-tie")))
  )

  it.effect("should not land a change recorded at 0:07 before 7 s", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)

      yield* TestClock.adjust("6 seconds")

      const [game] = yield* listed("fbs")
      assert.strictEqual(game?.home.score, 0)
    }).pipe(Effect.provide(playingChangedAtSeven()))
  )

  it.effect("should land a change recorded at 0:07 at 7 s, not at the next 10 s", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("6 seconds")

      yield* TestClock.adjust("1 second")

      const [game] = yield* listed("fbs")
      assert.strictEqual(game?.home.score, 7)
    }).pipe(Effect.provide(playingChangedAtSeven()))
  )

  it.effect("should decode a scenario's poll through ESPN's decode to the league's listing", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      const polled = yield* provider.frames.pipe(
        Stream.filter((frame) => frame.source === "poll"),
        Stream.runHead
      )

      const [decoded] = yield* decodedFrames(Option.toArray(polled))

      const [listing] = decoded?.deliveries ?? []
      assert.strictEqual(listing?._tag, "Listing")
      assert.deepStrictEqual(listing?._tag === "Listing" && [listing.league, listing.games.length], [
        "fbs",
        4
      ])
      assert.deepStrictEqual(decoded?.observations, [])
    }).pipe(Effect.provide(scenario("two-minute-drill-tie")))
  )

  it.effect("should have ESPN's decode note a scenario's poll that does not decode, not drop it", () =>
    Effect.gen(function* () {
      const broken: Frame = {
        receivedAt: DateTime.makeUnsafe(0),
        source: "poll",
        channel: "fbs",
        kind: "whole",
        body: "{"
      }

      const [decoded] = yield* decodedFrames([broken])

      assert.deepStrictEqual(decoded?.deliveries, [])
      assert.deepStrictEqual(
        decoded?.observations.map((observation) => observation._tag),
        ["FrameUndecoded"]
      )
    }).pipe(Effect.provide(scenario("two-minute-drill-tie")))
  )

  it.effect(
    "should play a recorded scenario with only its settings and the scenarios, read by ESPN's decode",
    () =>
      Effect.gen(function* () {
        const provider = ScenarioProvider.layer satisfies Layer.Layer<
          Provider,
          ScenarioUnknown | ScenarioUnreadable,
          HubConfig | Scenarios
        >
        const crowded = provider.pipe(
          Layer.provide([
            Scenarios.layer,
            HubConfig.layerTest({ SPORTAL_SCENARIO: "crowded-fourth-quarter" }).pipe(Layer.orDie)
          ]),
          Layer.provide(NodeServices.layer)
        )

        const games = yield* listedBy("fbs").pipe(Effect.provide(crowded))

        assert.isNotEmpty(games)
      })
  )

  it.effect("should hold a scenario's last slate once it has ended", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)

      // Six minutes past its last frame, at 4:00: the slate holds what its last frames said.
      yield* TestClock.adjust("10 minutes")

      const games = yield* listed("fbs")
      const tie = games.find((game) => game.id === "tie-uga-ala")
      assert.deepStrictEqual([tie?.status, tie?.home.score], ["final", 27])
    }).pipe(Effect.provide(playing("two-minute-drill-tie")))
  )

  describe("a scenario's pushed plays", () => {
    it.effect("should push no play's message before the first play's offset", () =>
      Effect.gen(function* () {
        const received = yield* playedFrames((frame) => frame.source === "push" && frame.kind === "change")

        yield* TestClock.adjust("30 seconds")

        const pushedFrames = yield* Ref.get(received)
        assert.deepStrictEqual(pushedFrames.map(receivedMillis), [])
      }).pipe(Effect.provide(scenario("a-drive")), Effect.scoped)
    )

    it.effect("should push a play's message at its offset", () =>
      Effect.gen(function* () {
        const received = yield* playedFrames((frame) => frame.source === "push" && frame.kind === "change")
        yield* TestClock.adjust("30 seconds")

        yield* TestClock.adjust("2 millis")

        const pushedFrames = yield* Ref.get(received)
        assert.deepStrictEqual(pushedFrames.map(receivedMillis), [30_002])
      }).pipe(Effect.provide(scenario("a-drive")), Effect.scoped)
    )

    it.effect("should push each later play's message at its offset", () =>
      Effect.gen(function* () {
        const received = yield* playedFrames((frame) => frame.source === "push" && frame.kind === "change")
        yield* TestClock.adjust("30 seconds")
        yield* TestClock.adjust("2 millis")

        yield* TestClock.adjust("30 seconds")

        const pushedFrames = yield* Ref.get(received)
        assert.deepStrictEqual(pushedFrames.map(receivedMillis), [30_002, 60_002])
      }).pipe(Effect.provide(scenario("a-drive")), Effect.scoped)
    )
  })

  describe("a recorded scenario's frames", () => {
    it.effect("should play each recorded frame at its offset", () =>
      Effect.gen(function* () {
        const received = yield* playedFrames(() => true)

        yield* TestClock.adjust(0)
        yield* TestClock.adjust("30 seconds")

        const frames = yield* Ref.get(received)
        assert.deepStrictEqual(frames.map(scoreAndReceipt), [
          [3, 0],
          [10, 30_000]
        ])
      }).pipe(Effect.provide(scenarioOfTwoPolls()), Effect.scoped)
    )

    it.effect("should start the scenario when its frames are first run, not when its layer is built", () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(scenarioOfTwoPolls())
        yield* TestClock.adjust("35 seconds")

        const first = yield* Provider.use((provider) => Stream.runHead(provider.frames)).pipe(
          Effect.provide(context)
        )

        assert.deepStrictEqual(Option.map(first, scoreAndReceipt), Option.some([3, 35_000]))
      }).pipe(Effect.scoped)
    )

    it.effect("should play polls and pushes in their recorded order", () =>
      Effect.gen(function* () {
        const received = yield* playedFrames(() => true)

        yield* TestClock.adjust(0)
        yield* TestClock.adjust("12 seconds")

        const frames = yield* Ref.get(received)
        assert.deepStrictEqual(
          frames.map(({ source, receivedAt }) => [source, receivedAt.epochMilliseconds]),
          [
            ["poll", 0],
            ["push", 5_000],
            ["push", 12_000]
          ]
        )
      }).pipe(Effect.provide(scenarioOfTwoPushes()), Effect.scoped)
    )
  })

  describe("a recorded scenario's live feed frames", () => {
    it.effect("should push none before its first recorded offset", () =>
      Effect.gen(function* () {
        const received = yield* playedFrames((frame) => frame.source === "push")

        yield* TestClock.adjust("4 seconds")

        const pushedFrames = yield* Ref.get(received)
        assert.deepStrictEqual(pushedFrames.map(receivedMillis), [])
      }).pipe(Effect.provide(scenarioOfTwoPushes()), Effect.scoped)
    )

    it.effect("should push a frame at its recorded offset", () =>
      Effect.gen(function* () {
        const received = yield* playedFrames((frame) => frame.source === "push")
        yield* TestClock.adjust("4 seconds")

        yield* TestClock.adjust("1 second")

        const pushedFrames = yield* Ref.get(received)
        assert.deepStrictEqual(pushedFrames.map(receivedMillis), [5_000])
      }).pipe(Effect.provide(scenarioOfTwoPushes()), Effect.scoped)
    )

    it.effect("should push each later frame at its recorded offset", () =>
      Effect.gen(function* () {
        const received = yield* playedFrames((frame) => frame.source === "push")
        yield* TestClock.adjust("4 seconds")
        yield* TestClock.adjust("1 second")

        yield* TestClock.adjust("7 seconds")

        const pushedFrames = yield* Ref.get(received)
        assert.deepStrictEqual(pushedFrames.map(receivedMillis), [5_000, 12_000])
      }).pipe(Effect.provide(scenarioOfTwoPushes()), Effect.scoped)
    )
  })

  it.effect("should take a recorded push at its offset", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)

      yield* TestClock.adjust("2 seconds")

      const [game] = yield* slateGames
      assert.strictEqual(game?.home.score, 7)
    }).pipe(Effect.provide(playingPushTiedByPoll()))
  )

  it.effect("should let a push at the same game time as a poll win the tie", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("2 seconds")

      yield* TestClock.adjust("10 seconds")

      const [game] = yield* slateGames
      assert.strictEqual(game?.home.score, 7, "the tied poll only refreshed the pushed snapshot")
    }).pipe(Effect.provide(playingPushTiedByPoll()))
  )

  // Plays every committed scenario to its end, one after another: tens of seconds alone, more under a full suite.
  it.effect(
    "should play every committed scenario to a non-empty final slate",
    () =>
      Effect.gen(function* () {
        const scenarios = yield* Scenarios
        const names = yield* scenarios.names

        const finals = yield* Effect.forEach(names, (name) =>
          Effect.gen(function* () {
            const { frames } = yield* scenarios.load(name)
            const games = yield* playedToItsEnd(frames).pipe(
              Effect.provide(playing(name, { from: committed })),
              Effect.scoped
            )

            return { name, games }
          })
        )

        assert.isAbove(names.length, 0)
        for (const { name, games } of finals) assert.isNotEmpty(games, name)
      }).pipe(Effect.provide([Scenarios.layer.pipe(Layer.provide(NodeServices.layer)), NodeServices.layer])),
    120_000
  )

  it.effect("should refuse a name it does not know, listing the names it does", () =>
    Effect.gen(function* () {
      const error = yield* Layer.build(scenario("../../etc/passwd")).pipe(Effect.flip)

      assert.strictEqual(error._tag, "ScenarioUnknown")
      assert.include(error.message, "two-minute-drill-tie")
    }).pipe(Effect.scoped)
  )

  it.effect("should play at the scenario's speed, while the rest of the Hub keeps real time", () =>
    Effect.gen(function* () {
      // The clock and the scenario share one HubConfig, so the same variables build it.
      const env = { SPORTAL_SCENARIO: "two-minute-drill-tie", SPORTAL_SCENARIO_SPEED: "10" }
      const context = yield* Layer.build(
        playing("two-minute-drill-tie", { env }).pipe(
          Layer.provide(ScenarioClock.layer.pipe(Layer.provide(HubConfig.layerTest(env).pipe(Layer.orDie))))
        )
      )

      // 13 real seconds are 130 scenario seconds: the drive is at the 17, in the red zone, since 2:00.
      yield* TestClock.adjust("13 seconds")

      const inRedZone = yield* tieInRedZone.pipe(Effect.provide(context))
      const now = yield* DateTime.now
      assert.isTrue(inRedZone)
      assert.strictEqual(DateTime.toEpochMillis(now), 13_000)
    }).pipe(Effect.scoped)
  )

  it.effect("should log its frames to the scenario's feed log, and nothing to feed.sqlite", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { join } = yield* Path.Path
      const dataDir = yield* fs.makeTempDirectoryScoped()
      const onFile = { env: { SPORTAL_DATA_DIR: dataDir }, scenarioFeedLog: "scenario.sqlite" }

      const logged = yield* loggedAfterAMoment.pipe(
        Effect.provide(playing("two-minute-drill-tie", onFile)),
        Effect.scoped
      )

      const feedSqliteExists = yield* fs.exists(join(dataDir, "feed.sqlite"))
      assert.deepStrictEqual(
        logged.map(({ source, channel }) => [source, channel]),
        [
          ["poll", "fbs"],
          ...["tie-uga-ala", "tie-osu-mich", "tie-tex-ou", "tie-lsu-miss"].map((game) => [
            "push",
            `gp-football-college-football-${game}`
          ])
        ]
      )
      assert.isFalse(feedSqliteExists)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("should replay the scenario's logged frames on a restart, publishing no events for them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* fs.makeTempDirectoryScoped()
      const onFile = { env: { SPORTAL_DATA_DIR: dataDir }, scenarioFeedLog: "scenario.sqlite" }
      yield* playedForThreeMinutes.pipe(
        Effect.provide(playing("two-minute-drill-tie", onFile)),
        Effect.scoped
      )

      const restarted = yield* restartedOn(onFile)

      const latest = yield* restarted.slate.latest
      const events = yield* Ref.get(restarted.events)
      assert.isTrue(Option.isSome(latest.seq), "the frames were replayed")
      assert.strictEqual(events, 0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/**
 * Scenario `name` as the provider, played as `HubMode` plays it and configured by `env` beside its name: a recording
 * read from `from` (this folder's `fixtures/`, unless given), its frames read by `decode` (ESPN's, unless given).
 */
function scenario(name: string, options: Options = {}) {
  const played = ScenarioProvider.layer.pipe(Layer.provide(Scenarios.layerFrom(options.from ?? fixtures)))
  return Option.match(Option.fromUndefinedOr(options.decode), {
    onNone: () => played,
    onSome: (decode) =>
      Layer.effect(
        Provider,
        Effect.map(Provider, (provider) => Provider.of({ frames: provider.frames, decode }))
      ).pipe(Layer.provide(played))
  }).pipe(
    Layer.provideMerge(HubConfig.layerTest({ SPORTAL_SCENARIO: name, ...options.env }).pipe(Layer.orDie)),
    Layer.provide(NodeServices.layer)
  )
}

/**
 * Ingest over `scenario(name, options)`, onto a feed log in memory or on the file `scenarioFeedLog` names in the data
 * directory, with the slate provided to the test.
 */
function playing(name: string, options: Options = {}) {
  return Ingest.layer.pipe(Layer.provideMerge(following(options)), Layer.provide(scenario(name, options)))
}

/**
 * The slate following a feed log in memory or on the file `scenarioFeedLog` names in the data directory, which is
 * provided too.
 */
function following(options: Options) {
  return LiveSlate.layer.pipe(
    Layer.provideMerge(
      options.scenarioFeedLog === undefined
        ? FeedLog.layer.pipe(Layer.provide([Database.layerMemory, NodeCrypto.layer]))
        : FeedLog.layer.pipe(Layer.provide(Database.layerFile(options.scenarioFeedLog)), Layer.orDie)
    ),
    Layer.provide(DateTime.layerCurrentZoneLocal),
    Layer.provide([NodeServices.layer, NodeCrypto.layer])
  )
}

/** How a test sets a scenario up; one HubConfig, from `env`, serves the whole Hub under test. */
type Options = {
  readonly from?: string
  readonly decode?: Provider["Service"]["decode"]
  readonly env?: Record<string, string>
  readonly scenarioFeedLog?: string
}

// Recordings that are test data, not scenarios to play: two-minute-drill-tie and a-drive.
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))

// The committed recordings, in fixtures/scenarios/ at the repository's root.
const committed = fileURLToPath(new URL("../../../../../fixtures/scenarios/", import.meta.url))

/** League `league`'s last listing in the slate. */
function listed(league: LeagueId) {
  return Effect.map(
    LiveSlate.use((slate) => slate.latest),
    (held) => held.listed.get(league) ?? []
  )
}

const tieInRedZone = Effect.map(
  listed("fbs"),
  (games) => games.find((game) => game.id === "tie-uga-ala")?.situation?.inRedZone() === true
)

/** Playing a recording whose only game scores 7 at 0:07, read by the snapshot feed's decode. */
function playingChangedAtSeven() {
  return fromRecording("seven", [polledAt(0, [scoring(0)]), polledAt(7, [scoring(7)])], (from) =>
    playing("seven", { from, decode: TestSnapshotFeed.decode })
  )
}

/** `layerOf` the folder that recorded scenario `name`, of `frames`, is written to, for as long as the layer lives. */
function fromRecording<A, E, R>(
  name: string,
  frames: ReadonlyArray<Effect.Effect<Frame>>,
  layerOf: (from: string) => Layer.Layer<A, E, R>
) {
  return Layer.unwrap(Effect.map(recorded(name, frames), layerOf)).pipe(Layer.provide(NodeServices.layer))
}

/** Writes recorded scenario `name`, of `frames`, to a fresh folder, and gives the folder. */
function recorded(name: string, frames: ReadonlyArray<Effect.Effect<Frame>>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped()
    const made = yield* Effect.all(frames)
    const lines = made.map((frame) => `${Schema.encodeSync(Schema.fromJsonString(Frame))(frame)}\n`)
    const bytes = yield* Gzip.compress(lines.join(""))

    yield* fs.writeFile(path.join(dir, `${name}.frames.jsonl.gz`), bytes)

    return dir
  })
}

/** An fbs poll of `games` as the snapshot feed says it, as recorded `seconds` into the recording. */
function polledAt(seconds: number, games: ReadonlyArray<GameSnapshot>) {
  return recordedAs(seconds, "poll", pushed(Delivery.cases.Listing.make({ league: "fbs", games }), "fbs"))
}

/**
 * `said` as a recording from `source` holds it, received `seconds` into the recording. The frame is synthetic: a snapshot
 * feed body under an ESPN source's name, for a recorded scenario read by `TestSnapshotFeed.decode`.
 */
function recordedAs(seconds: number, source: "poll" | "push", said: Effect.Effect<Frame>) {
  return Effect.map(
    said,
    (frame) =>
      new Frame({
        ...frame,
        receivedAt: DateTime.add(recordedAt, { seconds }),
        source,
        kind: source === "poll" ? "whole" : "change"
      })
  )
}

// When the recorded scenarios here were recorded.
const recordedAt = DateTime.makeUnsafe("2026-10-04T18:00:00Z")

function scoring(points: number) {
  return liveSnapshot({ id: GameId.make("1"), home: { team: team("HOME"), score: points } })
}

/** Forks the provider's frames, keeping each frame `keep` passes in the Ref it gives. */
function playedFrames(keep: (frame: Frame) => boolean) {
  return Effect.gen(function* () {
    const provider = yield* Provider
    const received = yield* Ref.make<ReadonlyArray<Frame>>([])

    yield* provider.frames.pipe(
      Stream.filter(keep),
      Stream.runForEach((frame) => Ref.update(received, (all) => [...all, frame])),
      Effect.forkScoped({ startImmediately: true })
    )

    return received
  })
}

/** When `frame` was received, in milliseconds. */
function receivedMillis(frame: Frame) {
  return frame.receivedAt.epochMilliseconds
}

/** A recording polled at 0:00 with its game at 3 points and at 0:30 with it at 10, as the provider. */
function scenarioOfTwoPolls() {
  return fromRecording("two-polls", [polledAt(0, [scoring(3)]), polledAt(30, [scoring(10)])], (from) =>
    scenario("two-polls", { from })
  )
}

/** A snapshot feed listing frame's first game's home score and its receive instant. */
function scoreAndReceipt({ body, receivedAt }: Frame) {
  return [JSON.parse(body).games[0].home.score, receivedAt.epochMilliseconds]
}

/** A recording polled at 0:00 and pushed at 0:05 and 0:12, as the provider. */
function scenarioOfTwoPushes() {
  return fromRecording(
    "pushes",
    [polledAt(0, [scoring(0)]), pushedAt(5, scoring(3)), pushedAt(12, scoring(7))],
    (from) => scenario("pushes", { from })
  )
}

/** A live feed frame of `game` pushed, as the snapshot feed says it, as recorded `seconds` into the recording. */
function pushedAt(seconds: number, game: GameSnapshot) {
  return recordedAs(
    seconds,
    "push",
    pushed(Delivery.cases.Snapshot.make({ snapshot: game, from: "push" }), "fbs")
  )
}

/**
 * Playing a recording that pushes 7 points at 0:01 and polls 0 points at the same game time at 0:10, read by the
 * snapshot feed's decode.
 */
function playingPushTiedByPoll() {
  return fromRecording(
    "tie",
    [polledAt(0, [scoring(0)]), pushedAt(1, scoring(7)), polledAt(10, [scoring(0)])],
    (from) => playing("tie", { from, decode: TestSnapshotFeed.decode })
  )
}

/** The slate's games, leagues in order. */
const slateGames = Effect.map(
  LiveSlate.use((slate) => slate.latest),
  (held) => held.listedGames(LeagueId.literals)
)

/** The slate's games once the scenario of `frames` has played from its first frame to its last. */
function playedToItsEnd(frames: ReadonlyArray<Frame>) {
  return Effect.gen(function* () {
    const last = frames.at(-1)?.receivedAt ?? DateTime.makeUnsafe(0)
    const length = DateTime.distance(frames[0]?.receivedAt ?? last, last)

    yield* TestClock.adjust(0)
    yield* TestClock.adjust(length)

    return yield* slateGames
  })
}

/** The feed log's frames 100 ms into the scenario. */
const loggedAfterAMoment = Effect.gen(function* () {
  yield* TestClock.adjust(0)
  yield* TestClock.adjust("100 millis")
  const feedLog = yield* FeedLog

  // The log compresses and writes on the event loop, so this waits in real time.
  return yield* Stream.runCollect(feedLog.replay(DateTime.makeUnsafe(0))).pipe(
    Effect.repeat({ until: (frames) => frames.length >= 5, schedule: Schedule.spaced("5 millis") }),
    Effect.timeout("1 second"),
    TestClock.withLive
  )
})

const playedForThreeMinutes = Effect.gen(function* () {
  yield* TestClock.adjust(0)
  yield* TestClock.adjust("3 minutes")
})

/**
 * The slate following the scenario's feed log `onFile` again, its events counted from the start, with Ingest playing
 * two-minute-drill-tie onto it: the Hub restarted, for as long as the scope lives.
 */
function restartedOn(onFile: Options) {
  return Effect.gen(function* () {
    const context = yield* Layer.build(
      following(onFile).pipe(Layer.provide(scenario("two-minute-drill-tie", onFile)))
    )
    const slate = Context.get(context, LiveSlate)
    const events = yield* Ref.make(0)

    yield* slate.events.pipe(
      Stream.runForEach(() => Ref.update(events, (count) => count + 1)),
      Effect.forkScoped({ startImmediately: true })
    )
    yield* Layer.build(
      Ingest.layer.pipe(
        Layer.provide(scenario("two-minute-drill-tie", onFile)),
        Layer.provide(Layer.succeedContext(context))
      )
    )

    return { slate, events }
  })
}
