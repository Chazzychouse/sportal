import { fileURLToPath } from "node:url"
import { GameDay } from "@sportal/domain/GameDay"
import {
  Context,
  type Crypto,
  Data,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stream
} from "effect"
import { Frame } from "../Frame.ts"
import { FeedLog } from "../feed-log/FeedLog.ts"
import * as Gzip from "../Gzip.ts"
import { HubConfig } from "../HubConfig.ts"

/**
 * Every scenario a Hub can play, by name: each game day the data directory's feed log recorded, by its date, and the
 * recordings in a folder, each kept as `<name>.frames.jsonl.gz`.
 */
export class Scenarios extends Context.Service<
  Scenarios,
  {
    /**
     * The recordings there are, sorted, none when their folder is missing; then the game days the data directory's
     * `feed.sqlite` has frames on, none when it has no `feed.sqlite`.
     */
    readonly names: Effect.Effect<ReadonlyArray<string>, ScenarioUnreadable>
    /**
     * Scenario `name`: a name that is a game day, YYYY-MM-DD, is that day from the data directory's feed log; any other
     * is a recording. Only a listed recording is read, so no name reaches a path.
     */
    load(name: string): Effect.Effect<Scenario, ScenarioUnknown | ScenarioUnreadable>
  }
>()("sportal/hub/scenario/Scenarios") {
  /** The committed recordings, in `fixtures/scenarios/` at the repository's root, and the recorded game days. */
  static readonly layer: Layer.Layer<
    Scenarios,
    never,
    HubConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto | DateTime.CurrentTimeZone
  > = Scenarios.layerFrom(fileURLToPath(new URL("../../../../fixtures/scenarios/", import.meta.url)))

  /**
   * The recordings in `folder`, and the game days, in the current zone, of `feed.sqlite` in the data directory. That
   * feed log is opened only while a name is listed or a day's frames are read, only when it is there, and nothing is
   * appended to it.
   */
  static layerFrom(
    folder: string
  ): Layer.Layer<
    Scenarios,
    never,
    HubConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto | DateTime.CurrentTimeZone
  > {
    return Layer.effect(
      Scenarios,
      Effect.gen(function* () {
        const context = yield* Effect.context<
          HubConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto | DateTime.CurrentTimeZone
        >()

        const names = Effect.gen(function* () {
          const files = yield* fileNames(folder)
          const days = yield* recordedDays
          return [...files, ...days]
        }).pipe(Effect.provideContext(context))

        const load = Effect.fn("Scenarios.load")(function* (name: string) {
          const source = Schema.is(GameDay)(name) ? dayScenario(name) : fileScenario(folder, name)
          const loaded = yield* source
          if (Option.isNone(loaded)) {
            const known = yield* names
            return yield* new ScenarioUnknown({ name, known })
          }

          return loaded.value
        }, Effect.provideContext(context))

        return Scenarios.of({ names, load })
      })
    )
  }
}

/**
 * Games a Hub plays as its provider: a provider's raw frames, in order of receipt, from a game day the feed log
 * recorded or a recording of a window of one. Its frames are read as they are run, each run from the start.
 */
export class Scenario extends Data.Class<{
  readonly name: string
  /** When it starts: its first frame's receipt. */
  readonly origin: DateTime.Utc
  readonly frames: Stream.Stream<Frame, ScenarioUnreadable>
}> {}

/** `SPORTAL_SCENARIO` names no recording, or a game day with no frames; `known` are the names there are. */
export class ScenarioUnknown extends Schema.TaggedError<ScenarioUnknown>()("ScenarioUnknown", {
  name: Schema.String,
  known: Schema.Array(Schema.String)
}) {
  override get message() {
    return `No scenario named "${this.name}". Known: ${this.known.join(", ")}`
  }
}

/**
 * A recording's folder or file could not be read as gzip'd frames, at its start or partway, or the data directory could
 * not be looked in for its feed log.
 */
export class ScenarioUnreadable extends Schema.TaggedError<ScenarioUnreadable>()("ScenarioUnreadable", {
  path: Schema.String,
  cause: Schema.Defect()
}) {}

const fileNames = Effect.fn("Scenarios.fileNames")(
  function* (folder: string) {
    const fs = yield* FileSystem.FileSystem

    const exists = yield* fs.exists(folder)
    if (!exists) return []
    const files = yield* fs.readDirectory(folder)
    return files
      .filter((file) => file.endsWith(suffix))
      .map((file) => file.slice(0, -suffix.length))
      .sort()
  },
  (listing, folder) => Effect.mapError(listing, unreadable(folder))
)

const recordedDays = fromDataDirLog((log) => Stream.fromIterableEffect(log.days)).pipe(Stream.runCollect)

// What `read` streams from the data directory's feed log, opened for it alone; nothing when there is no `feed.sqlite`.
function fromDataDirLog<A, R>(
  read: (log: FeedLog["Service"]) => Stream.Stream<A, never, R>
): Stream.Stream<A, ScenarioUnreadable, R | HubConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto> {
  const opened = Stream.unwrap(FeedLog.useSync(read)).pipe(
    Stream.provide(FeedLog.layerInDataDir, { local: true })
  )
  return Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { join } = yield* Path.Path
      const { dataDir } = yield* HubConfig

      const file = join(dataDir, "feed.sqlite")
      const recorded = yield* fs.exists(file).pipe(Effect.mapError(unreadable(file)))
      return recorded ? opened : Stream.empty
    })
  )
}

// Game day `day` from the data directory's feed log, if it has frames on it. What the replay looks back for, a topic's
// checkpoint before the day starts and its frames after it, is received at the day's start instead.
const dayScenario = Effect.fn("Scenarios.dayScenario")(function* (day: GameDay) {
  const zone = yield* DateTime.CurrentTimeZone
  const context = yield* Effect.context<HubConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto>()

  const { from, until } = GameDay.bounds(day, zone)
  const frames = fromDataDirLog((log) => log.replay(from)).pipe(
    Stream.takeWhile((frame) => DateTime.isLessThan(frame.receivedAt, until)),
    Stream.map((frame) => Frame.movedTo(frame, DateTime.max(frame.receivedAt, from))),
    Stream.provideContext(context)
  )
  const first = yield* Stream.runHead(frames)

  return Option.map(first, ({ receivedAt }) => new Scenario({ name: day, origin: receivedAt, frames }))
})

// The recording `name` in `folder`, if it is listed there.
const fileScenario = Effect.fn("Scenarios.fileScenario")(function* (folder: string, name: string) {
  const fs = yield* FileSystem.FileSystem
  const { join } = yield* Path.Path

  const files = yield* fileNames(folder)
  if (!files.includes(name)) return Option.none<Scenario>()

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

  return Option.some(new Scenario({ name, origin: first.value.receivedAt, frames }))
})

const suffix = ".frames.jsonl.gz"

function unreadable(path: string) {
  return (cause: unknown) => new ScenarioUnreadable({ path, cause })
}

const decodeFrame = Schema.decodeEffect(Schema.fromJsonString(Frame))
