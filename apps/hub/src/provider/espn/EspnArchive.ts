import { type GameId, GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import {
  Array as Arr,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Schema,
  Stream
} from "effect"
import { HttpClient, type HttpClientError } from "effect/http"
import { Archive, ArchivedGame, ArchiveFetchFailed } from "../../corpus/Archive.ts"
import * as Gzip from "../../Gzip.ts"
import { HubConfig } from "../../HubConfig.ts"
import { EspnEvent, Scoreboard } from "./EspnEvent.ts"
import * as EspnProvider from "./EspnProvider.ts"
import * as EspnSummary from "./EspnSummary.ts"

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
  Archive,
  never,
  HttpClient.HttpClient | HubConfig | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  Archive,
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const archive = path.join((yield* HubConfig).corpusDir, "archive")

    // `bytes` at `file`, written whole or not at all. A corpus directory that cannot be written stops the command.
    const write = (file: string, bytes: Uint8Array) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFile(`${file}.tmp`, bytes)
        yield* fs.rename(`${file}.tmp`, file)
      }).pipe(Effect.orDie)

    // Fetches `url` and keeps its body at `file` once it reads as JSON; when it is refused and `refusal` names a
    // file, the refusal is kept there instead.
    const fetch = (url: string, file: string, failed: Failed, refusal?: string) =>
      client.get(url).pipe(
        Effect.flatMap((response) => response.text),
        Effect.tapError((cause) => {
          const { reason } = cause
          return refusal === undefined ||
            reason._tag !== "StatusCodeError" ||
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
        Effect.retry(retry),
        Effect.tap((body) => decodeJson(body).pipe(Effect.mapError((cause) => failed("Unreadable", cause)))),
        // Compressing text in memory cannot fail.
        Effect.flatMap((body) => Gzip.compress(body).pipe(Effect.orDie)),
        Effect.flatMap((bytes) => write(file, bytes)),
        Effect.withSpan("EspnArchive.fetch", { attributes: { "url.full": url } })
      )

    // The file's text, or `missing` (which fetches it, or fails) when it is not archived.
    const kept = (file: string, failed: Failed, missing: Effect.Effect<void, ArchiveFetchFailed>) =>
      Effect.gen(function* () {
        if (!(yield* exists(file, failed))) yield* missing
        return yield* fs.readFile(file).pipe(
          Effect.flatMap((bytes) => Gzip.decompress(bytes, "gzip")),
          Effect.mapError((cause) => failed("Unreadable", cause))
        )
      })

    const exists = (file: string, failed: Failed) =>
      fs.exists(file).pipe(Effect.mapError((cause) => failed("Unreadable", cause)))

    const gamesOf = (league: LeagueId, date: string, how: "fetch" | "archived") =>
      Effect.gen(function* () {
        const files = {
          scoreboard: path.join(archive, league, "scoreboard", `${date}.json.gz`),
          summary: (game: GameId) => path.join(archive, league, "summary", `${game}.json.gz`),
          refusal: (game: GameId) => path.join(archive, league, "summary", `${game}.refused.json`)
        }
        const failed =
          (game?: GameId): Failed =>
          (reason, cause) =>
            new ArchiveFetchFailed({ league, date, ...(game === undefined ? {} : { game }), reason, cause })
        const missing = (url: string, file: string, game?: GameId) =>
          how === "fetch"
            ? fetch(url, file, failed(game))
            : Effect.fail(failed(game)("NotArchived", path.relative(archive, file)))

        const scoreboardUrl = new URL(EspnProvider.scoreboardUrl(league))
        scoreboardUrl.searchParams.set("dates", date.replaceAll("-", ""))
        const finals = yield* kept(
          files.scoreboard,
          failed(),
          missing(scoreboardUrl.toString(), files.scoreboard)
        ).pipe(
          Effect.flatMap((body) =>
            decodeScoreboard(body).pipe(Effect.mapError((cause) => failed()("Unreadable", cause)))
          ),
          Effect.flatMap(({ events }) => {
            const decodeEvent = Schema.decodeUnknownEffect(EspnEvent(league))
            return Effect.forEach(events, (event) => finalOf(league, date, decodeEvent(event)))
          }),
          Effect.map(Arr.getSomes)
        )

        const summaryUrl = (game: GameId) => `${EspnProvider.siteUrl(league)}/summary?event=${game}`
        if (how === "fetch") {
          yield* Stream.fromIterable(
            yield* Effect.filter(finals, (game) =>
              Effect.map(
                Effect.all([
                  exists(files.summary(game.id), failed(game.id)),
                  exists(files.refusal(game.id), failed(game.id))
                ]),
                ([archived, refused]) => !archived && !refused
              )
            )
          ).pipe(
            Stream.schedule(pacing),
            Stream.runForEach((game) =>
              fetch(
                summaryUrl(game.id),
                files.summary(game.id),
                failed(game.id),
                files.refusal(game.id)
              ).pipe(
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

        const refusalOf = (game: GameSnapshot) =>
          Effect.gen(function* () {
            const file = files.refusal(game.id)
            if (!(yield* exists(file, failed(game.id)))) return Option.none()
            return Option.some(
              yield* fs.readFileString(file).pipe(
                Effect.flatMap(decodeRefusal),
                Effect.mapError((cause) => failed(game.id)("Unreadable", cause))
              )
            )
          })

        return yield* Effect.forEach(finals, (final) =>
          Effect.flatMap(refusalOf(final), (refusal) =>
            Option.isSome(refusal)
              ? Effect.as(
                  Effect.logWarning(
                    `Archive: ${league} game ${final.id} (${final.away.team.abbreviation} at ${final.home.team.abbreviation}) had its summary refused (${refusal.value.status}, ${DateTime.formatIso(refusal.value.refusedAt)}); skipped`
                  ),
                  Option.none()
                )
              : kept(
                  files.summary(final.id),
                  failed(final.id),
                  missing(summaryUrl(final.id), files.summary(final.id), final.id)
                ).pipe(
                  Effect.flatMap((body) =>
                    decodeJson(body).pipe(
                      Effect.flatMap((summary) => EspnSummary.plays(league, summary)),
                      Effect.mapError((cause) => failed(final.id)("Unreadable", cause))
                    )
                  ),
                  Effect.flatMap((plays) =>
                    plays.length === 0
                      ? Effect.as(
                          Effect.logWarning(
                            `Archive: ${league} game ${final.id} (${final.away.team.abbreviation} at ${final.home.team.abbreviation}) has no plays with wallclocks; skipped`
                          ),
                          Option.none()
                        )
                      : Effect.succeedSome(new ArchivedGame({ scheduled: scheduled(final), final, plays }))
                  )
                )
          )
        ).pipe(Effect.map(Arr.getSomes))
      }).pipe(
        Effect.withSpan("EspnArchive.games", {
          attributes: { "sportal.league": league, "sportal.date": date, "sportal.archive": how }
        })
      )

    return Archive.of({
      games: (league, date) => gamesOf(league, date, "fetch"),
      archived: (league, date) => gamesOf(league, date, "archived"),
      pacing,
      retry
    })
  })
)

const pacing = Schedule.spaced("500 millis")

// Unreachable only, five tries in all: the first, then four more after 1, 2, 4, and 8 seconds, each jittered.
const retry = Schedule.max([Schedule.exponential("1 second"), Schedule.recurs(4)]).pipe(
  Schedule.jittered,
  Schedule.setInputType<ArchiveFetchFailed>(),
  Schedule.while(({ input }) => input.reason === "Unreachable")
)

type Failed = (reason: ArchiveFetchFailed["reason"], cause: unknown) => ArchiveFetchFailed

function reasonOf(cause: HttpClientError.HttpClientError): ArchiveFetchFailed["reason"] {
  return cause.reason._tag === "StatusCodeError"
    ? cause.reason.response.status >= 500 || cause.reason.response.status === 429
      ? "Unreachable"
      : "Refused"
    : cause.reason._tag === "DecodeError" || cause.reason._tag === "EmptyBodyError"
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

const decodeScoreboard = Schema.decodeUnknownEffect(Schema.fromJsonString(Scoreboard))

/** The decoded event as its final game; one that does not decode, or is not final, is logged and skipped. */
function finalOf(league: LeagueId, date: string, event: Effect.Effect<GameSnapshot, Schema.SchemaError>) {
  return event.pipe(
    Effect.flatMap((game) =>
      game.status === "final"
        ? Effect.succeedSome(game)
        : Effect.as(
            Effect.logWarning(
              `Archive: ${league} game ${game.id} (${game.away.team.abbreviation} at ${game.home.team.abbreviation}) on ${date} is ${game.status}; skipped`
            ),
            Option.none()
          )
    ),
    Effect.catchTag("SchemaError", (cause) =>
      Effect.as(
        Effect.logWarning(`Archive: an ${league} event on ${date} does not read; skipped`, cause),
        Option.none()
      )
    )
  )
}

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
