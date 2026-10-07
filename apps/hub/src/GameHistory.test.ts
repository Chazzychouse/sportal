import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { PlayId } from "@sportal/domain/Play"
import { play, snapshot } from "@sportal/domain/TestGame"
import { Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import * as Database from "./Database.ts"
import { GameHistory } from "./GameHistory.ts"
import { LiveSlate } from "./LiveSlate.ts"
import { delivered, slateFollowing } from "./TestFeed.ts"
import { counted, withMetrics } from "./TestTelemetry.ts"

const one = GameId.make("1")
const first = PlayId.make("a")
const second = PlayId.make("b")

describe("GameHistory", () => {
  it.effect("a game's plays are readable after its Plays delivery", () =>
    Effect.gen(function* () {
      yield* delivered(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }))
      yield* delivered(
        Delivery.cases.Plays.make({
          game: one,
          plays: [play({ id: first, sequence: 1 }), play({ id: second, sequence: 2 })]
        })
      )
      yield* batched
      assert.deepStrictEqual(yield* playIds, [first, second])
    }).pipe(Effect.provide(history))
  )

  it.effect("a revised play replaces its row", () =>
    Effect.gen(function* () {
      yield* delivered(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }))
      yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [play({ id: first, text: "before" })] }))
      yield* batched
      yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [play({ id: first, text: "after" })] }))
      yield* batched
      const plays = yield* GameHistory.use((gameHistory) => gameHistory.plays(one))
      assert.deepStrictEqual(
        plays.map(({ text }) => text),
        ["after"]
      )
    }).pipe(Effect.provide(history))
  )

  it.effect("a play no longer in a live game's list loses its row", () =>
    Effect.gen(function* () {
      yield* delivered(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }))
      yield* delivered(
        Delivery.cases.Plays.make({
          game: one,
          plays: [play({ id: first, sequence: 1 }), play({ id: second, sequence: 2 })]
        })
      )
      yield* batched
      yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [play({ id: second, sequence: 2 })] }))
      yield* batched
      assert.deepStrictEqual(yield* playIds, [second])
    }).pipe(Effect.provide(history))
  )

  it.effect("a game that leaves the live games keeps its plays", () =>
    Effect.gen(function* () {
      yield* delivered(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }))
      yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [play({ id: first })] }))
      yield* batched
      yield* delivered(Delivery.cases.Snapshot.make({ snapshot: over, from: "push" }))
      yield* batched
      assert.isFalse((yield* LiveSlate.use((slate) => slate.latest)).live.has(one))
      assert.deepStrictEqual(yield* playIds, [first])
    }).pipe(Effect.provide(history))
  )

  it.effect("the latest row follows the newest snapshot", () =>
    Effect.gen(function* () {
      yield* delivered(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }))
      yield* batched
      yield* delivered(Delivery.cases.Snapshot.make({ snapshot: over, from: "push" }))
      yield* delivered(Delivery.cases.Listing.make({ league: "fbs", games: [over] }))
      yield* batched
      const latest = yield* GameHistory.use((gameHistory) => gameHistory.latest(one))
      assert.deepStrictEqual(
        Option.map(latest, ({ status, period }) => `${status}/${period}`),
        Option.some("final/4")
      )
    }).pipe(Effect.provide(history))
  )

  it.effect("a final game that is only listed still gets its snapshot", () =>
    Effect.gen(function* () {
      yield* delivered(Delivery.cases.Listing.make({ league: "fbs", games: [over] }))
      yield* batched
      assert.isFalse((yield* LiveSlate.use((slate) => slate.latest)).live.has(one))
      const latest = yield* GameHistory.use((gameHistory) => gameHistory.latest(one))
      assert.deepStrictEqual(
        Option.map(latest, ({ status }) => status),
        Option.some("final")
      )
    }).pipe(Effect.provide(history))
  )

  it.effect("a play taken again at an older seq changes nothing", () =>
    Effect.gen(function* () {
      // A slate whose log reached frame 5, then a fresh one whose log numbers its frames again from 1, as a log reopened
      // after a crash does, over the same history.
      yield* Effect.gen(function* () {
        // Frames 1 to 4 hold the game; frame 5 brings its play.
        yield* delivered(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }))
        yield* delivered(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }))
        yield* delivered(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }))
        yield* delivered(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }))
        yield* delivered(
          Delivery.cases.Plays.make({ game: one, plays: [play({ id: first, text: "newer" })] })
        )
        yield* batched
      }).pipe(Effect.provide(following))
      const plays = yield* Effect.gen(function* () {
        // Frames 1 and 2 hold the game; frame 3 brings the older play.
        yield* delivered(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }))
        yield* delivered(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }))
        yield* delivered(
          Delivery.cases.Plays.make({ game: one, plays: [play({ id: first, text: "older" })] })
        )
        yield* batched
        return yield* GameHistory.use((gameHistory) => gameHistory.plays(one))
      }).pipe(Effect.provide(following))
      assert.deepStrictEqual(
        plays.map(({ text }) => text),
        ["newer"]
      )
    }).pipe(Effect.provide(Database.at(":memory:")))
  )

  it.effect("a write that fails is counted, and the next change writes what was missed", () =>
    withMetrics(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* delivered(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }))
        yield* batched
        yield* sql`ALTER TABLE play RENAME TO play_away`
        yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [play({ id: first })] }))
        yield* batched
        assert.strictEqual(yield* counted("sportal_history_write_failures"), 1)
        yield* sql`ALTER TABLE play_away RENAME TO play`
        yield* delivered(
          Delivery.cases.Plays.make({
            game: one,
            plays: [play({ id: first }), play({ id: second, sequence: 2 })]
          })
        )
        yield* batched
        assert.deepStrictEqual(yield* playIds, [first, second])
      }).pipe(Effect.provide(history))
    )
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

// Runs `effect` over a history that opens a database holding what the code before the play union left in it: the first
// migration run, a play row of the old shape, a snapshot row.
function afterMigrating<A, E>(effect: Effect.Effect<A, E, GameHistory>) {
  return stored.pipe(Effect.andThen(effect.pipe(Effect.provide(following))))
}

const stored = Effect.gen(function* () {
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
