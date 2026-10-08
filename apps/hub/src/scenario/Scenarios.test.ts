import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { GameDay } from "@sportal/domain/GameDay"
import type { GameEvent } from "@sportal/domain/GameEvent"
import {
  Array as Arr,
  type Cause,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
  Stream
} from "effect"
import * as Database from "../Database.ts"
import { Frame } from "../Frame.ts"
import { FeedLog } from "../feed-log/FeedLog.ts"
import * as Gzip from "../Gzip.ts"
import { HubConfig } from "../HubConfig.ts"
import * as EspnDecoder from "../provider/espn/EspnDecoder.ts"
import { type Decoded, Provider } from "../provider/Provider.ts"
import { decodedFrames } from "../provider/TestProvider.ts"
import type { SlateObservation } from "../slate/SlateObservation.ts"
import { takenOf } from "../TestBoard.ts"
import { Scenarios } from "./Scenarios.ts"

describe("Scenarios", () => {
  it.effect("should list the committed recordings, sorted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const files = yield* fs.readDirectory(fixtures)
      const recorded = files
        .filter((file) => file.endsWith(".frames.jsonl.gz"))
        .map((file) => file.slice(0, -".frames.jsonl.gz".length))
      const scenarios = yield* Scenarios

      const names = yield* scenarios.names

      assert.deepStrictEqual(names, recorded.toSorted())
      assert.include(names, "late-go-ahead-cascade")
      assert.include(names, "uk-sc-tying-drive-solo")
    }).pipe(Effect.provide([committed, NodeServices.layer]))
  )

  it.effect("should load a frames file in order, starting at its first frame's receipt", () =>
    Effect.gen(function* () {
      const scenarios = yield* Scenarios

      const scenario = yield* scenarios.load("late-go-ahead-cascade")
      const frames = yield* Stream.runCollect(scenario.frames)

      const received = frames.map(({ receivedAt }) => receivedAt.epochMilliseconds)
      assert.isAbove(frames.length, 100)
      assert.deepStrictEqual(
        received,
        received.toSorted((a, b) => a - b)
      )
      assert.deepStrictEqual(scenario.origin, DateTime.makeUnsafe("2026-10-04T20:00:07.418Z"))
    }).pipe(Effect.provide(committed))
  )

  it.effect("should load a recording by its name, the first of its frames a poll at its start", () =>
    Effect.gen(function* () {
      const scenarios = yield* Scenarios

      const scenario = yield* scenarios.load("two-polls")
      const [first] = yield* Stream.runCollect(scenario.frames)

      assert.strictEqual(scenario.name, "two-polls")
      assert.deepStrictEqual([first?.source, first?.kind], ["poll", "whole"])
      assert.deepStrictEqual(scenario.origin, DateTime.makeUnsafe("2026-10-03T16:00:00Z"))
    }).pipe(Effect.provide(scenariosRecording("two-polls.frames.jsonl.gz", gzipped(twoPolls))))
  )

  it.effect("should give origin without running the frames", () =>
    Effect.gen(function* () {
      const scenarios = yield* Scenarios

      const scenario = yield* scenarios.load("bad-line")

      assert.deepStrictEqual(scenario.origin, DateTime.makeUnsafe("2026-10-03T16:00:00Z"))
    }).pipe(Effect.provide(scenariosRecording("bad-line.frames.jsonl.gz", gzippedThenBadLine(twoPolls))))
  )

  it.effect("should fail the stream partway on a bad line", () =>
    Effect.gen(function* () {
      const scenarios = yield* Scenarios
      const scenario = yield* scenarios.load("bad-line")

      const error = yield* Stream.runCollect(scenario.frames).pipe(Effect.flip)

      assert.strictEqual(error._tag, "ScenarioUnreadable")
    }).pipe(Effect.provide(scenariosRecording("bad-line.frames.jsonl.gz", gzippedThenBadLine(twoPolls))))
  )

  it.effect("should fail ScenarioUnreadable for a file with no frames", () =>
    Effect.gen(function* () {
      const scenarios = yield* Scenarios

      const error = yield* scenarios.load("empty").pipe(Effect.flip)

      assert.strictEqual(error._tag, "ScenarioUnreadable")
    }).pipe(Effect.provide(scenariosRecording("empty.frames.jsonl.gz", gzipped([]))))
  )

  // Every committed scenario, decoded and taken whole through ESPN's decode once for these
  // tests: tens of seconds alone, and more under a full suite's load.
  it.layer(everyScenarioPlayed, { timeout: "120 seconds" })(
    "every scenario, taken whole through ESPN's decode",
    (it) => {
      it.effect("should decode, observing nothing but Received, Pushed and PlayTypeUnknown", () =>
        Effect.gen(function* () {
          const played = yield* EveryScenarioPlayed

          for (const { name, decoded } of played) {
            const unexpected = decoded.flatMap(({ observations }) =>
              observations
                .filter(({ _tag }) => _tag !== "Received" && _tag !== "Pushed" && _tag !== "PlayTypeUnknown")
                .map(({ _tag }) => _tag)
            )
            assert.deepStrictEqual(unexpected, [], `${name} decodes`)
          }
        })
      )

      it.effect("should play some play", () =>
        Effect.gen(function* () {
          const played = yield* EveryScenarioPlayed

          for (const { name, events } of played) {
            assert.isAbove(playsOf(events).length, 0, `${name} plays`)
          }
        })
      )

      it.effect("should play each of a game's plays once", () =>
        Effect.gen(function* () {
          const played = yield* EveryScenarioPlayed

          for (const { name, decoded, events } of played) {
            const plays = playsOf(events)
            for (const game of new Set(deliveredPlaysOf(decoded).map(({ game }) => game))) {
              const playedIds = plays.filter((one) => one.game === game).map(({ play }) => play)
              assert.strictEqual(
                new Set(playedIds).size,
                playedIds.length,
                `${name}: ${game} plays each play once`
              )
            }
          }
        })
      )

      it.effect("should play every play delivered for a game it has not let go", () =>
        Effect.gen(function* () {
          const played = yield* EveryScenarioPlayed

          for (const { name, decoded, events, observations } of played) {
            const plays = playsOf(events)
            const delivered = deliveredPlaysOf(decoded)
            const { stopped } = letGo(observations)
            for (const game of new Set(delivered.map(({ game }) => game))) {
              if (stopped.has(game)) continue
              const playedIds = plays.filter((one) => one.game === game).map(({ play }) => play)
              const deliveredIds = new Set(
                delivered.filter((one) => one.game === game).map(({ play }) => play)
              )
              assert.strictEqual(
                playedIds.length,
                deliveredIds.size,
                `${name}: ${game} plays every delivered play`
              )
            }
          }
        })
      )

      // ESPN edits a game's plays after it ends; those reach a slate that has let the game go, and are dropped.
      it.effect("should drop none before the game is let go", () =>
        Effect.gen(function* () {
          const played = yield* EveryScenarioPlayed

          for (const { name, observations } of played) {
            const { droppedEarly } = letGo(observations)
            assert.deepStrictEqual(droppedEarly, [], `${name} drops none before the game is let go`)
          }
        })
      )
    }
  )

  it.effect("should fail ScenarioUnreadable for a file that is not gzip'd frames", () =>
    Effect.gen(function* () {
      const scenarios = yield* Scenarios

      const error = yield* scenarios.load("broken").pipe(Effect.flip)

      assert.strictEqual(error._tag, "ScenarioUnreadable")
    }).pipe(
      Effect.provide(
        scenariosRecording("broken.frames.jsonl.gz", Effect.succeed(new TextEncoder().encode("not gzip")))
      )
    )
  )

  it.effect("should fail ScenarioUnknown for a name no recording has, listing the recordings", () =>
    Effect.gen(function* () {
      const scenarios = yield* Scenarios

      const error = yield* scenarios.load("nope").pipe(Effect.flip)

      assert.strictEqual(error._tag, "ScenarioUnknown")
      assert.include(error._tag === "ScenarioUnknown" ? error.known : [], "late-go-ahead-cascade")
      assert.include(error.message, "late-go-ahead-cascade")
      assert.include(error.message, "bogus-clock-two-minute")
    }).pipe(Effect.provide(committed))
  )

  it.effect("should list the feed log's game days after the fixtures", () =>
    Effect.gen(function* () {
      const dataDir = yield* dataDirLogging([
        poll("start", "2026-10-04T04:00:00"),
        poll("after midnight", "2026-10-05T03:00:00"),
        poll("next week", "2026-10-11T12:00:00")
      ])
      const fs = yield* FileSystem.FileSystem
      const files = yield* fs.readDirectory(fixtures)
      const recorded = files
        .filter((file) => file.endsWith(".frames.jsonl.gz"))
        .map((file) => file.slice(0, -".frames.jsonl.gz".length))

      const names = yield* Scenarios.use((scenarios) => scenarios.names).pipe(
        Effect.provide(scenariosIn(dataDir))
      )

      assert.deepStrictEqual(names, [...recorded.toSorted(), "2026-10-04", "2026-10-11"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("should list no days, and create no feed.sqlite, when the data directory has none", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* fs.makeTempDirectoryScoped()

      const names = yield* Scenarios.use((scenarios) => scenarios.names).pipe(
        Effect.provide(scenariosIn(dataDir))
      )

      const files = yield* fs.readDirectory(dataDir)
      assert.include(names, "late-go-ahead-cascade")
      assert.isFalse(names.some((name) => Schema.is(GameDay)(name)))
      assert.deepStrictEqual(files, [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("should load a day's frames in order, none from before 04:00 or from 04:00 the next day", () =>
    Effect.gen(function* () {
      const dataDir = yield* dataDirLogging([
        poll("the day before", "2026-10-04T03:59:00"),
        poll("start", "2026-10-04T04:00:00"),
        poll("evening", "2026-10-04T23:00:00"),
        poll("late", "2026-10-05T03:59:59"),
        poll("the day after", "2026-10-05T04:00:00")
      ])

      const frames = yield* framesOfDay("2026-10-04").pipe(Effect.provide(scenariosIn(dataDir)))

      assert.deepStrictEqual(frames, [
        poll("start", "2026-10-04T04:00:00"),
        poll("evening", "2026-10-04T23:00:00"),
        poll("late", "2026-10-05T03:59:59")
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("should receive a looked-back checkpoint at the day's start", () =>
    Effect.gen(function* () {
      const dataDir = yield* dataDirLogging([
        checkpoint("gp-1", "2026-10-04T03:00:00"),
        poll("start", "2026-10-04T04:00:00")
      ])

      const frames = yield* framesOfDay("2026-10-04").pipe(Effect.provide(scenariosIn(dataDir)))

      assert.deepStrictEqual(frames, [
        checkpoint("gp-1", "2026-10-04T04:00:00"),
        poll("start", "2026-10-04T04:00:00")
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("should start a day at its first frame's receipt", () =>
    Effect.gen(function* () {
      const dataDir = yield* dataDirLogging([poll("kickoff", "2026-10-04T13:00:00")])

      const scenario = yield* Scenarios.use((scenarios) => scenarios.load("2026-10-04")).pipe(
        Effect.provide(scenariosIn(dataDir))
      )

      assert.strictEqual(scenario.name, "2026-10-04")
      assert.deepStrictEqual(scenario.origin, inNewYork("2026-10-04T13:00:00"))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("should fail ScenarioUnknown for a day with no frames, listing the days there are", () =>
    Effect.gen(function* () {
      const dataDir = yield* dataDirLogging([poll("start", "2026-10-04T04:00:00")])

      const error = yield* Scenarios.use((scenarios) => scenarios.load("2026-10-06")).pipe(
        Effect.provide(scenariosIn(dataDir)),
        Effect.flip
      )

      assert.strictEqual(error._tag, "ScenarioUnknown")
      assert.include(error.message, "2026-10-04")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("should append nothing to the day's feed log", () =>
    Effect.gen(function* () {
      const dataDir = yield* dataDirLogging([
        poll("start", "2026-10-04T04:00:00"),
        poll("evening", "2026-10-04T23:00:00")
      ])

      yield* framesOfDay("2026-10-04").pipe(Effect.provide(scenariosIn(dataDir)))

      const logged = yield* FeedLog.use((log) => Stream.runCount(log.replay(DateTime.makeUnsafe(0)))).pipe(
        Effect.provide(FeedLog.layerInDataDir.pipe(Layer.provide(configIn(dataDir))))
      )
      assert.strictEqual(logged, 2)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

const fixtures = fileURLToPath(new URL("../../../../fixtures/scenarios/", import.meta.url))

// The committed recordings, beside a data directory that does not exist.
const committed = Scenarios.layer.pipe(
  Layer.provide([HubConfig.layerTest({}).pipe(Layer.orDie), DateTime.layerCurrentZoneLocal]),
  Layer.provide(NodeServices.layer)
)

const newYork = DateTime.layerCurrentZone(DateTime.zoneMakeNamedUnsafe("America/New_York"))

function configIn(dataDir: string) {
  return HubConfig.layerTest({ SPORTAL_DATA_DIR: dataDir }).pipe(Layer.orDie)
}

/** The committed recordings, and the game days, in New York, of the feed log in `dataDir`. */
function scenariosIn(dataDir: string) {
  return Scenarios.layer.pipe(Layer.provide([configIn(dataDir), newYork]), Layer.provide(NodeServices.layer))
}

/** A fresh data directory whose `feed.sqlite` has logged `frames`, closed once they are written. */
function dataDirLogging(frames: ReadonlyArray<Frame>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dataDir = yield* fs.makeTempDirectoryScoped()
    const logged = FeedLog.layerTest(frames).pipe(
      Layer.provide(Database.layerFile("feed.sqlite")),
      Layer.provide([configIn(dataDir), NodeServices.layer]),
      Layer.orDie
    )

    yield* Effect.scoped(Layer.build(logged))

    return dataDir
  })
}

/** Every frame of game day `day`, read whole. */
function framesOfDay(day: string) {
  return Scenarios.use((scenarios) => scenarios.load(day)).pipe(
    Effect.flatMap(({ frames }) => Stream.runCollect(frames))
  )
}

/** A poll of `body`, received at `wallClock` in New York. */
function poll(body: string, wallClock: string) {
  return new Frame({ receivedAt: inNewYork(wallClock), source: "poll", channel: "nfl", kind: "whole", body })
}

/** Topic `topic`'s checkpoint, received at `wallClock` in New York, a second after it was sent. */
function checkpoint(topic: string, wallClock: string) {
  const receivedAt = inNewYork(wallClock)
  const sentAt = DateTime.subtract(receivedAt, { seconds: 1 })
  return new Frame({
    receivedAt,
    sentAt,
    source: "push",
    channel: topic,
    kind: "whole",
    number: 1,
    body: "{}"
  })
}

function inNewYork(wallClock: string) {
  return DateTime.toUtc(
    DateTime.makeZonedUnsafe(wallClock, { timeZone: "America/New_York", adjustForTimeZone: true })
  )
}

/** Every committed scenario by name, as ESPN's decode said its frames and as the slate took them. */
class EveryScenarioPlayed extends Context.Service<
  EveryScenarioPlayed,
  ReadonlyArray<{
    readonly name: string
    readonly decoded: ReadonlyArray<Decoded>
    readonly events: ReadonlyArray<GameEvent>
    readonly observations: ReadonlyArray<SlateObservation>
  }>
>()("test/EveryScenarioPlayed") {}

const everyScenarioPlayed = Layer.effect(
  EveryScenarioPlayed,
  Effect.gen(function* () {
    const scenarios = yield* Scenarios
    const names = yield* scenarios.names

    return yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const scenario = yield* scenarios.load(name)
        const frames = yield* Stream.runCollect(scenario.frames)
        const decoded = yield* decodedFrames(frames)
        const { events, observations } = yield* takenOf(frames)

        return { name, decoded, events, observations }
      })
    )
  })
).pipe(Layer.provide([committed, Provider.layerTest(EspnDecoder.decode)]))

/** The scenarios `Scenarios.layerFrom` reads from a fresh directory holding only `file`, written as `contents`. */
function scenariosRecording(file: string, contents: Effect.Effect<Uint8Array, Cause.UnknownError>) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const bytes = yield* contents

      yield* fs.writeFile(path.join(dir, file), bytes)

      return Scenarios.layerFrom(dir).pipe(
        Layer.provide([HubConfig.layerTest({}).pipe(Layer.orDie), DateTime.layerCurrentZoneLocal])
      )
    })
  ).pipe(Layer.provide(NodeServices.layer))
}

/** `frames` as a recording's file holds them: JSON lines, gzip'd. */
function gzipped(frames: ReadonlyArray<Frame>) {
  return Gzip.compress(frames.map((frame) => `${encodeFrame(frame)}\n`).join(""))
}

/** `frames` as a recording's file holds them, then a line that is not a frame. */
function gzippedThenBadLine(frames: ReadonlyArray<Frame>) {
  return Gzip.compress([...frames.map((frame) => encodeFrame(frame)), "not a frame"].join("\n"))
}

// A recording polled at its start and again 40 s later.
const twoPolls = [0, 40].map(
  (seconds) =>
    new Frame({
      receivedAt: DateTime.add(DateTime.makeUnsafe("2026-10-03T16:00:00Z"), { seconds }),
      source: "poll",
      channel: "fbs",
      kind: "whole",
      body: JSON.stringify({ events: [] })
    })
)

function playsOf(events: ReadonlyArray<GameEvent>) {
  return events.flatMap(({ game, what }) => (what._tag === "Played" ? [{ game, play: what.play.id }] : []))
}

function deliveredPlaysOf(decoded: ReadonlyArray<Decoded>) {
  return decoded.flatMap(({ deliveries }) =>
    deliveries.flatMap((delivery) =>
      delivery._tag === "Plays" ? delivery.plays.map(({ id }) => ({ game: delivery.game, play: id })) : []
    )
  )
}

/** The games the slate let go, and what it dropped of a game before letting it go. */
function letGo(observations: ReadonlyArray<SlateObservation>) {
  const [stopped, dropped] = Arr.mapAccum(observations, new Set<string>(), (stopped, observation) =>
    observation._tag === "Stopped"
      ? [new Set([...stopped, observation.after.snapshot.id]), []]
      : [stopped, observation._tag === "Dropped" && !stopped.has(observation.game) ? [observation] : []]
  )

  return { stopped, droppedEarly: dropped.flat() }
}

const encodeFrame = Schema.encodeSync(Schema.fromJsonString(Frame))
