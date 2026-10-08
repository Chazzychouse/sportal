import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import type { LeagueId } from "@sportal/domain/League"
import { Clock, DateTime, Effect, FileSystem, Layer, Option, Path, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Frame } from "../../Frame.ts"
import { HubConfig } from "../../HubConfig.ts"
import * as ScenarioClock from "../../scenario/ScenarioClock.ts"
import {
  Scenario,
  Scenarios,
  type ScenarioUnknown,
  type ScenarioUnreadable
} from "../../scenario/Scenarios.ts"
import { Board } from "../../slate/Board.ts"
import { Delivery } from "../../slate/Delivery.ts"
import { recordingLogs } from "../../TestTelemetry.ts"
import { Provider } from "../Provider.ts"
import { listedBy } from "../TestProvider.ts"
import { topicOf } from "./FastCastTopic.ts"
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

  it.effect("should bring a change to the slate at its scenario time", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("119 seconds")

      yield* TestClock.adjust("1 second")

      const inRedZone = yield* tieInRedZone
      assert.isTrue(inRedZone)
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

      const polled = yield* Stream.runHead(provider.deliveries)

      const [listing] = Option.getOrElse(polled, () => [])
      assert.strictEqual(listing?._tag, "Listing")
      assert.deepStrictEqual(listing?._tag === "Listing" && [listing.league, listing.games.length], [
        "fbs",
        4
      ])
    }).pipe(Effect.provide(scenario("two-minute-drill-tie")))
  )

  it.effect("should give a scenario's poll that does not decode no deliveries, not drop it", () =>
    Effect.gen(function* () {
      const provider = yield* Provider

      const first = yield* Stream.runHead(provider.deliveries)

      assert.deepStrictEqual(first, Option.some([]))
    }).pipe(Effect.provide(scenarioOfABrokenPoll()))
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
          Layer.provide(Scenarios.layer),
          Layer.provideMerge(
            HubConfig.layerTest({ SPORTAL_SCENARIO: "crowded-fourth-quarter" }).pipe(Layer.orDie)
          ),
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
        const received = yield* played(addsPlays)

        yield* TestClock.adjust("30 seconds")

        const pushes = yield* Ref.get(received)
        assert.deepStrictEqual(pushes.map(receivedMillis), [])
      }).pipe(Effect.provide(scenario("a-drive")), Effect.scoped)
    )

    it.effect("should push a play's message at its offset", () =>
      Effect.gen(function* () {
        const received = yield* played(addsPlays)
        yield* TestClock.adjust("30 seconds")

        yield* TestClock.adjust("2 millis")

        const pushes = yield* Ref.get(received)
        assert.deepStrictEqual(pushes.map(receivedMillis), [30_002])
      }).pipe(Effect.provide(scenario("a-drive")), Effect.scoped)
    )

    it.effect("should push each later play's message at its offset", () =>
      Effect.gen(function* () {
        const received = yield* played(addsPlays)
        yield* TestClock.adjust("30 seconds")
        yield* TestClock.adjust("2 millis")

        yield* TestClock.adjust("30 seconds")

        const pushes = yield* Ref.get(received)
        assert.deepStrictEqual(pushes.map(receivedMillis), [30_002, 60_002])
      }).pipe(Effect.provide(scenario("a-drive")), Effect.scoped)
    )
  })

  describe("a recorded scenario's frames", () => {
    it.effect("should play each recorded frame at its offset", () =>
      Effect.gen(function* () {
        const received = yield* played(() => true)

        yield* TestClock.adjust(0)
        yield* TestClock.adjust("30 seconds")

        const frames = yield* Ref.get(received)
        assert.deepStrictEqual(frames.map(scoreAndReceipt), [
          [3, 0],
          [10, 30_000]
        ])
      }).pipe(Effect.provide(scenarioOfTwoPolls()), Effect.scoped)
    )

    it.effect("should end its frames, logged, when the scenario's stream fails partway", () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        const received = yield* played(() => true)

        yield* TestClock.adjust(0)
        yield* TestClock.adjust("1 minute")

        const frames = yield* Ref.get(received)
        const errors = logs.filter(({ level }) => level === "Error")
        assert.deepStrictEqual(frames.map(scoreAndReceipt), [[3, 0]])
        assert.lengthOf(errors, 1)
        assert.include(errors[0]?.message, "broken.frames.jsonl.gz")
      }).pipe(Effect.provide([scenarioBrokenAfterAPoll(), layer]), Effect.scoped)
    })

    it.effect("should start the scenario when its frames are first run, not when its layer is built", () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(scenarioOfTwoPolls())
        yield* TestClock.adjust("35 seconds")

        const received = yield* played(() => true).pipe(Effect.provide(context))
        yield* TestClock.adjust(0)

        const first = yield* Ref.get(received)
        assert.deepStrictEqual(first.map(scoreAndReceipt), [[3, 35_000]])
      }).pipe(Effect.scoped)
    )

    it.effect("should play polls and pushes in their recorded order", () =>
      Effect.gen(function* () {
        const received = yield* played(() => true)

        yield* TestClock.adjust(0)
        yield* TestClock.adjust("12 seconds")

        const all = yield* Ref.get(received)
        assert.deepStrictEqual(
          all.map(({ at, deliveries }) => [deliveries.map(({ _tag }) => _tag), at]),
          [
            [["Listing"], 0],
            [["Snapshot"], 5_000],
            [["Snapshot"], 12_000]
          ]
        )
      }).pipe(Effect.provide(scenarioOfTwoPushes()), Effect.scoped)
    )
  })

  describe("a recorded scenario's live feed frames", () => {
    it.effect("should push none before its first recorded offset", () =>
      Effect.gen(function* () {
        const received = yield* played(pushesASnapshot)

        yield* TestClock.adjust("4 seconds")

        const pushes = yield* Ref.get(received)
        assert.deepStrictEqual(pushes.map(receivedMillis), [])
      }).pipe(Effect.provide(scenarioOfTwoPushes()), Effect.scoped)
    )

    it.effect("should push a frame at its recorded offset", () =>
      Effect.gen(function* () {
        const received = yield* played(pushesASnapshot)
        yield* TestClock.adjust("4 seconds")

        yield* TestClock.adjust("1 second")

        const pushes = yield* Ref.get(received)
        assert.deepStrictEqual(pushes.map(receivedMillis), [5_000])
      }).pipe(Effect.provide(scenarioOfTwoPushes()), Effect.scoped)
    )

    it.effect("should push each later frame at its recorded offset", () =>
      Effect.gen(function* () {
        const received = yield* played(pushesASnapshot)
        yield* TestClock.adjust("4 seconds")
        yield* TestClock.adjust("1 second")

        yield* TestClock.adjust("7 seconds")

        const pushes = yield* Ref.get(received)
        assert.deepStrictEqual(pushes.map(receivedMillis), [5_000, 12_000])
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
      assert.strictEqual(game?.home.score, 7, "the tied poll did not replace the pushed snapshot")
    }).pipe(Effect.provide(playingPushTiedByPoll()))
  )

  // Plays every committed scenario to its end, one after another: tens of seconds alone, more under a full suite.
  it.effect(
    "should play every committed scenario to a non-empty final slate",
    () =>
      Effect.gen(function* () {
        const names = yield* Scenarios.use((scenarios) => scenarios.names).pipe(
          Effect.provide(committedScenarios)
        )

        const finals = yield* Effect.forEach(names, (name) =>
          Effect.gen(function* () {
            const frames = yield* Scenarios.use((scenarios) => scenarios.load(name)).pipe(
              Effect.flatMap((loaded) => Stream.runCollect(loaded.frames)),
              Effect.provide(committedScenarios)
            )
            const games = yield* playedToItsEnd(frames).pipe(
              Effect.provide(playing(name, { from: committed })),
              Effect.scoped
            )

            return { name, games }
          })
        )

        assert.isAbove(names.length, 0)
        for (const { name, games } of finals) assert.isNotEmpty(games, name)
      }).pipe(Effect.provide(NodeServices.layer)),
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
})

/**
 * Scenario `name` as the provider, played as `HubMode` plays it and configured by `env` beside its name: a recording
 * read from `from` (this folder's `fixtures/`, unless given).
 */
function scenario(name: string, options: Options = {}) {
  return ScenarioProvider.layer.pipe(
    Layer.provide(readAhead(options.from ?? fixtures)),
    Layer.provideMerge(HubConfig.layerTest({ SPORTAL_SCENARIO: name, ...options.env }).pipe(Layer.orDie)),
    Layer.provide(NodeServices.layer)
  )
}

/**
 * The recordings in `from`, each read whole when it is loaded, a failure partway kept in its place: its frames then play
 * on the test clock alone, with no file read waiting on real time.
 */
function readAhead(from: string) {
  return Layer.effect(
    Scenarios,
    Effect.gen(function* () {
      const scenarios = yield* Scenarios

      const load = Effect.fnUntraced(function* (name: string) {
        const loaded = yield* scenarios.load(name)
        const read = yield* Stream.runCollect(Stream.result(loaded.frames))
        const frames = Stream.fromIterable(read).pipe(Stream.mapEffect(Effect.fromResult))
        return new Scenario({ ...loaded, frames })
      })

      return Scenarios.of({ names: scenarios.names, load })
    })
  ).pipe(Layer.provide(Scenarios.layerFrom(from)))
}

/** The board taking `scenario(name, options)`, its slate provided to the test. */
function playing(name: string, options: Options = {}) {
  return Board.layer.pipe(Layer.provide(scenario(name, options)))
}

/** How a test sets a scenario up; one HubConfig, from `env`, serves the whole Hub under test. */
type Options = {
  readonly from?: string
  readonly env?: Record<string, string>
}

// Recordings that are test data, not scenarios to play: two-minute-drill-tie and a-drive.
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))

