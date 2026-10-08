import { assert, describe, it } from "@effect/vitest"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { liveSnapshot, play, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Ref, Stream, type Tracer } from "effect"
import { decodedFrames, recordedNeAtBuf, recordedPlays } from "../provider/espn/TestEspn.ts"
import { Provider } from "../provider/Provider.ts"
import { boardOver, delivered } from "../TestBoard.ts"
import { SnapshotFeed } from "../TestSnapshotFeed.ts"
import { gauged, recordingLogs, recordingSpans, withMetrics } from "../TestTelemetry.ts"
import { Board } from "./Board.ts"
import { Delivery } from "./Delivery.ts"
import { Slate } from "./Slate.ts"

const one = GameId.make("1")
const two = GameId.make("2")
const three = GameId.make("3")
const neAtBuf = GameId.make("401872971")

describe("Board", () => {
  it.effect("should start from the empty slate", () =>
    Effect.gen(function* () {
      const current = yield* latest

      assert.strictEqual(current, Slate.empty)
    }).pipe(Effect.provide(boardOver))
  )

  it.effect("should take a listing delivered, keeping its games in order", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const live = liveSnapshot({ id: one })
      const soon = snapshot({ id: two, kickoff: DateTime.add(now, { minutes: 20 }) })
      const later = snapshot({ id: three, kickoff: DateTime.add(now, { hours: 3 }) })

      const current = yield* listing([live, soon, later])

      assert.deepStrictEqual(current.listed.get("fbs"), [one, two, three])
      assert.deepStrictEqual(current.listedGames(["fbs"]), [live, soon, later])
    }).pipe(Effect.provide(boardOver))
  )

  it.effect("should ignore a snapshot behind its game's", () =>
    Effect.gen(function* () {
      yield* listing([snapshot({ id: one, status: "live", period: 2, clock: "5:00" })])

      const current = yield* takenSnapshot(snapshot({ id: one, status: "live", period: 1, clock: "5:00" }))

      assert.strictEqual(current.games.get(one)?.period, 2)
    }).pipe(Effect.provide(boardOver))
  )

  it.effect("should keep a snapshot of its own for each game", () =>
    Effect.gen(function* () {
      const first = liveSnapshot({ id: one, clock: "9:00" })
      const second = snapshot({ id: two, status: "live", period: 3, clock: "1:00" })
      yield* listing([liveSnapshot({ id: one }), snapshot({ id: two, status: "live", period: 2 })])

      yield* takenSnapshot(first)
      const current = yield* takenSnapshot(second)

      assert.deepStrictEqual(current.games.get(one), first)
      assert.deepStrictEqual(current.games.get(two), second)
    }).pipe(Effect.provide(boardOver))
  )

  it.effect("should take a listed game's plays", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one })])

      const current = yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [play()] }))

      assert.deepStrictEqual(current.plays.get(one), [play()])
    }).pipe(Effect.provide(boardOver))
  )

  it.effect("should drop plays for a game no listing names", () =>
    Effect.gen(function* () {
      const current = yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [play()] }))

      assert.strictEqual(current.games.size, 0)
      assert.strictEqual(current.plays.size, 0)
    }).pipe(Effect.provide(boardOver))
  )

  it.effect("should take every delivery of a frame", () =>
    Effect.gen(function* () {
      const feed = yield* SnapshotFeed
      const next = liveSnapshot({ id: one, clock: "9:00" })

      yield* feed.deliver([
        listingOf([liveSnapshot({ id: one })]),
        Delivery.cases.Snapshot.make({ snapshot: next })
      ])
      const current = yield* latest

      assert.strictEqual(current.games.get(one), next)
    }).pipe(Effect.provide(boardOver))
  )

  it.effect("should span each take with its count of deliveries", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one })])

      // `deliver` answers once the board has asked for the next frame, which can be before the span around it ends.
      const take = yield* Effect.yieldNow.pipe(
        Effect.andThen(Effect.sync(() => ended.find((span) => span.name === "Board.take"))),
        Effect.repeat({ until: (span) => span !== undefined, times: 100 })
      )

      assert.isDefined(take, "the take's span ended")
      assert.strictEqual(take?.attributes.get("sportal.deliveries"), 1)
    }).pipe(Effect.provide(boardOver.pipe(Layer.provideMerge(recordingSpans(ended)))))
  })

  it.effect("should log at Error when the provider's frames end", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* Board

      yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => logs.length > 0, times: 100 }))
      const stopped = logs.filter(({ level }) => level === "Error")
      assert.strictEqual(stopped.length, 1)
      assert.include(stopped[0]?.message, "the provider's frames stopped")
      assert.include(stopped[0]?.message, "the provider's frames ended")
    }).pipe(
      Effect.provide(
        Board.layer.pipe(Layer.provide(Provider.layerTest(Stream.empty)), Layer.provideMerge(layer))
      )
    )
  })
})

