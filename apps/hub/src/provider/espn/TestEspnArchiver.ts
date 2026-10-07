import { readFileSync } from "node:fs"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, Fiber, FileSystem, Layer, type Path, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { CorpusDays } from "../../corpus/CorpusDay.ts"
import { withEnv } from "../../TestHubConfig.ts"
import type { Archiver } from "../Archiver.ts"
import * as EspnArchiver from "./EspnArchiver.ts"
import { fixtures } from "./TestEspn.ts"

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
  }) => Effect.Effect<A, E, Archiver | CorpusDays | FileSystem.FileSystem | Path.Path>
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped()
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
        Layer.mergeAll(EspnArchiver.layer, CorpusDays.layer).pipe(
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