// The committed recordings, in fixtures/scenarios/ at the repository's root.
const committed = fileURLToPath(new URL("../../../../../fixtures/scenarios/", import.meta.url))

// The committed recordings as Scenarios reads them, apart from a Hub under test.
const committedScenarios = Scenarios.layer.pipe(Layer.provide(NodeServices.layer))

/** League `league`'s listed games in the slate. */
function listed(league: LeagueId) {
  return Effect.map(
    Board.use((board) => board.latest),
    (slate) => slate.games.flatMap(({ snapshot }) => (snapshot.league === league ? [snapshot] : []))
  )
}

const tieInRedZone = Effect.map(
  listed("fbs"),
  (games) => games.find((game) => game.id === "tie-uga-ala")?.situation?.inRedZone() === true
)

/** Playing a recording whose only game scores 7 at 0:07. */
function playingChangedAtSeven() {
  return fromRecording("seven", [polledAt(0, 0), polledAt(7, 7)], (from) => playing("seven", { from }))
}

/**
 * `layerOf` the folder that recorded scenario `name`, of `frames` and then the lines `after`, is written to, for as long
 * as the layer lives.
 */
function fromRecording<A, E, R>(
  name: string,
  frames: ReadonlyArray<Frame>,
  layerOf: (from: string) => Layer.Layer<A, E, R>,
  after: ReadonlyArray<string> = []
) {
  return Layer.unwrap(Effect.map(recorded(name, frames, after), layerOf)).pipe(
    Layer.provide(NodeServices.layer)
  )
}

