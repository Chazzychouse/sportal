import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId } from "@sportal/domain/Game"
import { PlayId } from "@sportal/domain/Play"
import { play, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "./database/Database.ts"
import { GameHistory } from "./GameHistory.ts"
import { LiveGames } from "./LiveGames.ts"
import { counted, withMetrics } from "./TestTelemetry.ts"

const one = GameId.make("1")
const first = PlayId.make("a")
const second = PlayId.make("b")

describe("GameHistory", () => {
  it.live("a game's plays are readable after its Plays delivery", () =>
    Effect.gen(function* () {
      yield* takenAt(1, Delivery.Snapshot({ snapshot: live, from: "push" }))
      yield* takenAt(
        2,
        Delivery.Plays({
          game: one,
          plays: [play({ id: first, sequence: 1 }), play({ id: second, sequence: 2 })]
        })
      )
      yield* batched
      assert.deepStrictEqual(yield* playIds, [first, second])
    }).pipe(Effect.provide(history))
  )

  it.live("a revised play replaces its row", () =>
    Effect.gen(function* () {
      yield* takenAt(1, Delivery.Snapshot({ snapshot: live, from: "push" }))
      yield* takenAt(2, Delivery.Plays({ game: one, plays: [play({ id: first, text: "before" })] }))
      yield* batched
      yield* takenAt(3, Delivery.Plays({ game: one, plays: [play({ id: first, text: "after" })] }))
      yield* batched
      const plays = yield* GameHistory.use((gameHistory) => gameHistory.plays(one))
      assert.deepStrictEqual(
        plays.map(({ text }) => text),
        ["after"]
      )
    }).pipe(Effect.provide(history))
  )

  it.live("a play no longer in a live game's list loses its row", () =>
    Effect.gen(function* () {
      yield* takenAt(1, Delivery.Snapshot({ snapshot: live, from: "push" }))
      yield* takenAt(
        2,
        Delivery.Plays({
          game: one,
          plays: [play({ id: first, sequence: 1 }), play({ id: second, sequence: 2 })]
        })
      )
      yield* batched
      yield* takenAt(3, Delivery.Plays({ game: one, plays: [play({ id: second, sequence: 2 })] }))
      yield* batched
      assert.deepStrictEqual(yield* playIds, [second])
    }).pipe(Effect.provide(history))
  )

  it.live("a game that leaves the live games keeps its plays", () =>
    Effect.gen(function* () {
      yield* takenAt(1, Delivery.Snapshot({ snapshot: live, from: "push" }))
      yield* takenAt(2, Delivery.Plays({ game: one, plays: [play({ id: first })] }))
      yield* batched
      yield* takenAt(3, Delivery.Snapshot({ snapshot: over, from: "push" }))
      yield* batched
      assert.isFalse((yield* LiveGames.use((liveGames) => liveGames.latest)).live.has(one))
      assert.deepStrictEqual(yield* playIds, [first])
    }).pipe(Effect.provide(history))
  )

  it.live("a status change adds a status row, and the latest replaces the latest row", () =>
    Effect.gen(function* () {
      yield* takenAt(1, Delivery.Snapshot({ snapshot: live, from: "push" }))
      yield* batched
      yield* takenAt(
        2,
        Delivery.Snapshot({
          snapshot: snapshot({ id: one, status: "live", period: 2, clock: "5:00" }),
          from: "push"
        })
      )
      yield* batched
      yield* takenAt(3, Delivery.Snapshot({ snapshot: over, from: "push" }))
      yield* takenAt(4, Delivery.Listing({ league: "fbs", games: [over] }))
      yield* batched
      const snapshots = yield* GameHistory.use((gameHistory) => gameHistory.snapshots(one))
      assert.deepStrictEqual(
        snapshots.map(({ status, period }) => `${status}/${period}`),
        ["live/1", "final/4", "final/4"]
      )
    }).pipe(Effect.provide(history))
  )

  it.live("a final game that is only listed still gets its snapshot", () =>
    Effect.gen(function* () {
      yield* takenAt(1, Delivery.Listing({ league: "fbs", games: [over] }))
      yield* batched
      assert.isFalse((yield* LiveGames.use((liveGames) => liveGames.latest)).live.has(one))
      const snapshots = yield* GameHistory.use((gameHistory) => gameHistory.snapshots(one))
      assert.deepStrictEqual(
        snapshots.map(({ status }) => status),
        ["final", "final"]
      )
    }).pipe(Effect.provide(history))
  )

  it.live("replaying an older seq changes nothing", () =>
    Effect.gen(function* () {
      yield* takenAt(1, Delivery.Snapshot({ snapshot: live, from: "push" }))
      yield* takenAt(5, Delivery.Plays({ game: one, plays: [play({ id: first, text: "newer" })] }))
      yield* batched
      yield* takenAt(3, Delivery.Plays({ game: one, plays: [play({ id: first, text: "older" })] }))
      yield* batched
      const plays = yield* GameHistory.use((gameHistory) => gameHistory.plays(one))
      assert.deepStrictEqual(
        plays.map(({ text }) => text),
        ["newer"]
      )
    }).pipe(Effect.provide(history))
  )

  it.live("a delivery with no seq writes nothing", () =>
    Effect.gen(function* () {
      const at = yield* DateTime.now
      yield* LiveGames.use((liveGames) =>
        liveGames
          .take(Delivery.Snapshot({ snapshot: live, from: "push" }), at, Option.none())
          .pipe(
            Effect.andThen(
              liveGames.take(Delivery.Plays({ game: one, plays: [play({ id: first })] }), at, Option.none())
            )
          )
      )
      yield* batched
      assert.deepStrictEqual(yield* playIds, [])
      assert.deepStrictEqual(yield* GameHistory.use((gameHistory) => gameHistory.snapshots(one)), [])
    }).pipe(Effect.provide(history))
  )

  it.live("a write that fails is counted, and the next change writes what was missed", () =>
    withMetrics(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* takenAt(1, Delivery.Snapshot({ snapshot: live, from: "push" }))
        yield* batched
        yield* sql`ALTER TABLE play RENAME TO play_away`
        yield* takenAt(2, Delivery.Plays({ game: one, plays: [play({ id: first })] }))
        yield* batched
        assert.strictEqual(yield* counted("sportal_history_write_failures"), 1)
        yield* sql`ALTER TABLE play_away RENAME TO play`
        yield* takenAt(
          3,
          Delivery.Plays({ game: one, plays: [play({ id: first }), play({ id: second, sequence: 2 })] })
        )
        yield* batched
        assert.deepStrictEqual(yield* playIds, [first, second])
      }).pipe(Effect.provide(history))
    )
  )
})

const live = snapshot({ id: one, status: "live", period: 1, clock: "10:00" })
const over = snapshot({ id: one, status: "final", period: 4, clock: "0:00" })

// The fold, the Hub's database in memory, and the history that follows the one and writes the other.
const history = GameHistory.layer.pipe(
  Layer.provideMerge(LiveGames.layer),
  Layer.provideMerge(Database.layer(":memory:"))
)

// Longer than the writer's batch window.
const batched = Effect.sleep("500 millis")

const playIds = GameHistory.use((gameHistory) => gameHistory.plays(one)).pipe(
  Effect.map((plays) => plays.map(({ id }) => id))
)

function takenAt(seq: number, delivery: Delivery) {
  return DateTime.now.pipe(
    Effect.flatMap((at) => LiveGames.use((liveGames) => liveGames.take(delivery, at, Option.some(seq))))
  )
}
