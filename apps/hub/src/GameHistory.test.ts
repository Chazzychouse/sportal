import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { type Play, PlayId } from "@sportal/domain/Play"
import { play, snapshot } from "@sportal/domain/TestGame"
import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import * as Database from "./Database.ts"
import { GameHistory } from "./GameHistory.ts"
import { LiveSlate } from "./LiveSlate.ts"
import { delivered, slateFollowing } from "./TestLiveSlate.ts"
import { counted, withMetrics } from "./TestTelemetry.ts"

const one = GameId.make("1")
const first = PlayId.make("a")
const second = PlayId.make("b")

describe("GameHistory", () => {
  it.effect("should make a game's plays readable after its Plays delivery", () =>
    Effect.gen(function* () {
      yield* pushedSnapshot(live)

      yield* playsDelivered([play({ id: first, sequence: 1 }), play({ id: second, sequence: 2 })])
      yield* batched

      const ids = yield* playIds
      assert.deepStrictEqual(ids, [first, second])
    }).pipe(Effect.provide(history))
  )

  it.effect("should replace a revised play's row", () =>
    Effect.gen(function* () {
      yield* pushedSnapshot(live)
      yield* playsDelivered([play({ id: first, text: "before" })])
      yield* batched

      yield* playsDelivered([play({ id: first, text: "after" })])
      yield* batched

      const plays = yield* GameHistory.use((gameHistory) => gameHistory.plays(one))
      assert.deepStrictEqual(
        plays.map(({ text }) => text),
        ["after"]
      )
    }).pipe(Effect.provide(history))
  )

  it.effect("should drop the row of a play no longer in a live game's list", () =>
    Effect.gen(function* () {
      yield* pushedSnapshot(live)
      yield* playsDelivered([play({ id: first, sequence: 1 }), play({ id: second, sequence: 2 })])
      yield* batched

      yield* playsDelivered([play({ id: second, sequence: 2 })])
      yield* batched

      const ids = yield* playIds
      assert.deepStrictEqual(ids, [second])
    }).pipe(Effect.provide(history))
  )

  it.effect("should keep the plays of a game that leaves the live games", () =>
    Effect.gen(function* () {
      yield* pushedSnapshot(live)
      yield* playsDelivered([play({ id: first })])
      yield* batched

      yield* pushedSnapshot(over)
      yield* batched

      const latest = yield* LiveSlate.use((slate) => slate.latest)
      const ids = yield* playIds
      assert.isFalse(latest.live.has(one))
      assert.deepStrictEqual(ids, [first])
    }).pipe(Effect.provide(history))
  )

  it.effect("should make the latest row follow the newest snapshot", () =>
    Effect.gen(function* () {
      yield* pushedSnapshot(live)
      yield* batched

      yield* pushedSnapshot(over)
      yield* delivered(Delivery.cases.Listing.make({ league: "fbs", games: [over] }))
      yield* batched

      const latest = yield* GameHistory.use((gameHistory) => gameHistory.latest(one))
      assert.deepStrictEqual(
        Option.map(latest, ({ status, period }) => `${status}/${period}`),
        Option.some("final/4")
      )
    }).pipe(Effect.provide(history))
  )

  it.effect("should keep the snapshot of a final game that is only listed", () =>
    Effect.gen(function* () {
      yield* delivered(Delivery.cases.Listing.make({ league: "fbs", games: [over] }))
      yield* batched

      const slate = yield* LiveSlate.use((liveSlate) => liveSlate.latest)
      const latest = yield* GameHistory.use((gameHistory) => gameHistory.latest(one))
      assert.isFalse(slate.live.has(one))
      assert.deepStrictEqual(
        Option.map(latest, ({ status }) => status),
        Option.some("final")
      )
    }).pipe(Effect.provide(history))
  )

  it.effect("should change nothing for a play taken again at an older seq", () =>
    Effect.gen(function* () {
      // A slate whose log reached frame 5, then a fresh one whose log numbers its frames again from 1, as a log reopened
      // after a crash does, over the same history.
      yield* playAtFrame(5, "newer").pipe(Effect.provide(following))

      const plays = yield* playAtFrame(3, "older").pipe(
        Effect.andThen(GameHistory.use((gameHistory) => gameHistory.plays(one))),
        Effect.provide(following)
      )

      assert.deepStrictEqual(
        plays.map(({ text }) => text),
        ["newer"]
      )
    }).pipe(Effect.provide(Database.at(":memory:")))
  )

  it.effect("should count a write that fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* pushedSnapshot(live)
      yield* batched
      yield* sql`ALTER TABLE play RENAME TO play_away`

      yield* playsDelivered([play({ id: first })])
      yield* batched

      const failures = yield* counted("sportal_history_write_failures")
      assert.strictEqual(failures, 1)
    }).pipe(Effect.provide(history), withMetrics)
  )

  it.effect("should write what was missed on the next change after a write fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* pushedSnapshot(live)
      yield* batched
      yield* sql`ALTER TABLE play RENAME TO play_away`
      yield* playsDelivered([play({ id: first })])
      yield* batched
      yield* sql`ALTER TABLE play_away RENAME TO play`

      yield* playsDelivered([play({ id: first }), play({ id: second, sequence: 2 })])
      yield* batched

      const ids = yield* playIds
      assert.deepStrictEqual(ids, [first, second])
    }).pipe(Effect.provide(history), withMetrics)
  )

  it.effect("should start with no plays after migrating a database that held plays of the old shape", () =>
    Effect.gen(function* () {
      const plays = yield* afterMigrating(GameHistory.use((gameHistory) => gameHistory.plays(one)))

      assert.deepStrictEqual(plays, [])
    }).pipe(Effect.provide(Database.at(":memory:")))
  )

  it.effect("should keep game snapshots through the migration", () =>
    Effect.gen(function* () {
      const latest = yield* afterMigrating(GameHistory.use((gameHistory) => gameHistory.latest(one)))

      assert.deepStrictEqual(
        Option.map(latest, ({ status }) => status),
        Option.some("live")
      )
    }).pipe(Effect.provide(Database.at(":memory:")))
  )
})

