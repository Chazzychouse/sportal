import { assert, describe, it } from "@effect/vitest"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import type { Play } from "@sportal/domain/Play"
import { Slate } from "@sportal/domain/Slate"
import { liveSnapshot, play, snapshot } from "@sportal/domain/TestGame"
import { type Cause, DateTime, Effect, Layer, Option, Queue, Ref, Stream } from "effect"
import { Director } from "./Director.ts"
import { Delivery, Provider } from "./provider/Provider.ts"
import * as TestHub from "./TestHub.ts"

const one = GameId.make("1")
const two = GameId.make("2")
const three = GameId.make("3")

describe("Director, the slate", () => {
  it.effect("should start from the empty slate", () =>
    fed(() =>
      Effect.gen(function* () {
        const current = yield* latest

        assert.strictEqual(current, Slate.empty)
      })
    )
  )

  it.effect("should take a listing delivered, keeping its games in order", () =>
    fed((frames) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const live = liveSnapshot({ id: one })
        const soon = snapshot({ id: two, kickoff: DateTime.add(now, { minutes: 20 }) })
        const later = snapshot({ id: three, kickoff: DateTime.add(now, { hours: 3 }) })

        const current = yield* listing(frames, [live, soon, later])

        assert.deepStrictEqual(
          current.games.map(({ snapshot }) => snapshot),
          [live, soon, later]
        )
      })
    )
  )

  it.effect("should ignore a snapshot behind its game's", () =>
    fed((frames) =>
      Effect.gen(function* () {
        yield* listing(frames, [snapshot({ id: one, status: "live", period: 2, clock: "5:00" })])

        const current = yield* relisted(
          frames,
          snapshot({ id: one, status: "live", period: 1, clock: "5:00" })
        )

        assert.strictEqual(snapshotIn(current, one)?.period, 2)
      })
    )
  )

  it.effect("should keep a snapshot of its own for each game", () =>
    fed((frames) =>
      Effect.gen(function* () {
        const first = liveSnapshot({ id: one, clock: "9:00" })
        const second = snapshot({ id: two, status: "live", period: 3, clock: "1:00" })
        yield* listing(frames, [liveSnapshot({ id: one }), snapshot({ id: two, status: "live", period: 2 })])

        yield* listing(frames, [first, snapshot({ id: two, status: "live", period: 2 })])
        const current = yield* listing(frames, [first, second])

        assert.deepStrictEqual(snapshotIn(current, one), first)
        assert.deepStrictEqual(snapshotIn(current, two), second)
      })
    )
  )

  it.effect("should take a listed game's plays", () =>
    fed((frames) =>
      Effect.gen(function* () {
        yield* listing(frames, [liveSnapshot({ id: one })])

        const current = yield* delivered(frames, Delivery.Plays({ game: one, plays: [play()] }))

        assert.deepStrictEqual(playsIn(current, one), [play()])
      })
    )
  )

  it.effect("should drop plays for a game no listing names", () =>
    fed((frames) =>
      Effect.gen(function* () {
        const current = yield* delivered(frames, Delivery.Plays({ game: one, plays: [play()] }))

        assert.deepStrictEqual(current.games, [])
      })
    )
  )
})

describe("Director#slate", () => {
  it.effect("should give the slate as it is, then each change once", () =>
    fed((frames) =>
      Effect.gen(function* () {
        const director = yield* Director
        const given = yield* Ref.make<ReadonlyArray<GameSnapshot | undefined>>([])
        yield* director.slate.pipe(
          Stream.runForEach((current) => Ref.update(given, (all) => [...all, snapshotIn(current, one)])),
          Effect.forkScoped({ startImmediately: true })
        )
        const first = liveSnapshot({ id: one })
        const second = liveSnapshot({ id: one, clock: "9:00" })

        yield* listing(frames, [first])
        yield* Effect.yieldNow
        yield* relisted(frames, second)
        yield* Effect.yieldNow
        const all = yield* Ref.get(given)

        assert.deepStrictEqual(all, [undefined, first, second])
      })
    )
  )

  it.effect("should give no change for a take that changes nothing", () =>
    fed((frames) =>
      Effect.gen(function* () {
        const director = yield* Director
        const given = yield* Ref.make(0)
        yield* director.slate.pipe(
          Stream.runForEach(() => Ref.update(given, (count) => count + 1)),
          Effect.forkScoped({ startImmediately: true })
        )
        yield* listing(frames, [liveSnapshot({ id: one })])

        yield* relisted(frames, liveSnapshot({ id: one, clock: "11:00" }))
        yield* Effect.yieldNow
        const count = yield* Ref.get(given)

        assert.strictEqual(count, 2)
      })
    )
  )
})

describe("Director, a take that raises a defect", () => {
  it.effect("should keep the slate as it was", () =>
    fed((frames) =>
      Effect.gen(function* () {
        const before = yield* listing(frames, [liveSnapshot({ id: one, clock: "9:00" })])

        const current = yield* relisted(frames, broken(one))

        assert.strictEqual(current, before)
      })
    )
  )

  it.effect("should take the game's next snapshot", () =>
    fed((frames) =>
      Effect.gen(function* () {
        yield* listing(frames, [liveSnapshot({ id: one, clock: "9:00" })])
        yield* relisted(frames, broken(one))
        const next = liveSnapshot({ id: one, clock: "7:00" })

        const current = yield* relisted(frames, next)

        assert.strictEqual(snapshotIn(current, one), next)
      })
    )
  )
})

function snapshotIn(slate: Slate, id: GameId): GameSnapshot | undefined {
  return slate.games.find(({ snapshot }) => snapshot.id === id)?.snapshot
}

function playsIn(slate: Slate, id: GameId): ReadonlyArray<Play> {
  return slate.games.find(({ snapshot }) => snapshot.id === id)?.plays ?? []
}

/**
 * Runs `test` against a Director over a provider whose frames are what the test offers `frames`. One frame waits in
 * `frames` at a time, so an offer returns only once the Director has pulled the frame before it.
 */
function fed<A, E, R>(test: (frames: TestHub.Frames) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const frames = yield* Queue.bounded<ReadonlyArray<Delivery>, Cause.Done>(1)

    return yield* test(frames).pipe(
      Effect.provide(Director.layer.pipe(Layer.provide(Provider.layerTest(frames))))
    )
  })
}

/** The Director's slate as it is now. */
const latest = Director.use((director) => Stream.runHead(director.slate)).pipe(Effect.map(Option.getOrThrow))

/**
 * Delivers one frame that says only `delivery`, and gives the Director's slate once it has taken it: the second empty
 * frame is accepted only once the Director has pulled the first, which it does only after taking `delivery`.
 */
const delivered = Effect.fnUntraced(function* (frames: TestHub.Frames, delivery: Delivery) {
  yield* TestHub.offered(frames, delivery)

  return yield* latest
})

/** Delivers an FBS listing of `games`, giving the Director's slate once it has taken it. */
function listing(frames: TestHub.Frames, games: ReadonlyArray<GameSnapshot>) {
  return delivered(frames, Delivery.Listing({ league: "fbs", games }))
}

function relisted(frames: TestHub.Frames, game: GameSnapshot) {
  return listing(frames, [game])
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
