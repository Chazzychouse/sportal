import { readFileSync } from "node:fs"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import type { GameDay } from "@sportal/domain/GameDay"
import { type Crypto, DateTime, Effect, FileSystem, Layer, type Path } from "effect"
import type { SqlClient } from "effect/sql"
import * as Database from "../Database.ts"
import type { Frame } from "../Frame.ts"
import { FeedLog } from "../feed-log/FeedLog.ts"
import { HubConfig } from "../HubConfig.ts"
import type { Provider } from "../provider/Provider.ts"
import * as CorpusBuild from "./CorpusBuild.ts"
import { CorpusDays } from "./CorpusDay.ts"

// The zone corpus tests read their game days in.
const zone = "America/New_York"

/** A wall-clock instant in `zone`. */
export function local(wallClock: string): DateTime.Utc {
  return DateTime.toUtc(DateTime.makeZonedUnsafe(wallClock, { timeZone: zone, adjustForTimeZone: true }))
}

/**
 * `test` over an in-memory feed log's database, `provider`, and corpus days in a temporary directory it is given, in
 * `timeZone`, `zone` unless given.
 */
export const inCorpus = Effect.fn("TestCorpus.inCorpus")(
  function* <A, E>(
    provider: Layer.Layer<Provider>,
    test: (
      dir: string
    ) => Effect.Effect<
      A,
      E,
      | CorpusDays
      | Provider
      | DateTime.CurrentTimeZone
      | FileSystem.FileSystem
      | Path.Path
      | SqlClient.SqlClient
      | Crypto.Crypto
    >,
    timeZone: DateTime.TimeZone = DateTime.zoneMakeNamedUnsafe(zone)
  ) {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped()

    return yield* test(dir).pipe(
      Effect.provide(
        Layer.mergeAll(
          CorpusDays.layer.pipe(Layer.provide(HubConfig.layerTest({ SPORTAL_CORPUS_DIR: dir }))),
          provider,
          DateTime.layerCurrentZone(timeZone),
          Database.layerMemory,
          NodeCrypto.layer
        )
      )
    )
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer)
)

/** Day `date` built from the feed log, opened for the build alone once `frames` are logged to it. */
export function built(date: GameDay, frames: ReadonlyArray<Frame> = []) {
  return CorpusBuild.captured(date).pipe(Effect.provide(FeedLog.layerTest(frames)), Effect.scoped)
}

/**
 * The lines of NE–BUF's 2026-10-04 day synthesized from ESPN's archive, as committed in `fixtures/`: read by eye
 * against the synthesis's rules before it was. The backfilled golden.
 */
export function golden(file: "poll" | "push") {
  return readFileSync(new URL(`./fixtures/2026-10-04-ne-buf.${file}.ndjson`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
}