/** Writes recorded scenario `name`, of `frames` and then the lines `after`, to a fresh folder, and gives the folder. */
function recorded(name: string, frames: ReadonlyArray<Frame>, after: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped()
    const lines = [...frames.map((frame) => Schema.encodeSync(Schema.fromJsonString(Frame))(frame)), ...after]
    const bytes = gzipSync(lines.map((line) => `${line}\n`).join(""))

    yield* fs.writeFile(path.join(dir, `${name}.frames.jsonl.gz`), bytes)

    return dir
  })
}

/** An FBS scoreboard poll of game 1 with its home team on `points`, as recorded `seconds` into the recording. */
function polledAt(seconds: number, points: number) {
  return new Frame({
    receivedAt: DateTime.add(recordedAt, { seconds }),
    source: "poll",
    channel: "fbs",
    kind: "whole",
    body: JSON.stringify({ events: [gameOn(points)] })
  })
}

/**
 * A FastCast checkpoint of the FBS scoreboard topic, its one event game 1 with its home team on `points`, as recorded
 * `seconds` into the recording.
 */
function pushedAt(seconds: number, points: number) {
  return new Frame({
    receivedAt: DateTime.add(recordedAt, { seconds }),
    source: "push",
    channel: topicOf("fbs"),
    kind: "whole",
    number: seconds,
    body: JSON.stringify({ sports: [{ leagues: [{ events: [gameOn(points)] }] }] })
  })
}