const live = snapshot({ id: one, status: "live", period: 1, clock: "10:00" })
const over = snapshot({ id: one, status: "final", period: 4, clock: "0:00" })

// The history over a fresh slate, writing to the Hub's database.
const following = GameHistory.layer.pipe(Layer.provideMerge(slateFollowing()))

// The slate, the Hub's database in memory, and the history that follows the one and writes the other.
const history = following.pipe(Layer.provideMerge(Database.at(":memory:")))

// Past the writer's 250 ms batch window, then lets the write finish.
const batched = Effect.yieldNow.pipe(Effect.andThen(TestClock.adjust("250 millis")))

const playIds = GameHistory.use((gameHistory) => gameHistory.plays(one)).pipe(
  Effect.map((plays) => plays.map(({ id }) => id))
)

function pushedSnapshot(game: GameSnapshot) {
  return delivered(Delivery.cases.Snapshot.make({ snapshot: game, from: "push" }))
}

function playsDelivered(plays: ReadonlyArray<Play>) {
  return delivered(Delivery.cases.Plays.make({ game: one, plays }))
}

/** The game pushed in each frame before `seq`, then the play `first` with `text` in frame `seq`, written. */
function playAtFrame(seq: number, text: string) {
  return Effect.gen(function* () {
    yield* Effect.forEach(Arr.range(1, seq - 1), () => pushedSnapshot(live), { discard: true })
    yield* playsDelivered([play({ id: first, text })])
    yield* batched
  })
}

// Runs `effect` over a history that opens a database holding what the code before the play union left in it: the first
// migration run, a play row of the old shape, a snapshot row.
function afterMigrating<A, E>(effect: Effect.Effect<A, E, GameHistory>) {
  return stored().pipe(Effect.andThen(effect.pipe(Effect.provide(following))))
}

function stored() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* Database.migrate("history", {
      "1_create_history": Effect.gen(function* () {
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
    })

    // A play row from before plays became FootballPlay cases: one flat shape with a `kind`.
    const oldPlay = JSON.stringify({
      id: first,
      sequence: 1,
      period: 1,
      clock: "10:00",
      kind: "rush",
      text: "A rush",
      yards: 1,
      scoring: false,
      homeScore: 0,
      awayScore: 0,
      start: {},
      end: {}
    })
    const snapshotBody = yield* Schema.encodeEffect(Schema.fromJsonString(GameSnapshot))(live)

    yield* sql`INSERT INTO play (game, id, seq, body) VALUES (${one}, ${first}, 1, ${oldPlay})`
    yield* sql`INSERT INTO game_snapshot (game, seq, status, body) VALUES (${one}, 1, ${live.status}, ${snapshotBody})`
  })
}
