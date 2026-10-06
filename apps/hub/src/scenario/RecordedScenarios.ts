import { fileURLToPath } from "node:url"
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { FeedFrame } from "../Frame.ts"
import * as Gzip from "../Gzip.ts"
import { RecordedScenario } from "./RecordedScenario.ts"

/** Where the recorded scenarios are kept, each as `<name>.frames.jsonl.gz`, and reading one back. */
export class RecordedScenarios extends Context.Service<
  RecordedScenarios,
  {
    /** The recorded scenarios there are, by name; none when their folder is missing. */
    readonly names: Effect.Effect<ReadonlyArray<string>, ScenarioUnreadable>
    /** Recorded scenario `name`. Only a listed name is read, so no name reaches a path. */
    load(name: string): Effect.Effect<RecordedScenario, ScenarioUnknown | ScenarioUnreadable>
  }
>()("sportal/hub/RecordedScenarios") {
  /** The recorded scenarios in `folder`. */
  static in(folder: string): Layer.Layer<RecordedScenarios, never, FileSystem.FileSystem | Path.Path> {
    return Layer.effect(
      RecordedScenarios,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { join } = yield* Path.Path
        const names = Effect.gen(function* () {
          return (yield* fs.exists(folder))
            ? (yield* fs.readDirectory(folder))
                .filter((file) => file.endsWith(suffix))
                .map((file) => file.slice(0, -suffix.length))
                .sort()
            : []
        }).pipe(Effect.mapError(unreadable(folder)))
        return RecordedScenarios.of({
          names,
          load: (name) =>
            Effect.gen(function* () {
              const known = yield* names
              if (!known.includes(name)) return yield* new ScenarioUnknown({ name, known })
              const file = join(folder, `${name}${suffix}`)
              const text = yield* fs.readFile(file).pipe(
                Effect.flatMap((bytes) => Gzip.decompress(bytes, "gzip")),
                Effect.mapError(unreadable(file))
              )
              const frames = yield* Effect.forEach(
                text.split("\n").filter((line) => line.length > 0),
                (line) => decodeFrame(line).pipe(Effect.mapError(unreadable(file)))
              )
              return new RecordedScenario({ name, frames })
            })
        })
      })
    )
  }

  /** The committed recorded scenarios, in `fixtures/scenarios/` at the repository's root. */
  static readonly layer = RecordedScenarios.in(
    fileURLToPath(new URL("../../../../fixtures/scenarios/", import.meta.url))
  )
}

/** `SPORTAL_SCENARIO` names neither a written scenario nor a recorded one; `known` are the names there are. */
export class ScenarioUnknown extends Schema.TaggedError<ScenarioUnknown>()("ScenarioUnknown", {
  name: Schema.String,
  known: Schema.Array(Schema.String)
}) {
  override get message() {
    return `No scenario named "${this.name}". Known: ${this.known.join(", ")}`
  }
}

/** A recorded scenario's folder or file could not be read as gzip'd frames. */
export class ScenarioUnreadable extends Schema.TaggedError<ScenarioUnreadable>()("ScenarioUnreadable", {
  path: Schema.String,
  cause: Schema.Defect()
}) {}

const suffix = ".frames.jsonl.gz"

const decodeFrame = Schema.decodeEffect(Schema.fromJsonString(FeedFrame))

function unreadable(path: string) {
  return (cause: unknown) => new ScenarioUnreadable({ path, cause })
}