/** Game 1 as ESPN sends it, in the first quarter at 10:00, its home team on `points`. */
function gameOn(points: number) {
  const competitor = (homeAway: "home" | "away", id: string, score: number) => ({
    homeAway,
    score: String(score),
    team: { id, abbreviation: id, displayName: id, location: id, shortDisplayName: id }
  })
  return {
    id: "1",
    uid: "s:20~l:23~e:1~c:1",
    date: "2026-10-04T17:45:00.000Z",
    status: { period: 1, displayClock: "10:00", type: { name: "STATUS_IN_PROGRESS", state: "in" } },
    competitions: [
      { geoBroadcasts: [], competitors: [competitor("home", "HOME", points), competitor("away", "AWAY", 0)] }
    ]
  }
}

// When the recorded scenarios here were recorded.
const recordedAt = DateTime.makeUnsafe("2026-10-04T18:00:00Z")

/** Forks the provider's deliveries, keeping each frame's that `keep` passes, and when they came, in the Ref it gives. */
function played(keep: (deliveries: ReadonlyArray<Delivery>) => boolean) {
  return Effect.gen(function* () {
    const provider = yield* Provider
    const received = yield* Ref.make<ReadonlyArray<Played>>([])

    yield* provider.deliveries.pipe(
      Stream.filter(keep),
      Stream.mapEffect((deliveries) => Effect.map(Clock.currentTimeMillis, (at) => ({ at, deliveries }))),
      Stream.runForEach((one) => Ref.update(received, (all) => [...all, one])),
      Effect.forkScoped({ startImmediately: true })
    )

    return received
  })
}

/** One frame's deliveries, and when, in milliseconds on the test clock, the provider gave them. */
interface Played {
  readonly at: number
  readonly deliveries: ReadonlyArray<Delivery>
}

/** Whether `deliveries` say a game's plays, with at least one play: a pushed play's message, not its topic's checkpoint. */
function addsPlays(deliveries: ReadonlyArray<Delivery>) {
  return deliveries.some((delivery) => Delivery.guards.Plays(delivery) && delivery.plays.length > 0)
}

/** Whether `deliveries` say a pushed snapshot. */
function pushesASnapshot(deliveries: ReadonlyArray<Delivery>) {
  return deliveries.some(Delivery.guards.Snapshot)
}

/** When the provider gave `played`, in milliseconds. */
function receivedMillis(played: Played) {
  return played.at
}

/** A recording polled at 0:00 with its game at 3 points and at 0:30 with it at 10, as the provider. */
function scenarioOfTwoPolls() {
  return fromRecording("two-polls", [polledAt(0, 3), polledAt(30, 10)], (from) =>
    scenario("two-polls", { from })
  )
}

/** A recording polled at 0:00 with its game at 3 points, then a line that is not a frame, as the provider. */
function scenarioBrokenAfterAPoll() {
  return fromRecording("broken", [polledAt(0, 3)], (from) => scenario("broken", { from }), ["not a frame"])
}

/** A recording polled at 0:00 with a body that is not a scoreboard, then at 0:30 with its game at 10, as the provider. */
function scenarioOfABrokenPoll() {
  return fromRecording(
    "broken-poll",
    [new Frame({ ...polledAt(0, 0), body: "{" }), polledAt(30, 10)],
    (from) => scenario("broken-poll", { from })
  )
}

/** The home score of the first game a listing `played` says, and when the provider gave it. */
function scoreAndReceipt({ at, deliveries }: Played) {
  const [listing] = deliveries.filter(Delivery.guards.Listing)
  return [listing?.games[0]?.home.score, at]
}

/** A recording polled at 0:00 and pushed at 0:05 and 0:12, as the provider. */
function scenarioOfTwoPushes() {
  return fromRecording("pushes", [polledAt(0, 0), pushedAt(5, 3), pushedAt(12, 7)], (from) =>
    scenario("pushes", { from })
  )
}

/** Playing a recording that pushes 7 points at 0:01 and polls 0 points at the same game time at 0:10. */
function playingPushTiedByPoll() {
  return fromRecording("tie", [polledAt(0, 0), pushedAt(1, 7), polledAt(10, 0)], (from) =>
    playing("tie", { from })
  )
}

/** The slate's games, leagues in order. */
const slateGames = Effect.map(
  Board.use((board) => board.latest),
  (held) => held.games.map(({ snapshot }) => snapshot)
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
