import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import type { GameEvent } from "@sportal/domain/GameEvent"
import { Array as Arr, type Cause, Context, DateTime, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { Frame } from "../Frame.ts"
import * as Gzip from "../Gzip.ts"
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

      const received = scenario.frames.map(({ receivedAt }) => receivedAt.epochMilliseconds)
      assert.isAbove(scenario.frames.length, 100)
      assert.deepStrictEqual(
        received,
        received.toSorted((a, b) => a - b)
      )
      assert.deepStrictEqual(scenario.origin(), DateTime.makeUnsafe("2026-10-04T20:00:07.418Z"))
    }).pipe(Effect.provide(committed))
  )

  it.effect("should load a recording by its name, the first of its frames a poll at its start", () =>
    Effect.gen(function* () {
      const scenarios = yield* Scenarios

      const scenario = yield* scenarios.load("two-polls")

      const [first] = scenario.frames
      assert.strictEqual(scenario.name, "two-polls")
      assert.deepStrictEqual([first?.source, first?.kind], ["poll", "whole"])
      assert.deepStrictEqual(scenario.origin(), DateTime.makeUnsafe("2026-10-03T16:00:00Z"))
    }).pipe(Effect.provide(scenariosRecording("two-polls.frames.jsonl.gz", gzipped(twoPolls))))
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
})

const fixtures = fileURLToPath(new URL("../../../../fixtures/scenarios/", import.meta.url))

const committed = Scenarios.layer.pipe(Layer.provide(NodeServices.layer))

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
        const { frames } = yield* scenarios.load(name)
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

      return Scenarios.layerFrom(dir)
    })
  ).pipe(Layer.provide(NodeServices.layer))
}

/** `frames` as a recording's file holds them: JSON lines, gzip'd. */
function gzipped(frames: ReadonlyArray<Frame>) {
  return Gzip.compress(frames.map((frame) => `${encodeFrame(frame)}\n`).join(""))
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
