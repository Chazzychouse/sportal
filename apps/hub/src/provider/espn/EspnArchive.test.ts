import { readFileSync } from "node:fs"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Effect, Fiber, FileSystem, Layer, type Path, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { Archive, ArchiveFetchFailed } from "../../corpus/Archive.ts"
import * as Gzip from "../../Gzip.ts"
import { withEnv } from "../../TestHubConfig.ts"
import * as EspnArchive from "./EspnArchive.ts"

// ESPN's archive of 2026-10-04's NFL games, as fetched once after they were final:
//   curl -o fixtures/nfl-scoreboard-2026-10-04-dated.json \
//     'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20261004'
//   curl -o fixtures/nfl-summary-401872971.json \
//     'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872971'
// The scoreboard lists 14 final games; only NE–BUF's summary is recorded, and every other game's is answered as a
// summary without plays, which the archive skips.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")
const scoreboard = fixture("nfl-scoreboard-2026-10-04-dated")
const summary = fixture("nfl-summary-401872971")

const site = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
const scoreboardUrl = `${site}/scoreboard?dates=20261004`
const summaryUrl = `${site}/summary?event=401872971`
const neBuf = GameId.make("401872971")

describe("EspnArchive", () => {
  it.effect(
    "fetches a date's final games: each as scheduled and as final, with its plays, and keeps both files",
    () =>
      inArchive({}, ({ dir, requests }) =>
        Effect.gen(function* () {
          const games = yield* stepped((yield* Archive).games("nfl", "2026-10-04"))

          assert.deepStrictEqual(
            games.map((game) => game.final.id),
            [neBuf]
          )
          const [game] = games
          assert.strictEqual(game?.scheduled.status, "scheduled")
          assert.deepStrictEqual(
            [game?.scheduled.home.score, game?.scheduled.away.score, game?.scheduled.situation],
            [0, 0, undefined]
          )
          assert.strictEqual(game?.final.status, "final")
          assert.strictEqual(game?.plays.length, 182)
          assert.strictEqual((yield* requests).filter((url) => url === summaryUrl).length, 1)
          assert.deepStrictEqual((yield* requests)[0], scoreboardUrl)

          const fs = yield* FileSystem.FileSystem
          const kept = yield* fs.readFile(`${dir}/archive/nfl/summary/401872971.json.gz`)
          assert.strictEqual(yield* Gzip.decompress(kept, "gzip"), summary)
          assert.isTrue(yield* fs.exists(`${dir}/archive/nfl/scoreboard/2026-10-04.json.gz`))
        })
      )
  )

  it.effect("fetches nothing it has archived", () =>
    inArchive({}, ({ requests }) =>
      Effect.gen(function* () {
        const archive = yield* Archive
        const first = yield* stepped(archive.games("nfl", "2026-10-04"))
        const fetched = (yield* requests).length
        const again = yield* stepped(archive.games("nfl", "2026-10-04"))
        const archived = yield* archive.archived("nfl", "2026-10-04")

        assert.strictEqual(fetched, 15, "the scoreboard and each of its 14 games' summaries")
        assert.strictEqual((yield* requests).length, fetched)
        assert.deepStrictEqual(again, first)
        assert.deepStrictEqual(archived, first)
      })
    )
  )

  it.effect("a date not archived is NotArchived, and is not fetched", () =>
    inArchive({}, ({ requests }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* Archive).archived("nfl", "2026-10-11"))

        assert.instanceOf(error, ArchiveFetchFailed)
        assert.deepStrictEqual(
          [error.league, error.date, error.reason, error.game],
          ["nfl", "2026-10-11", "NotArchived", undefined]
        )
        assert.deepStrictEqual(yield* requests, [])
      })
    )
  )

  it.effect("a summary that keeps failing is Unreachable after five tries, and is not kept", () =>
    inArchive(
      { answer: (url) => (url === summaryUrl ? new Response("", { status: 503 }) : undefined) },
      ({ dir, requests }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(stepped((yield* Archive).games("nfl", "2026-10-04")))

          assert.deepStrictEqual([error.reason, error.game], ["Unreachable", neBuf])
          assert.strictEqual((yield* requests).filter((url) => url === summaryUrl).length, 5)
          assert.isFalse(
            yield* (yield* FileSystem.FileSystem).exists(`${dir}/archive/nfl/summary/401872971.json.gz`)
          )
        })
    )
  )

  it.effect("a body that is not JSON is Unreadable and is not kept, so the next call fetches it again", () =>
    inArchive(
      {
        answer: (url, earlier) =>
          url === summaryUrl && earlier === 0 ? new Response("<html>Service Unavailable</html>") : undefined
      },
      ({ dir, requests }) =>
        Effect.gen(function* () {
          const archive = yield* Archive
          const error = yield* Effect.flip(stepped(archive.games("nfl", "2026-10-04")))
          const kept = yield* (yield* FileSystem.FileSystem).exists(
            `${dir}/archive/nfl/summary/401872971.json.gz`
          )
          const games = yield* stepped(archive.games("nfl", "2026-10-04"))

          assert.deepStrictEqual([error.reason, error.game], ["Unreadable", neBuf])
          assert.isFalse(kept)
          assert.deepStrictEqual(
            games.map((game) => game.final.id),
            [neBuf]
          )
          assert.strictEqual((yield* requests).filter((url) => url === summaryUrl).length, 2)
        })
    )
  )

  it.effect("a 429 is tried again", () =>
    inArchive(
      {
        answer: (url, earlier) =>
          url === summaryUrl && earlier === 0 ? new Response("", { status: 429 }) : undefined
      },
      ({ requests }) =>
        Effect.gen(function* () {
          const games = yield* stepped((yield* Archive).games("nfl", "2026-10-04"))

          assert.strictEqual(games.length, 1)
          assert.strictEqual((yield* requests).filter((url) => url === summaryUrl).length, 2)
        })
    )
  )

  it.effect("a game whose summary is refused is skipped, the rest still read, and nothing kept for it", () =>
    inArchive(
      { answer: (url) => (url === summaryUrl ? new Response("", { status: 404 }) : undefined) },
      ({ dir, requests }) =>
        Effect.gen(function* () {
          const games = yield* stepped((yield* Archive).games("nfl", "2026-10-04"))

          assert.deepStrictEqual(games, [])
          assert.strictEqual(
            (yield* requests).length,
            15,
            "the scoreboard and every summary, the refused one once"
          )
          assert.isFalse(
            yield* (yield* FileSystem.FileSystem).exists(`${dir}/archive/nfl/summary/401872971.json.gz`)
          )
          assert.isTrue(
            yield* (yield* FileSystem.FileSystem).exists(`${dir}/archive/nfl/summary/401872965.json.gz`)
          )
        })
    )
  )

  it.effect("a refused scoreboard fails the date", () =>
    inArchive(
      { answer: (url) => (url === scoreboardUrl ? new Response("", { status: 404 }) : undefined) },
      ({ requests }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(stepped((yield* Archive).games("nfl", "2026-10-04")))

          assert.deepStrictEqual([error.reason, error.game], ["Refused", undefined])
          assert.deepStrictEqual(yield* requests, [scoreboardUrl])
        })
    )
  )
})

/**
 * Runs `test` against ESPN's archive over a temporary corpus, with the URLs it requested. Its HTTP is answered by
 * `answer`, given how many times the URL was requested before, and otherwise from the fixtures.
 */
function inArchive<A, E>(
  options: { readonly answer?: (url: string, earlier: number) => Response | undefined },
  test: (context: {
    readonly dir: string
    readonly requests: Effect.Effect<ReadonlyArray<string>>
  }) => Effect.Effect<A, E, Archive | FileSystem.FileSystem | Path.Path>
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
                request.url === scoreboardUrl ? scoreboard : request.url === summaryUrl ? summary : "{}"
              )
          )
        )
      )
    )
    return yield* test({ dir, requests: Ref.get(requests) }).pipe(
      Effect.provide(
        EspnArchive.layer.pipe(
          Layer.provide(withEnv({ SPORTAL_CORPUS_DIR: dir })),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
        )
      )
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
}

/** `effect` run to its end, the test clock stepped past each wait: the archive's pacing, and its retries. */
function stepped<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
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
