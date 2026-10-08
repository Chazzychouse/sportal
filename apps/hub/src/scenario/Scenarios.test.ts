import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Play } from "@sportal/domain/Play"
import { Context, DateTime, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { Frame } from "../Frame.ts"
import { decodedFrames } from "../provider/espn/TestEspn.ts"
import { Delivery } from "../slate/Delivery.ts"
import { Slate } from "../slate/Slate.ts"
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
      it.effect("should end with some play on its slate", () =>
        Effect.gen(function* () {
          const played = yield* EveryScenarioPlayed

          for (const { name, final } of played) {
            assert.isAbove(final.games.flatMap(({ plays }) => plays).length, 0, `${name} plays`)
          }
        })
      )

      it.effect("should end holding each listed game's last delivered plays", () =>
        Effect.gen(function* () {
          const played = yield* EveryScenarioPlayed

          for (const { name, decoded, final } of played) {
            for (const [game, plays] of lastPlaysOf(decoded)) {
              const held = final.game(game)
              if (Option.isNone(held)) continue
              assert.deepStrictEqual(
                held.value.plays.map(({ id }) => id),
                plays.toSorted(Play.order).map(({ id }) => id),
                `${name}: ${game} holds its last delivered plays`
              )
            }
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
      Effect.provide(scenariosRecording("broken.frames.jsonl.gz", new TextEncoder().encode("not gzip")))
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

// The committed recordings.
const committed = Scenarios.layer.pipe(Layer.provide(NodeServices.layer))

/** Every committed scenario by name, as ESPN's decode said its frames, and the slate once it has taken them all. */
class EveryScenarioPlayed extends Context.Service<
  EveryScenarioPlayed,
  ReadonlyArray<{
    readonly name: string
    readonly decoded: ReadonlyArray<ReadonlyArray<Delivery>>
    readonly final: Slate
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
        const final = decoded.reduce((slate, deliveries) => slate.take(deliveries), Slate.empty)

        return { name, decoded, final }
      })
    )
  })
).pipe(Layer.provide(committed))

/** The scenarios `Scenarios.layerFrom` reads from a fresh directory holding only `file`, written as `contents`. */
function scenariosRecording(file: string, contents: Uint8Array) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()

      yield* fs.writeFile(path.join(dir, file), contents)

      return Scenarios.layerFrom(dir)
    })
  ).pipe(Layer.provide(NodeServices.layer))
}

/** `frames` as a recording's file holds them: JSON lines, gzip'd. */
function gzipped(frames: ReadonlyArray<Frame>) {
  return gzipSync(frames.map((frame) => `${encodeFrame(frame)}\n`).join(""))
}

/** `frames` as a recording's file holds them, then a line that is not a frame. */
function gzippedThenBadLine(frames: ReadonlyArray<Frame>) {
  return gzipSync([...frames.map((frame) => encodeFrame(frame)), "not a frame"].join("\n"))
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

/** Each game's plays as the last `Plays` delivered for it had them. */
function lastPlaysOf(decoded: ReadonlyArray<ReadonlyArray<Delivery>>) {
  return new Map(
    decoded
      .flat()
      .filter(Delivery.guards.Plays)
      .map(({ game, plays }) => [game, plays] as const)
  )
}

const encodeFrame = Schema.encodeSync(Schema.fromJsonString(Frame))
