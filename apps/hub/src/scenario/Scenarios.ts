import { fileURLToPath } from "node:url"
import { Context, Data, type DateTime, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { Frame } from "../Frame.ts"
import * as Gzip from "../Gzip.ts"

/** Every scenario a Hub can play, by name: the recordings in a folder, each kept as `<name>.frames.jsonl.gz`. */
export class Scenarios extends Context.Service<
  Scenarios,
  {
    /** The recordings there are, sorted; none when their folder is missing. */
    readonly names: Effect.Effect<ReadonlyArray<string>, ScenarioUnreadable>
    /** Scenario `name`. Only a listed name is read, so no name reaches a path. */
    load(name: string): Effect.Effect<Scenario, ScenarioUnknown | ScenarioUnreadable>
  }
>()("sportal/hub/scenario/Scenarios") {
  /** The committed recordings, in `fixtures/scenarios/` at the repository's root. */
  static readonly layer: Layer.Layer<Scenarios, never, FileSystem.FileSystem | Path.Path> =
    Scenarios.layerFrom(fileURLToPath(new URL("../../../../fixtures/scenarios/", import.meta.url)))

  /** The recordings in `folder`. */
  static layerFrom(folder: string): Layer.Layer<Scenarios, never, FileSystem.FileSystem | Path.Path> {
    return Layer.effect(
      Scenarios,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { join } = yield* Path.Path

        const names = Effect.gen(function* () {
          const exists = yield* fs.exists(folder)
          if (!exists) return []
          const files = yield* fs.readDirectory(folder)
          return files
            .filter((file) => file.endsWith(suffix))
            .map((file) => file.slice(0, -suffix.length))
            .sort()
        }).pipe(Effect.mapError(unreadable(folder)))

        const load = Effect.fn("Scenarios.load")(function* (name: string) {
          const known = yield* names
          if (!known.includes(name)) {
            return yield* new ScenarioUnknown({ name, known })
          }

          const file = join(folder, `${name}${suffix}`)
          const frames = Gzip.decompressStream(fs.stream(file), "gzip").pipe(
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect((line) => decodeFrame(line)),
            Stream.mapError(unreadable(file))
          )

          const first = yield* Stream.runHead(frames)
          if (Option.isNone(first)) {
            return yield* new ScenarioUnreadable({ path: file, cause: "It holds no frames" })
          }

          return new Scenario({ name, origin: first.value.receivedAt, frames })
        })

        return Scenarios.of({ names, load })
      })
    )
  }
}

/**
 * Games a Hub plays as its provider: a provider's raw frames, in order of receipt, recorded from a window of a game day.
 * Its frames are read as they are run, each run from the start.
 */
export class Scenario extends Data.Class<{
  readonly name: string
  /** When it starts: its first frame's receipt. */
  readonly origin: DateTime.Utc
  readonly frames: Stream.Stream<Frame, ScenarioUnreadable>
}> {}

/** `SPORTAL_SCENARIO` names no recording; `known` are the names there are. */
export class ScenarioUnknown extends Schema.TaggedError<ScenarioUnknown>()("ScenarioUnknown", {
  name: Schema.String,
  known: Schema.Array(Schema.String)
}) {
  override get message() {
    return `No scenario named "${this.name}". Known: ${this.known.join(", ")}`
  }
}

/** A recording's folder or file could not be read as gzip'd frames, at its start or partway. */
export class ScenarioUnreadable extends Schema.TaggedError<ScenarioUnreadable>()("ScenarioUnreadable", {
  path: Schema.String,
  cause: Schema.Defect()
}) {}

const suffix = ".frames.jsonl.gz"

function unreadable(path: string) {
  return (cause: unknown) => new ScenarioUnreadable({ path, cause })
}

const decodeFrame = Schema.decodeEffect(Schema.fromJsonString(Frame))
