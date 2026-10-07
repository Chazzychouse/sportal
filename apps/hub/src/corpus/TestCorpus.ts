import { readFileSync } from "node:fs"
import { join } from "node:path"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { type Crypto, DateTime, Effect, Fiber, FileSystem, Layer, type Path, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import type { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import * as Database from "../Database.ts"
import { FeedLog } from "../FeedLog.ts"
import type { FeedFrame } from "../Frame.ts"
import type { Decoder } from "../provider/Decoder.ts"
import * as EspnArchive from "../provider/espn/EspnArchive.ts"
import { fixtures, neAtBufFrames } from "../provider/espn/TestEspn.ts"
import { Scenarios } from "../scenario/Scenarios.ts"
import { withEnv } from "../TestHubConfig.ts"
import type { Archive } from "./Archive.ts"
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
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    return yield* test(dir).pipe(
      Effect.provide(
        Layer.mergeAll(
          CorpusDays.layer.pipe(Layer.provide(withEnv({ SPORTAL_CORPUS_DIR: dir }))),
          decoder,
          DateTime.layerCurrentZone(timeZone),
          Database.at(":memory:"),
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

/** `frames` appended through a feed log of their own, closed before the test goes on, so every one is written. */
export function logged(frames: ReadonlyArray<FeedFrame>) {
  return FeedLog.use((log) => Effect.forEach(frames, log.append, { discard: true })).pipe(
    Effect.provide(FeedLog.layer),
    Effect.scoped
  )
}

/** The recorded NE at BUF day's frames. */
export const recorded = Scenarios.use((scenarios) => scenarios.load(neAtBufFrames)).pipe(
  Effect.map(({ frames }) => frames),
  Effect.provide(Scenarios.in(fixtures, []).pipe(Layer.provideMerge(NodeServices.layer)))
)

// ESPN's archive of 2026-10-04's NFL games, as fetched once after they were final:
//   curl -o fixtures/nfl-scoreboard-2026-10-04-dated.json \
//     'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20261004'
//   curl -o fixtures/nfl-summary-401872971.json \
//     'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872971'
// The scoreboard lists 14 final games; only NE–BUF's summary is recorded, and every other game's is answered as a
// summary without plays, which the archive skips.
const fixture = (name: string) => readFileSync(join(fixtures, `${name}.json`), "utf8")
const scoreboard = fixture("nfl-scoreboard-2026-10-04-dated")
/** NE–BUF's recorded summary, as ESPN sent it. */
export const archivedSummary = fixture("nfl-summary-401872971")

export const site = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
export const scoreboardUrl = `${site}/scoreboard?dates=20261004`
export const summaryUrl = `${site}/summary?event=401872971`

/**
 * Runs `test` against ESPN's archive and the corpus's days over a temporary corpus, with the URLs it requested. Its
 * HTTP is answered by `answer`, given how many times the URL was requested before, and otherwise from the fixtures.
 */
export function inArchive<A, E>(
  options: { readonly answer?: (url: string, earlier: number) => Response | undefined },
  test: (context: {
    readonly dir: string
    readonly requests: Effect.Effect<ReadonlyArray<string>>
  }) => Effect.Effect<A, E, Archive | CorpusDays | FileSystem.FileSystem | Path.Path>
) {
  return Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    const requests = yield* Ref.make<ReadonlyArray<string>>([])
    const client = HttpClient.make((request) =>
      Ref.getAndUpdate(requests, (urls) => [...urls, request.url]).pipe(
        Effect.map((earlier) =>
          HttpClientResponse.fromWeb(
            request,
            options.answer?.(request.url, earlier.filter((url) => url === request.url).length) ??
              new Response(
                request.url === scoreboardUrl
                  ? scoreboard
                  : request.url === summaryUrl
                    ? archivedSummary
                    : "{}"
              )
          )
        )
      )
    )
    return yield* test({ dir, requests: Ref.get(requests) }).pipe(
      Effect.provide(
        Layer.mergeAll(EspnArchive.layer, CorpusDays.layer).pipe(
          Layer.provide(withEnv({ SPORTAL_CORPUS_DIR: dir })),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
        )
      )
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
}

/** `effect` run to its end, the test clock stepped past each wait: the archive's pacing, and its retries. */
export function stepped<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect)
    yield* TestClock.withLive(Effect.sleep("1 millis")).pipe(
      Effect.andThen(TestClock.adjust("10 seconds")),
      Effect.andThen(Effect.sync(() => fiber.pollUnsafe())),
      Effect.repeat({ until: (exit) => exit !== undefined })
    )
    return yield* Fiber.join(fiber)
  })
}
