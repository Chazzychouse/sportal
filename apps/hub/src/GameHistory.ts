import { type GameId, GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { LiveGame } from "@sportal/domain/LiveGame"
import { Play, type PlayId } from "@sportal/domain/Play"
import { Array as Arr, Context, Effect, Equal, Filter, Layer, Metric, Option, Schema, Stream } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import * as Database from "./database/Database.ts"
import { LiveGames } from "./LiveGames.ts"

/** Past plays and each game's latest snapshot, derived from the fold into the Hub's database. Rebuildable from the feed log. */
export class GameHistory extends Context.Service<
  GameHistory,
  {
    /** A game's stored plays, in play order; a game that left the live games keeps the plays it had. */
    plays(game: GameId): Effect.Effect<ReadonlyArray<Play>, GameHistoryError>
    /** A game's latest stored snapshot, if it has one. */
    latest(game: GameId): Effect.Effect<Option.Option<GameSnapshot>, GameHistoryError>
  }
>()("sportal/hub/GameHistory") {
  /**
   * Follows `LiveGames.changes`, writing what changed since the last write, in batches every 250 ms. Every listed game
   * gets its latest snapshot written (a final game is often only listed), plus any live game not listed; plays come
   * from live games only. A game that leaves `live` and is never listed again keeps its last written snapshot. Only the
   * latest snapshot is kept: the changes are sampled by the batch, so a per-status history could not be rebuilt from
   * the feed log. A write that fails is logged and counted, and the next change writes what it missed.
   */
  static readonly layer: Layer.Layer<GameHistory, never, SqlClient.SqlClient | LiveGames> = Layer.effect(
    GameHistory,
    Effect.gen(function* () {
      yield* Database.migrate("history", migrations).pipe(Effect.orDie)
      const sql = yield* SqlClient.SqlClient
      const liveGames = yield* LiveGames

      const playRows = SqlSchema.findAll({
        Request: Schema.String,
        Result: Schema.Struct({ body: Schema.fromJsonString(Play) }),
        execute: (game) =>
          sql`SELECT body FROM play WHERE game = ${game} ORDER BY json_extract(body, '$.sequence')`
      })
      const snapshotRows = SqlSchema.findAll({
        Request: Schema.String,
        Result: Schema.Struct({ body: Schema.fromJsonString(GameSnapshot) }),
        execute: (game) => sql`SELECT body FROM game_snapshot WHERE game = ${game}`
      })

      const encodePlay = Schema.encodeEffect(Schema.fromJsonString(Play))
      const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(GameSnapshot))

      // One transaction for everything the step changed: it is written whole or not at all.
      const store = (step: Step, seq: number) =>
        Effect.gen(function* () {
          const latest = yield* Effect.forEach(step.latest, ([game, snapshot]) =>
            Effect.map(encodeSnapshot(snapshot), (body) => ({ game, status: snapshot.status, body }))
          )
          const plays = yield* Effect.forEach(step.plays, ({ game, upserts, kept }) =>
            Effect.map(
              Effect.forEach(upserts, (play) =>
                Effect.map(encodePlay(play), (body) => ({ game, id: play.id, seq, body }))
              ),
              (rows) => ({ game, rows, kept })
            )
          )
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* Effect.forEach(
                plays,
                ({ game, rows, kept }) =>
                  Effect.andThen(
                    Arr.isReadonlyArrayNonEmpty(rows)
                      ? sql`
                          INSERT INTO play ${sql.insert(rows)}
                          ON CONFLICT (game, id) DO UPDATE SET seq = excluded.seq, body = excluded.body
                          WHERE excluded.seq > play.seq
                        `
                      : Effect.void,
                    sql`
                      DELETE FROM play
                      WHERE game = ${game} AND seq < ${seq}
                        AND id NOT IN (SELECT value FROM json_each(${JSON.stringify(kept)}))
                    `
                  ),
                { discard: true }
              )
              yield* Effect.forEach(
                latest,
                (row) =>
                  sql`
                    INSERT INTO game_snapshot ${sql.insert({ ...row, seq })}
                    ON CONFLICT (game) DO UPDATE SET
                      seq = excluded.seq, status = excluded.status, body = excluded.body
                    WHERE excluded.seq > game_snapshot.seq
                  `,
                { discard: true }
              )
            })
          )
        })

      // A change that cannot be written leaves `written` as it was, so the next change diffs from the last success.
      const write = (
        written: Written,
        { seq, folded }: { seq: number; folded: Parameters<typeof writtenOf>[0] }
      ) => {
        const next = writtenOf(folded)
        return store(stepFrom(written, next), seq).pipe(
          Effect.as(next),
          Effect.catch((error) =>
            Effect.logError("GameHistory: could not write; it will try again on the next change", error).pipe(
              Effect.andThen(Metric.update(writeFailures, 1)),
              Effect.as(written)
            )
          )
        )
      }

      yield* liveGames.changes.pipe(
        Stream.filterMap(
          Filter.fromPredicateOption((folded) => Option.map(folded.seq, (seq) => ({ seq, folded })))
        ),
        Stream.groupedWithin(1024, "250 millis"),
        Stream.runFoldEffect(
          (): Written => ({ snapshots: new Map(), plays: new Map() }),
          (written, group) =>
            Arr.match(group, {
              onEmpty: () => Effect.succeed(written),
              onNonEmpty: (changes) => write(written, Arr.lastNonEmpty(changes))
            })
        ),
        Effect.forkScoped
      )

      return GameHistory.of({
        plays: (game) =>
          playRows(game).pipe(
            Effect.map((rows) => rows.map(({ body }) => body)),
            Effect.mapError((cause) => new GameHistoryError({ cause }))
          ),
        latest: (game) =>
          snapshotRows(game).pipe(
            Effect.map((rows) => Option.map(Arr.head(rows), ({ body }) => body)),
            Effect.mapError((cause) => new GameHistoryError({ cause }))
          )
      })
    })
  )
}

