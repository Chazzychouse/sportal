import { type GameId, GameSnapshot } from "@sportal/domain/Game"
import type { GameDay } from "@sportal/domain/GameDay"
import type { LeagueId } from "@sportal/domain/League"
import {
  Array as Arr,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schedule,
  Schema,
  Stream
} from "effect"
import { HttpClient, HttpClientError } from "effect/http"
import * as Gzip from "../../Gzip.ts"
import { HubConfig } from "../../HubConfig.ts"
import { ArchiveFetchFailed, Archiver, GameArchive } from "../Archiver.ts"
import * as EspnDecoder from "./EspnDecoder.ts"
import * as EspnProvider from "./EspnProvider.ts"

/**
 * ESPN's archive: a date's site scoreboard, then each final game's summary, each kept as ESPN sent it, gzip'd, as
 * `archive/<league>/scoreboard/<date>.json.gz` and `archive/<league>/summary/<game>.json.gz` under
 * `HubConfig.corpusDir`. A file archived is never fetched again, and a date's summaries are fetched 500 ms apart.
 * A fetch that does not connect, or is answered 429 or with a status of 500 or more, is `Unreachable` and tried again
 * from 1 second later, twice as long each time, jittered, five tries in all; one answered with another status that is
 * not 2xx is `Refused`, and a body that is not JSON is `Unreadable`. A summary that is gone (404 or 410) is archived
 * as a refusal, `summary/<game>.refused.json` (the status, and when): its game is skipped and logged, it is never
 * fetched again, and the date still reads from the archive. Any other refusal, of a summary or a scoreboard, fails
 * the date. A fetch that fails otherwise writes no file, so the next call fetches it again.
 */
export const layer: Layer.Layer<
  Archiver,
  never,
  HttpClient.HttpClient | HubConfig | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  Archiver,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      HttpClient.HttpClient | HubConfig | FileSystem.FileSystem | Path.Path
    >()
    const provide = Effect.provideContext(context)

    return Archiver.of({
      games: (league, date) => provide(gamesOf(league, date, "fetch")),
      archived: (league, date) => provide(gamesOf(league, date, "archived")),
      pacing
    })
  })
)