describe("Board#changes", () => {
  it.effect("should give the latest, then each change once", () =>
    Effect.gen(function* () {
      const board = yield* Board
      const published = yield* Ref.make<ReadonlyArray<GameSnapshot | undefined>>([])
      yield* board.changes.pipe(
        Stream.runForEach((current) => Ref.update(published, (all) => [...all, current.games.get(one)])),
        Effect.forkScoped({ startImmediately: true })
      )
      const first = liveSnapshot({ id: one })
      const second = liveSnapshot({ id: one, clock: "9:00" })

      yield* listing([first])
      yield* takenSnapshot(second)
      yield* Effect.yieldNow
      const all = yield* Ref.get(published)

      assert.deepStrictEqual(all, [undefined, first, second])
    }).pipe(Effect.provide(boardOver))
  )

  it.effect("should give no change for a take that changes nothing", () =>
    Effect.gen(function* () {
      const board = yield* Board
      const published = yield* Ref.make(0)
      yield* board.changes.pipe(
        Stream.runForEach(() => Ref.update(published, (count) => count + 1)),
        Effect.forkScoped({ startImmediately: true })
      )
      yield* listing([liveSnapshot({ id: one })])

      yield* takenSnapshot(liveSnapshot({ id: one, clock: "11:00" }))
      yield* Effect.yieldNow
      const count = yield* Ref.get(published)

      assert.strictEqual(count, 2)
    }).pipe(Effect.provide(boardOver))
  )
})

describe("Board, a take that raises a defect", () => {
  it.effect("should keep the slate as it was", () =>
    Effect.gen(function* () {
      const before = yield* listing([liveSnapshot({ id: one, clock: "9:00" })])

      const current = yield* takenSnapshot(broken(one))

      assert.strictEqual(current, before)
    }).pipe(Effect.provide(boardOver))
  )

  it.effect("should log the defect at Error with its cause", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one, clock: "9:00" })])

      yield* takenSnapshot(broken(one))
      const errors = logs.filter(({ level }) => level === "Error")

      assert.strictEqual(errors.length, 1)
      assert.include(errors[0]?.message, "a take raised a defect; the slate keeps what it had")
      assert.include(errors[0]?.cause, "a broken snapshot")
    }).pipe(Effect.provide(boardOver.pipe(Layer.provideMerge(layer))))
  })

  it.effect("should take the game's next snapshot", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one, clock: "9:00" })])
      yield* takenSnapshot(broken(one))
      const next = liveSnapshot({ id: one, clock: "7:00" })

      const current = yield* takenSnapshot(next)

      assert.strictEqual(current.games.get(one), next)
    }).pipe(Effect.provide(boardOver))
  )
})

describe("Board, a recorded game", () => {
  it.effect(
    "should take NE at BUF's recorded day to its final, with every play the recording has, logging no error",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        const frames = yield* recordedNeAtBuf
        const decoded = yield* decodedFrames(frames)
        const feed = yield* SnapshotFeed

        yield* Effect.forEach(decoded, (deliveries) => feed.deliver(deliveries), { discard: true })
        const current = yield* latest
        const errors = logs.filter(({ level }) => level === "Error")

        assert.strictEqual(current.games.get(neAtBuf)?.status, "final")
        assert.strictEqual(current.plays.get(neAtBuf)?.length, recordedPlays)
        assert.deepStrictEqual(errors, [])
      }).pipe(Effect.provide(boardOver.pipe(Layer.provideMerge(layer))))
    },
    { timeout: 60_000 }
  )
})

/** The board's latest. */
describe("Board's game state gauge", () => {
  it.effect("should gauge a listed live game as 2", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one })])

      const value = yield* gauged("sportal_game_state", { game: one })

      assert.strictEqual(value, 2)
    }).pipe(Effect.provide(boardOver), withMetrics)
  )

  it.effect("should gauge a game no listing names any more as 0", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one }), liveSnapshot({ id: two })])

      yield* listing([liveSnapshot({ id: two })])
      const value = yield* gauged("sportal_game_state", { game: one })

      assert.strictEqual(value, 0)
    }).pipe(Effect.provide(boardOver), withMetrics)
  )
})

const latest = Board.use((board) => board.latest)

function listingOf(games: ReadonlyArray<GameSnapshot>) {
  return Delivery.cases.Listing.make({ league: "fbs", games })
}

/** Delivers an FBS listing of `games`, giving the board's latest once it has taken it. */
function listing(games: ReadonlyArray<GameSnapshot>) {
  return delivered(listingOf(games))
}

function takenSnapshot(game: GameSnapshot) {
  return delivered(Delivery.cases.Snapshot.make({ snapshot: game }))
}

/** A live snapshot of game `id` at 8:00 in the first period whose progress raises a defect. */
function broken(id: GameId): GameSnapshot {
  class Broken extends GameSnapshot {
    override progress(): never {
      throw new Error("a broken snapshot")
    }
  }
  return new Broken({ ...liveSnapshot({ id, clock: "8:00" }) })
}
