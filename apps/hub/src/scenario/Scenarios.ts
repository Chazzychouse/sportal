import { fileURLToPath } from "node:url"
import { Context, Data, DateTime, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { FeedFrame } from "../Frame.ts"
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
          const text = yield* fs.readFile(file).pipe(
            Effect.flatMap((bytes) => Gzip.decompress(bytes, "gzip")),
            Effect.mapError(unreadable(file))
          )
          const frames = yield* Effect.forEach(
            text.split("\n").filter((line) => line.length > 0),
            (line) => decodeFrame(line).pipe(Effect.mapError(unreadable(file)))
          )
          return new Scenario({ name, frames })
        })

        return Scenarios.of({ names, load })
      })
    )
  }
}

/** Games a Hub plays as its provider: a provider's raw frames, in order of receipt, recorded from a window of a game day. */
export class Scenario extends Data.Class<{
  readonly name: string
  readonly frames: ReadonlyArray<FeedFrame>
}> {
  /** When it starts: its first frame's receipt. */
  origin(): DateTime.Utc {
    return this.frames[0]?.receivedAt ?? DateTime.makeUnsafe(0)
  }
}

/** `SPORTAL_SCENARIO` names no recording; `known` are the names there are. */
export class ScenarioUnknown extends Schema.TaggedError<ScenarioUnknown>()("ScenarioUnknown", {
  name: Schema.String,
  known: Schema.Array(Schema.String)
}) {
  override get message() {
    return `No scenario named "${this.name}". Known: ${this.known.join(", ")}`
  }
}

/** A recording's folder or file could not be read as gzip'd frames. */
export class ScenarioUnreadable extends Schema.TaggedError<ScenarioUnreadable>()("ScenarioUnreadable", {
  path: Schema.String,
  cause: Schema.Defect()
}) {}

const suffix = ".frames.jsonl.gz"

function unreadable(path: string) {
  return (cause: unknown) => new ScenarioUnreadable({ path, cause })
}

const decodeFrame = Schema.decodeEffect(Schema.fromJsonString(FeedFrame))
