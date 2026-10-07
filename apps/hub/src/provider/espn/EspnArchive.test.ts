import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Effect, FileSystem } from "effect"
import { Archive, ArchiveFetchFailed } from "../../corpus/Archive.ts"
import {
  inArchive,
  scoreboardUrl,
  site,
  stepped,
  archivedSummary as summary,
  summaryUrl
} from "../../corpus/TestCorpus.ts"
import * as Gzip from "../../Gzip.ts"

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

  it.effect(
    "a summary that is gone is archived as refused: its game is skipped, the date rebuilds, and it is not fetched again",
    () =>
      inArchive(
        {
          answer: (url) =>
            url === `${site}/summary?event=401872965` ? new Response("", { status: 404 }) : undefined
        },
        ({ dir, requests }) =>
          Effect.gen(function* () {
            const archive = yield* Archive
            const fs = yield* FileSystem.FileSystem
            const games = yield* stepped(archive.games("nfl", "2026-10-04"))
            const fetched = yield* requests
            const refusal = yield* fs.readFileString(`${dir}/archive/nfl/summary/401872965.refused.json`)
            const archived = yield* archive.archived("nfl", "2026-10-04")
            const again = yield* stepped(archive.games("nfl", "2026-10-04"))

            assert.deepStrictEqual(
              games.map((game) => game.final.id),
              [neBuf]
            )
            assert.strictEqual(fetched.length, 15, "the scoreboard and every summary, the refused one once")
            assert.isFalse(yield* fs.exists(`${dir}/archive/nfl/summary/401872965.json.gz`))
            assert.include(refusal, '"status":404')
            assert.deepStrictEqual(archived, games)
            assert.deepStrictEqual(again, games)
            assert.strictEqual((yield* requests).length, fetched.length)
          })
      )
  )

  it.effect(
    "a summary refused otherwise fails the date and leaves no marker, so the next call fetches it again",
    () =>
      inArchive(
        {
          answer: (url, earlier) =>
            url === `${site}/summary?event=401872965` && earlier === 0
              ? new Response("", { status: 403 })
              : undefined
        },
        ({ dir, requests }) =>
          Effect.gen(function* () {
            const archive = yield* Archive
            const fs = yield* FileSystem.FileSystem
            const error = yield* Effect.flip(stepped(archive.games("nfl", "2026-10-04")))
            const marked = yield* fs.exists(`${dir}/archive/nfl/summary/401872965.refused.json`)
            const kept = yield* fs.exists(`${dir}/archive/nfl/summary/401872965.json.gz`)
            const games = yield* stepped(archive.games("nfl", "2026-10-04"))

            assert.deepStrictEqual([error.reason, error.game], ["Refused", GameId.make("401872965")])
            assert.isFalse(marked)
            assert.isFalse(kept)
            assert.deepStrictEqual(
              games.map((game) => game.final.id),
              [neBuf]
            )
            assert.strictEqual(
              (yield* requests).filter((url) => url === `${site}/summary?event=401872965`).length,
              2
            )
          })
      )
  )

  it.effect("a final game with neither its summary nor a refusal is NotArchived", () =>
    inArchive({}, ({ dir, requests }) =>
      Effect.gen(function* () {
        const archive = yield* Archive
        yield* stepped(archive.games("nfl", "2026-10-04"))
        const fetched = (yield* requests).length
        yield* (yield* FileSystem.FileSystem).remove(`${dir}/archive/nfl/summary/401872971.json.gz`)
        const error = yield* Effect.flip(archive.archived("nfl", "2026-10-04"))

        assert.deepStrictEqual([error.reason, error.game], ["NotArchived", neBuf])
        assert.strictEqual((yield* requests).length, fetched)
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
