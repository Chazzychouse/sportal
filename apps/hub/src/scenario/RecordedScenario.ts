import { fileURLToPath } from "node:url"
import { Data, DateTime, Effect, FileSystem, Path, Schema } from "effect"
import { FeedFrame } from "../Frame.ts"
import * as Gzip from "../Gzip.ts"

/** A scenario kept as the raw frames of a recorded window, `<name>.frames.jsonl.gz` in its folder, in order. */
export class RecordedScenario extends Data.Class<{
  readonly name: string
  readonly frames: ReadonlyArray<FeedFrame>
}> {
  /** Where recorded scenarios are kept: `fixtures/scenarios/` at the repository's root. */
  static readonly folder = fileURLToPath(new URL("../../../../fixtures/scenarios/", import.meta.url))

  /** The recorded scenarios in `from`, by name; none when the folder is missing. */
  static names(from: string = RecordedScenario.folder) {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return (yield* fs.exists(from))
        ? (yield* fs.readDirectory(from))
            .filter((file) => file.endsWith(suffix))
            .map((file) => file.slice(0, -suffix.length))
            .sort()
        : []
    })
  }

  /** Recorded scenario `name` in `from`. Only a listed name is read, so no name reaches a path. */
  static load(
    name: string,
    from: string = RecordedScenario.folder
  ): Effect.Effect<
    RecordedScenario,
    ScenarioUnknown | ScenarioUnreadable,
    FileSystem.FileSystem | Path.Path
  > {
    return Effect.gen(function* () {
      const known = yield* RecordedScenario.names(from).pipe(Effect.mapError(unreadable(from)))
      if (!known.includes(name)) return yield* new ScenarioUnknown({ name, known })
      const file = (yield* Path.Path).join(from, `${name}${suffix}`)
      const text = yield* (yield* FileSystem.FileSystem).readFile(file).pipe(
        Effect.flatMap((bytes) => Gzip.decompress(bytes, "gzip")),
        Effect.mapError(unreadable(file))
      )
      const frames = yield* Effect.forEach(
        text.split("\n").filter((line) => line.length > 0),
        (line) => decodeFrame(line).pipe(Effect.mapError(unreadable(file)))
      )
      return new RecordedScenario({ name, frames })
    })
  }

  /** When it starts: its first frame's receipt. */
  origin(): DateTime.Utc {
    return this.frames[0]?.receivedAt ?? DateTime.makeUnsafe(0)
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

const suffix = ".frames.jsonl.gz"

const decodeFrame = Schema.decodeEffect(Schema.fromJsonString(FeedFrame))

function unreadable(path: string) {
  return (cause: unknown) => new ScenarioUnreadable({ path, cause })
}
