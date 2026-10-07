import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Effect, FileSystem } from "effect"
import { GameDay } from "../../corpus/GameDay.ts"
import * as Gzip from "../../Gzip.ts"
import { Archive, ArchiveFetchFailed } from "../Archive.ts"
import {
  inArchive,
  scoreboardUrl,
  site,
  stepped,
  archivedSummary as summary,
  summaryUrl
} from "./TestEspnArchive.ts"

const neBuf = GameId.make("401872971")
// Another of the date's games, whose summary the tests refuse.
const refusedGame = GameId.make("401872965")
const refusedSummaryUrl = `${site}/summary?event=401872965`

describe("EspnArchive", () => {
  it.effect(
    "should fetch a date's final games, each as scheduled and as final with its plays, and keep both files",
    () =>
      inArchive({}, ({ dir, requests }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          const games = yield* fetchedDay()

          const [game] = games
          const urls = yield* requests
          const kept = yield* fs.readFile(`${dir}/archive/nfl/summary/401872971.json.gz`)
          const keptSummary = yield* Gzip.decompress(kept, "gzip")
          const scoreboardKept = yield* fs.exists(`${dir}/archive/nfl/scoreboard/2026-10-04.json.gz`)
          assert.deepStrictEqual(
            games.map((game) => game.final.id),
            [neBuf]
          )
          assert.strictEqual(game?.scheduled.status, "scheduled")
          assert.deepStrictEqual(
            [game?.scheduled.home.score, game?.scheduled.away.score, game?.scheduled.situation],
            [0, 0, undefined]
          )
          assert.strictEqual(game?.final.status, "final")
          assert.strictEqual(game?.plays.length, 182)
          assert.strictEqual(urls.filter((url) => url === summaryUrl).length, 1)
          assert.deepStrictEqual(urls[0], scoreboardUrl)
          assert.strictEqual(keptSummary, summary)
          assert.isTrue(scoreboardKept)
        })
      )
  )

  it.effect("should fetch nothing again for a date it has archived", () =>
    inArchive({}, ({ requests }) =>
      Effect.gen(function* () {
        const first = yield* fetchedDay()
        const fetched = yield* requests

        const again = yield* fetchedDay()

        const urls = yield* requests
        assert.strictEqual(fetched.length, 15, "the scoreboard and each of its 14 games' summaries")
        assert.strictEqual(urls.length, fetched.length)
        assert.deepStrictEqual(again, first)
      })
    )
  )

  it.effect("should read a date it has archived back as it fetched it", () =>
    inArchive({}, () =>
      Effect.gen(function* () {
        const first = yield* fetchedDay()

        const archived = yield* archivedDay()

        assert.deepStrictEqual(archived, first)
      })
    )
  )

  it.effect("should fail a date not archived as NotArchived, without fetching it", () =>
    inArchive({}, ({ requests }) =>
      Effect.gen(function* () {
        const archive = yield* Archive

        const error = yield* Effect.flip(archive.archived("nfl", GameDay.make("2026-10-11")))

        const urls = yield* requests
        assert.instanceOf(error, ArchiveFetchFailed)
        assert.deepStrictEqual(
          [error.league, error.date, error.reason, error.game],
          ["nfl", "2026-10-11", "NotArchived", undefined]
        )
        assert.deepStrictEqual(urls, [])
      })
    )
  )

  it.effect("should fail a summary that keeps failing as Unreachable after five tries, keeping nothing", () =>
    inArchive(
      { answer: (url) => (url === summaryUrl ? new Response("", { status: 503 }) : undefined) },
      ({ dir, requests }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(fetchedDay())

          const urls = yield* requests
          const kept = yield* fileExists(`${dir}/archive/nfl/summary/401872971.json.gz`)
          assert.deepStrictEqual([error.reason, error.game], ["Unreachable", neBuf])
          assert.strictEqual(urls.filter((url) => url === summaryUrl).length, 5)
          assert.isFalse(kept)
        })
    )
  )

  it.effect("should fail a summary whose body is not JSON as Unreadable, keeping nothing", () =>
    inArchive({ answer: unreadableOnce(summaryUrl) }, ({ dir }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(fetchedDay())

        const kept = yield* fileExists(`${dir}/archive/nfl/summary/401872971.json.gz`)
        assert.deepStrictEqual([error.reason, error.game], ["Unreadable", neBuf])
        assert.isFalse(kept)
      })
    )
  )

  it.effect("should fetch an unreadable summary again on the next call", () =>
    inArchive({ answer: unreadableOnce(summaryUrl) }, ({ requests }) =>
      Effect.gen(function* () {
        yield* Effect.flip(fetchedDay())

        const games = yield* fetchedDay()

        const urls = yield* requests
        assert.deepStrictEqual(
          games.map((game) => game.final.id),
          [neBuf]
        )
        assert.strictEqual(urls.filter((url) => url === summaryUrl).length, 2)
      })
    )
  )

  it.effect("should try a 429 again", () =>
    inArchive({ answer: refusedOnce(summaryUrl, 429) }, ({ requests }) =>
      Effect.gen(function* () {
        const games = yield* fetchedDay()

        const urls = yield* requests
        assert.strictEqual(games.length, 1)
        assert.strictEqual(urls.filter((url) => url === summaryUrl).length, 2)
      })
    )
  )

  it.effect("should skip a game whose summary is gone, archiving its refusal", () =>
    inArchive({ answer: gone(refusedSummaryUrl) }, ({ dir, requests }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        const games = yield* fetchedDay()

        const fetched = yield* requests
        const kept = yield* fs.exists(`${dir}/archive/nfl/summary/401872965.json.gz`)
        const refusal = yield* fs.readFileString(`${dir}/archive/nfl/summary/401872965.refused.json`)
        assert.deepStrictEqual(
          games.map((game) => game.final.id),
          [neBuf]
        )
        assert.strictEqual(fetched.length, 15, "the scoreboard and every summary, the refused one once")
        assert.isFalse(kept)
        assert.include(refusal, '"status":404')
      })
    )
  )

  it.effect("should rebuild a date with a summary that is gone from the archive", () =>
    inArchive({ answer: gone(refusedSummaryUrl) }, () =>
      Effect.gen(function* () {
        const games = yield* fetchedDay()

        const archived = yield* archivedDay()

        assert.deepStrictEqual(archived, games)
      })
    )
  )

  it.effect("should not fetch a summary that is gone again", () =>
    inArchive({ answer: gone(refusedSummaryUrl) }, ({ requests }) =>
      Effect.gen(function* () {
        const games = yield* fetchedDay()
        const fetched = yield* requests

        const again = yield* fetchedDay()

        const urls = yield* requests
        assert.deepStrictEqual(again, games)
        assert.strictEqual(urls.length, fetched.length)
      })
    )
  )

  it.effect("should fail the date on a summary refused otherwise, leaving no marker", () =>
    inArchive({ answer: refusedOnce(refusedSummaryUrl, 403) }, ({ dir }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(fetchedDay())

        const marked = yield* fileExists(`${dir}/archive/nfl/summary/401872965.refused.json`)
        const kept = yield* fileExists(`${dir}/archive/nfl/summary/401872965.json.gz`)
        assert.deepStrictEqual([error.reason, error.game], ["Refused", refusedGame])
        assert.isFalse(marked)
        assert.isFalse(kept)
      })
    )
  )

  it.effect("should fetch a summary refused otherwise again on the next call", () =>
    inArchive({ answer: refusedOnce(refusedSummaryUrl, 403) }, ({ requests }) =>
      Effect.gen(function* () {
        yield* Effect.flip(fetchedDay())

        const games = yield* fetchedDay()

        const urls = yield* requests
        assert.deepStrictEqual(
          games.map((game) => game.final.id),
          [neBuf]
        )
        assert.strictEqual(urls.filter((url) => url === refusedSummaryUrl).length, 2)
      })
    )
  )

  it.effect("should fail a final game with neither its summary nor a refusal as NotArchived", () =>
    inArchive({}, ({ dir, requests }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fetchedDay()
        const fetched = yield* requests
        yield* fs.remove(`${dir}/archive/nfl/summary/401872971.json.gz`)

        const error = yield* Effect.flip(archivedDay())

        const urls = yield* requests
        assert.deepStrictEqual([error.reason, error.game], ["NotArchived", neBuf])
        assert.strictEqual(urls.length, fetched.length)
      })
    )
  )

  it.effect("should fail the date on a refused scoreboard", () =>
    inArchive({ answer: gone(scoreboardUrl) }, ({ requests }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(fetchedDay())

        const urls = yield* requests
        assert.deepStrictEqual([error.reason, error.game], ["Refused", undefined])
        assert.deepStrictEqual(urls, [scoreboardUrl])
      })
    )
  )
})

/** 2026-10-04's NFL games from the archive, fetching what it has not archived, the test clock stepped through. */
function fetchedDay() {
  return Archive.use((archive) => stepped(archive.games("nfl", GameDay.make("2026-10-04"))))
}

/** 2026-10-04's NFL games from what is archived only. */
function archivedDay() {
  return Archive.use((archive) => archive.archived("nfl", GameDay.make("2026-10-04")))
}

function fileExists(path: string) {
  return FileSystem.FileSystem.use((fs) => fs.exists(path))
}

/** Answers `url` with a 404, every time. */
function gone(url: string) {
  return (requested: string) => (requested === url ? new Response("", { status: 404 }) : undefined)
}

/** Answers `url`'s first request with `status`. */
function refusedOnce(url: string, status: number) {
  return (requested: string, earlier: number) =>
    requested === url && earlier === 0 ? new Response("", { status }) : undefined
}

/** Answers `url`'s first request with a page that is not JSON. */
function unreadableOnce(url: string) {
  return (requested: string, earlier: number) =>
    requested === url && earlier === 0 ? new Response("<html>Service Unavailable</html>") : undefined
}