// The "EspnArchive.*" span names and "Archive: " log prefixes are ids the dashboard is pinned to; keep them as they are.
const gamesOf = Effect.fn("EspnArchive.games")(function* (
  league: LeagueId,
  date: GameDay,
  how: "fetch" | "archived"
) {
  yield* Effect.annotateCurrentSpan({
    "sportal.league": league,
    "sportal.date": date,
    "sportal.archive": how
  })
  const path = yield* Path.Path
  const config = yield* HubConfig

  const archive = path.join(config.corpusDir, "archive")
  const files = {
    scoreboard: path.join(archive, league, "scoreboard", `${date}.json.gz`),
    summary: (game: GameId) => path.join(archive, league, "summary", `${game}.json.gz`),
    refusal: (game: GameId) => path.join(archive, league, "summary", `${game}.refused.json`)
  }
  const failed =
    (game?: GameId) =>
    (reason: ArchiveFetchFailed["reason"], cause: unknown): ArchiveFetchFailed =>
      new ArchiveFetchFailed({ league, date, ...(game === undefined ? {} : { game }), reason, cause })
  const missing = (url: string, file: string, game?: GameId) =>
    how === "fetch"
      ? download(url, file, failed(game))
      : Effect.fail(failed(game)("NotArchived", path.relative(archive, file)))

  const scoreboardUrl = new URL(EspnProvider.scoreboardUrl(league))
  scoreboardUrl.searchParams.set("dates", date.replaceAll("-", ""))
  const finals = yield* kept(
    files.scoreboard,
    failed(),
    missing(scoreboardUrl.toString(), files.scoreboard)
  ).pipe(
    Effect.flatMap((body) =>
      EspnDecoder.byLeague[league]
        .decodeScoreboard(body)
        .pipe(Effect.mapError((cause) => failed()("Unreadable", cause)))
    ),
    Effect.flatMap(({ events }) =>
      Effect.forEach(events, (event) =>
        finalOf(league, date, EspnDecoder.byLeague[league].decodeEvent(event))
      )
    ),
    Effect.map(Arr.getSomes)
  )

  const summaryUrl = (game: GameId) => `${EspnProvider.siteUrl(league)}/summary?event=${game}`
  if (how === "fetch") {
    const unfetched = yield* Effect.filter(finals, (game) =>
      Effect.map(
        Effect.all([
          exists(files.summary(game.id), failed(game.id)),
          exists(files.refusal(game.id), failed(game.id))
        ]),
        ([archived, refused]) => !archived && !refused
      )
    )
    yield* Stream.fromIterable(unfetched).pipe(
      Stream.schedule(pacing),
      Stream.runForEach((game) =>
        download(summaryUrl(game.id), files.summary(game.id), failed(game.id), files.refusal(game.id)).pipe(
          // A gone summary is archived as its refusal, read below; any other refusal fails the date.
          Effect.catchIf(
            (error) => error.reason === "Refused",
            (error) =>
              Effect.flatMap(exists(files.refusal(game.id), failed(game.id)), (refused) =>
                refused ? Effect.void : Effect.fail(error)
              )
          )
        )
      )
    )
  }

  const gameOf = Effect.fnUntraced(function* (final: GameSnapshot) {
    const refusal = yield* refusalOf(files.refusal(final.id), failed(final.id))
    if (Option.isSome(refusal)) {
      yield* Effect.logWarning(
        `Archive: ${league} game ${final.id} (${final.away.team.abbreviation} at ${final.home.team.abbreviation}) had its summary refused (${refusal.value.status}, ${DateTime.formatIso(refusal.value.refusedAt)}); skipped`
      )
      return Option.none<GameArchive>()
    }

    const body = yield* kept(
      files.summary(final.id),
      failed(final.id),
      missing(summaryUrl(final.id), files.summary(final.id), final.id)
    )
    const plays = yield* decodeJson(body).pipe(
      Effect.flatMap(EspnDecoder.byLeague[league].decodeSummary),
      Effect.mapError((cause) => failed(final.id)("Unreadable", cause))
    )
    if (plays.length === 0) {
      yield* Effect.logWarning(
        `Archive: ${league} game ${final.id} (${final.away.team.abbreviation} at ${final.home.team.abbreviation}) has no plays with wallclocks; skipped`
      )
      return Option.none<GameArchive>()
    }
    return Option.some(new GameArchive({ scheduled: scheduled(final), final, plays }))
  })

  const games = yield* Effect.forEach(finals, gameOf)
  return Arr.getSomes(games)
})

/** How a failure of one date's, or one game's, archive is made. */
type Failed = (reason: ArchiveFetchFailed["reason"], cause: unknown) => ArchiveFetchFailed

/** The file's text, or `missing` (which fetches it, or fails) when it is not archived. */
const kept = Effect.fnUntraced(function* (
  file: string,
  failed: Failed,
  missing: Effect.Effect<void, ArchiveFetchFailed, HttpClient.HttpClient | FileSystem.FileSystem | Path.Path>
) {
  const fs = yield* FileSystem.FileSystem
  const archived = yield* exists(file, failed)

  if (!archived) {
    yield* missing
  }
  return yield* fs.readFile(file).pipe(
    Effect.flatMap((bytes) => Gzip.decompress(bytes, "gzip")),
    Effect.mapError((cause) => failed("Unreadable", cause))
  )
})

const exists = Effect.fnUntraced(function* (file: string, failed: Failed) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.exists(file).pipe(Effect.mapError((cause) => failed("Unreadable", cause)))
})

/**
 * Fetches `url` and keeps its body at `file` once it reads as JSON; when it is refused and `refusal` names a file, the
 * refusal is kept there instead.
 */
