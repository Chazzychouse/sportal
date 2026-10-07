import { fileURLToPath } from "node:url"
import { Array as Arr, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { FeedFrame } from "../Frame.ts"
import * as Gzip from "../Gzip.ts"
import { Scenario } from "./Scenario.ts"

/**
 * Every scenario a Hub can play, by name: the recorded ones, each kept as `<name>.frames.jsonl.gz`, and the written
 * ones, given already written as frames.
 */
export class Scenarios extends Context.Service<
  Scenarios,
  {
    /** The scenarios there are, recorded and written, sorted; no recorded ones when their folder is missing. */
    readonly names: Effect.Effect<ReadonlyArray<string>, ScenarioUnreadable | ScenarioDuplicate>
    /** Scenario `name`. Only a listed name is read, so no name reaches a path. */
    load(name: string): Effect.Effect<Scenario, ScenarioUnknown | ScenarioUnreadable | ScenarioDuplicate>
  }
>()("sportal/hub/Scenarios") {
  /** The recorded scenarios in `folder`, and `written`. */
  static in(
    folder: string,
    written: ReadonlyArray<Scenario>
  ): Layer.Layer<Scenarios, never, FileSystem.FileSystem | Path.Path> {
    return Layer.effect(
      Scenarios,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { join } = yield* Path.Path
        const recorded = Effect.gen(function* () {
          return (yield* fs.exists(folder))
            ? (yield* fs.readDirectory(folder))
                .filter((file) => file.endsWith(suffix))
                .map((file) => file.slice(0, -suffix.length))
            : []
        }).pipe(Effect.mapError(unreadable(folder)))
        const names = Effect.flatMap(recorded, (files) =>
          Option.match(
            Arr.findFirst(files, (name) => written.some((scenario) => scenario.name === name)),
            {
              onSome: (name) => Effect.fail(new ScenarioDuplicate({ name })),
              onNone: () => Effect.succeed([...files, ...written.map(({ name }) => name)].sort())
            }
          )
        )
        return Scenarios.of({
          names,
          load: (name) =>
            Effect.gen(function* () {
              const known = yield* names
              if (!known.includes(name)) return yield* new ScenarioUnknown({ name, known })
              const script = written.find((scenario) => scenario.name === name)
              if (script !== undefined) return script
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
        })
      })
    )
  }

  /** The committed recorded scenarios, in `fixtures/scenarios/` at the repository's root, and `written`. */
  static layer(
    written: ReadonlyArray<Scenario>
  ): Layer.Layer<Scenarios, never, FileSystem.FileSystem | Path.Path> {
    return Scenarios.in(fileURLToPath(new URL("../../../../fixtures/scenarios/", import.meta.url)), written)
  }
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

/** A recorded scenario and a written one share `name`, so the name cannot say which to play. */
export class ScenarioDuplicate extends Schema.TaggedError<ScenarioDuplicate>()("ScenarioDuplicate", {
  name: Schema.String
}) {
  override get message() {
    return `Scenario "${this.name}" is both recorded and written`
  }
}

const suffix = ".frames.jsonl.gz"

const decodeFrame = Schema.decodeEffect(Schema.fromJsonString(FeedFrame))

function unreadable(path: string) {
  return (cause: unknown) => new ScenarioUnreadable({ path, cause })
}
