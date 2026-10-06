import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId } from "@sportal/domain/Game"
import { PlayId } from "@sportal/domain/Play"
import { play, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import * as Database from "./Database.ts"
import { GameHistory } from "./GameHistory.ts"
import { LiveGames } from "./LiveGames.ts"
import { taken } from "./provider/TestProvider.ts"
import { counted, withMetrics } from "./TestTelemetry.ts"

const one = GameId.make("1")
const first = PlayId.make("a")
const second = PlayId.make("b")

describe("GameHistory", () => {
  it.effect("a game's plays are readable after its Plays delivery", () =>
    Effect.gen(function* () {
      yield* taken(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }), 1)
      yield* taken(
        Delivery.cases.Plays.make({
          game: one,
          plays: [play({ id: first, sequence: 1 }), play({ id: second, sequence: 2 })]
        }),
        2
      )
      yield* batched
      assert.deepStrictEqual(yield* playIds, [first, second])
    }).pipe(Effect.provide(history))
  )

  it.effect("a revised play replaces its row", () =>
    Effect.gen(function* () {
      yield* taken(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }), 1)
      yield* taken(Delivery.cases.Plays.make({ game: one, plays: [play({ id: first, text: "before" })] }), 2)
      yield* batched
      yield* taken(Delivery.cases.Plays.make({ game: one, plays: [play({ id: first, text: "after" })] }), 3)
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
      yield* taken(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }), 1)
      yield* taken(
        Delivery.cases.Plays.make({
          game: one,
          plays: [play({ id: first, sequence: 1 }), play({ id: second, sequence: 2 })]
        }),
        2
      )
      yield* batched
      yield* taken(Delivery.cases.Plays.make({ game: one, plays: [play({ id: second, sequence: 2 })] }), 3)
      yield* batched
      assert.deepStrictEqual(yield* playIds, [second])
    }).pipe(Effect.provide(history))
  )

  it.effect("a game that leaves the live games keeps its plays", () =>
    Effect.gen(function* () {
      yield* taken(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }), 1)
      yield* taken(Delivery.cases.Plays.make({ game: one, plays: [play({ id: first })] }), 2)
      yield* batched
      yield* taken(Delivery.cases.Snapshot.make({ snapshot: over, from: "push" }), 3)
      yield* batched
      assert.isFalse((yield* LiveGames.use((liveGames) => liveGames.latest)).live.has(one))
      assert.deepStrictEqual(yield* playIds, [first])
    }).pipe(Effect.provide(history))
  )

  it.effect("the latest row follows the newest snapshot", () =>
    Effect.gen(function* () {
      yield* taken(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }), 1)
      yield* batched
      yield* taken(Delivery.cases.Snapshot.make({ snapshot: over, from: "push" }), 2)
      yield* taken(Delivery.cases.Listing.make({ league: "fbs", games: [over] }), 3)
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
      yield* taken(Delivery.cases.Listing.make({ league: "fbs", games: [over] }), 1)
      yield* batched
      assert.isFalse((yield* LiveGames.use((liveGames) => liveGames.latest)).live.has(one))
      const latest = yield* GameHistory.use((gameHistory) => gameHistory.latest(one))
      assert.deepStrictEqual(
        Option.map(latest, ({ status }) => status),
        Option.some("final")
      )
    }).pipe(Effect.provide(history))
  )

  it.effect("replaying an older seq changes nothing", () =>
    Effect.gen(function* () {
      yield* taken(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }), 1)
      yield* taken(Delivery.cases.Plays.make({ game: one, plays: [play({ id: first, text: "newer" })] }), 5)
      yield* batched
      yield* taken(Delivery.cases.Plays.make({ game: one, plays: [play({ id: first, text: "older" })] }), 3)
      yield* batched
      const plays = yield* GameHistory.use((gameHistory) => gameHistory.plays(one))
      assert.deepStrictEqual(
        plays.map(({ text }) => text),
        ["newer"]
      )
    }).pipe(Effect.provide(history))
  )

  it.effect("a delivery with no seq writes nothing", () =>
    Effect.gen(function* () {
      const at = yield* DateTime.now
      yield* LiveGames.use((liveGames) =>
        liveGames
          .take(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }), at, Option.none())
          .pipe(
            Effect.andThen(
              liveGames.take(
                Delivery.cases.Plays.make({ game: one, plays: [play({ id: first })] }),
                at,
                Option.none()
              )
            )
          )
      )
      yield* batched
      assert.deepStrictEqual(yield* playIds, [])
      assert.deepStrictEqual(yield* GameHistory.use((gameHistory) => gameHistory.latest(one)), Option.none())
    }).pipe(Effect.provide(history))
  )

  it.effect("a write that fails is counted, and the next change writes what was missed", () =>
    withMetrics(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* taken(Delivery.cases.Snapshot.make({ snapshot: live, from: "push" }), 1)
        yield* batched
        yield* sql`ALTER TABLE play RENAME TO play_away`
        yield* taken(Delivery.cases.Plays.make({ game: one, plays: [play({ id: first })] }), 2)
        yield* batched
        assert.strictEqual(yield* counted("sportal_history_write_failures"), 1)
        yield* sql`ALTER TABLE play_away RENAME TO play`
        yield* taken(
          Delivery.cases.Plays.make({
            game: one,
            plays: [play({ id: first }), play({ id: second, sequence: 2 })]
          }),
          3
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
  Layer.provideMerge(Database.at(":memory:"))
)

// Past the writer's 250 ms batch window, then lets the write finish.
const batched = Effect.yieldNow.pipe(Effect.andThen(TestClock.adjust("250 millis")))

const playIds = GameHistory.use((gameHistory) => gameHistory.plays(one)).pipe(
  Effect.map((plays) => plays.map(({ id }) => id))
)