const download = Effect.fn("EspnArchive.fetch")(function* (
  url: string,
  file: string,
  failed: Failed,
  refusal?: string
) {
  yield* Effect.annotateCurrentSpan("url.full", url)
  const http = yield* HttpClient.HttpClient

  const client = http.pipe(HttpClient.filterStatusOk)
  const body = yield* client.get(url).pipe(
    Effect.flatMap((response) => response.text),
    Effect.tapError((cause) => {
      const { reason } = cause
      return refusal === undefined ||
        !(reason instanceof HttpClientError.StatusCodeError) ||
        !gone.includes(reason.response.status)
        ? Effect.void
        : DateTime.now.pipe(
            Effect.flatMap((refusedAt) => encodeRefusal({ status: reason.response.status, refusedAt })),
            // Encoding a refusal built from its own schema cannot fail.
            Effect.orDie,
            Effect.flatMap((json) => write(refusal, new TextEncoder().encode(json)))
          )
    }),
    Effect.mapError((cause) => failed(reasonOf(cause), cause)),
    Effect.retry(retry)
  )
  yield* decodeJson(body).pipe(Effect.mapError((cause) => failed("Unreadable", cause)))
  // Compressing text in memory cannot fail.
  const bytes = yield* Gzip.compress(body).pipe(Effect.orDie)
  yield* write(file, bytes)
})

/** `bytes` at `file`, written whole or not at all. A corpus directory that cannot be written stops the command. */
const write = Effect.fnUntraced(function* (file: string, bytes: Uint8Array) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* fs.writeFile(`${file}.tmp`, bytes)
  yield* fs.rename(`${file}.tmp`, file)
}, Effect.orDie)

/** The refusal archived at `file` in its summary's place, if there is one. */
const refusalOf = Effect.fnUntraced(function* (file: string, failed: Failed) {
  const fs = yield* FileSystem.FileSystem
  const refused = yield* exists(file, failed)

  if (!refused) return Option.none()
  const refusal = yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeRefusal),
    Effect.mapError((cause) => failed("Unreadable", cause))
  )
  return Option.some(refusal)
})

const pacing = Schedule.spaced("500 millis")

// Unreachable only, five tries in all: the first, then four more after 1, 2, 4, and 8 seconds, each jittered.
const retry = Schedule.max([Schedule.exponential("1 second"), Schedule.recurs(4)]).pipe(
  Schedule.jittered,
  Schedule.setInputType<ArchiveFetchFailed>(),
  Schedule.while(({ input }) => input.reason === "Unreachable")
)

function reasonOf(cause: HttpClientError.HttpClientError): ArchiveFetchFailed["reason"] {
  const { reason } = cause
  return reason instanceof HttpClientError.StatusCodeError
    ? reason.response.status >= 500 || reason.response.status === 429
      ? "Unreachable"
      : "Refused"
    : reason instanceof HttpClientError.DecodeError || reason instanceof HttpClientError.EmptyBodyError
      ? "Unreadable"
      : "Unreachable"
}

// The statuses that say a summary is gone for good, and is archived as refused.
const gone: ReadonlyArray<number> = [404, 410]

// A refused summary, archived in its place so the date is never fetched for it again, and still rebuilds.
const Refusal = Schema.Struct({ status: Schema.Int, refusedAt: Schema.DateTimeUtcFromString })

const encodeRefusal = Schema.encodeEffect(Schema.fromJsonString(Refusal))

const decodeRefusal = Schema.decodeEffect(Schema.fromJsonString(Refusal))

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/** The decoded event as its final game; one that does not decode, or is not final, is logged and skipped. */
const finalOf = Effect.fnUntraced(function* (
  league: LeagueId,
  date: string,
  event: Effect.Effect<GameSnapshot, Schema.SchemaError>
) {
  const decoded = yield* event.pipe(Effect.result)
  if (Result.isFailure(decoded)) {
    yield* Effect.logWarning(`Archive: an ${league} event on ${date} does not read; skipped`, decoded.failure)
    return Option.none<GameSnapshot>()
  }

  const game = decoded.success
  if (game.status === "final") return Option.some(game)
  yield* Effect.logWarning(
    `Archive: ${league} game ${game.id} (${game.away.team.abbreviation} at ${game.home.team.abbreviation}) on ${date} is ${game.status}; skipped`
  )
  return Option.none<GameSnapshot>()
})

/** The final game as ESPN's scoreboard shows it before kickoff: scheduled, no period, no score, no situation. */
function scheduled(final: GameSnapshot): GameSnapshot {
  return new GameSnapshot({
    id: final.id,
    league: final.league,
    kickoff: final.kickoff,
    status: "scheduled",
    period: 0,
    clock: "0:00",
    home: { ...final.home, score: 0 },
    away: { ...final.away, score: 0 },
    broadcasts: final.broadcasts
  })
}