/** The history could not read. */
export class GameHistoryError extends Schema.TaggedError<GameHistoryError>()("GameHistoryError", {
  cause: Schema.Defect()
}) {}

/** What the history has written: each game's snapshot, and each live game's plays. */
type Written = {
  readonly snapshots: ReadonlyMap<GameId, GameSnapshot>
  readonly plays: ReadonlyMap<GameId, ReadonlyArray<Play>>
}

/** What a step must write to bring one `Written` to the next. */
type Step = {
  readonly latest: ReadonlyArray<readonly [GameId, GameSnapshot]>
  readonly plays: ReadonlyArray<{
    readonly game: GameId
    readonly upserts: ReadonlyArray<Play>
    readonly kept: ReadonlyArray<PlayId>
  }>
}

/** The folded state as the history keeps it: every listed game as the fold has it, plus live games not listed. */
function writtenOf(folded: {
  readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly live: ReadonlyMap<GameId, LiveGame>
}): Written {
  const listed = [...folded.listed.values()].flatMap((games) => LiveGame.asFolded(games, folded.live))
  const unlisted = [...folded.live.values()]
    .map(({ snapshot }) => snapshot)
    .filter((snapshot) => !listed.some(({ id }) => id === snapshot.id))
  return {
    snapshots: new Map([...listed, ...unlisted].map((snapshot) => [snapshot.id, snapshot])),
    plays: new Map([...folded.live].map(([game, liveGame]) => [game, liveGame.plays]))
  }
}

function stepFrom(before: Written, after: Written): Step {
  const snapshots = [...after.snapshots].flatMap(([game, snapshot]) => {
    const had = before.snapshots.get(game)
    return had !== undefined && Equal.equals(had, snapshot) ? [] : [{ game, snapshot }]
  })
  return {
    latest: snapshots.map(({ game, snapshot }) => [game, snapshot]),
    plays: [...after.plays].flatMap(([game, plays]) => {
      const had = before.plays.get(game)
      if (had !== undefined && sameAll(had, plays)) return []
      const stored = new Map((had ?? []).map((play) => [play.id, play]))
      return [
        {
          game,
          upserts: plays.filter((play) => !Equal.equals(stored.get(play.id), play)),
          kept: plays.map(({ id }) => id)
        }
      ]
    })
  }
}

const sameAll = Arr.makeEquivalence(Equal.asEquivalence<Play>())

const writeFailures = Metric.counter("sportal_history_write_failures", {
  description: "Changes the game history could not write; the next change writes what they missed",
  incremental: true
})

/** This store's migrations, recorded in `history_migrations`. */
const migrations = {
  "1_create_history": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE play (
        game TEXT NOT NULL,
        id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (game, id)
      )
    `
    yield* sql`
      CREATE TABLE game_snapshot (
        game TEXT NOT NULL PRIMARY KEY,
        seq INTEGER NOT NULL,
        status TEXT NOT NULL,
        body TEXT NOT NULL
      )
    `
  })
}
