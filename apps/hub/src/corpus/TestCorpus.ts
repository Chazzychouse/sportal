import { readFileSync } from "node:fs"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { type Crypto, DateTime, Effect, FileSystem, Layer, type Path } from "effect"
import type { SqlClient } from "effect/sql"
import * as Database from "../Database.ts"
import { FeedLog } from "../FeedLog.ts"
import type { Decoder } from "../provider/Decoder.ts"
import { withEnv } from "../TestHubConfig.ts"
import * as CorpusBuild from "./CorpusBuild.ts"
import { CorpusDays } from "./CorpusDay.ts"

// The zone corpus tests read their game days in.
const zone = "America/New_York"

/** A wall-clock instant in `zone`. */
export function local(wallClock: string): DateTime.Utc {
  return DateTime.toUtc(DateTime.makeZonedUnsafe(wallClock, { timeZone: zone, adjustForTimeZone: true }))
}

/**
 * `test` over an in-memory feed log's database, `decoder`, and corpus days in a temporary directory it is given, in
 * `timeZone`, `zone` unless given.
 */
export function inCorpus<A, E>(
  decoder: Layer.Layer<Decoder>,
  test: (
    dir: string
  ) => Effect.Effect<
    A,
    E,
    | CorpusDays
    | Decoder
    | DateTime.CurrentTimeZone
    | FileSystem.FileSystem
    | Path.Path
    | SqlClient.SqlClient
    | Crypto.Crypto
  >,
  timeZone: DateTime.TimeZone = DateTime.zoneMakeNamedUnsafe(zone)
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped()

    return yield* test(dir).pipe(
      Effect.provide(
        Layer.mergeAll(
          CorpusDays.layer.pipe(Layer.provide(withEnv({ SPORTAL_CORPUS_DIR: dir }))),
          decoder,
          DateTime.layerCurrentZone(timeZone),
          Database.layerMemory,
          NodeCrypto.layer
        )
      )
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
}

/** Day `date` built from the feed log, opened for the build alone. */
export function built(date: string) {
  return CorpusBuild.captured(date).pipe(Effect.provide(FeedLog.layer), Effect.scoped)
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
