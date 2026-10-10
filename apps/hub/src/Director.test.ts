import { assert, describe, it } from "@effect/vitest"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import type { Play } from "@sportal/domain/Play"
import { Slate } from "@sportal/domain/Slate"
import { liveSnapshot, play, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Ref, Stream, type Tracer } from "effect"
import { TestClock } from "effect/testing"
import { Director } from "./Director.ts"
import * as TestEspn from "./provider/espn/TestEspn.ts"
import { Delivery } from "./provider/Provider.ts"
import { ProviderFeed } from "./provider/ProviderFeed.ts"
import * as TestDirector from "./TestDirector.ts"

const one = GameId.make("1")
const two = GameId.make("2")
const three = GameId.make("3")
const neAtBuf = GameId.make("401872971")

describe("Director, the slate", () => {
  it.effect("should start from the empty slate", () =>
    Effect.gen(function* () {
      const current = yield* TestDirector.latest

      assert.strictEqual(current, Slate.empty)
    }).pipe(Effect.provide(TestDirector.directorOver))
  )

  it.effect("should take a listing delivered, keeping its games in order", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const live = liveSnapshot({ id: one })
      const soon = snapshot({ id: two, kickoff: DateTime.add(now, { minutes: 20 }) })
      const later = snapshot({ id: three, kickoff: DateTime.add(now, { hours: 3 }) })

      const current = yield* listing([live, soon, later])

      assert.deepStrictEqual(
        current.games.map(({ snapshot }) => snapshot),
        [live, soon, later]
      )
    }).pipe(Effect.provide(TestDirector.directorOver))
  )

  it.effect("should ignore a snapshot behind its game's", () =>
    Effect.gen(function* () {
      yield* listing([snapshot({ id: one, status: "live", period: 2, clock: "5:00" })])

      const current = yield* relisted(snapshot({ id: one, status: "live", period: 1, clock: "5:00" }))

      assert.strictEqual(snapshotIn(current, one)?.period, 2)
    }).pipe(Effect.provide(TestDirector.directorOver))
  )

  it.effect("should keep a snapshot of its own for each game", () =>
    Effect.gen(function* () {
      const first = liveSnapshot({ id: one, clock: "9:00" })
      const second = snapshot({ id: two, status: "live", period: 3, clock: "1:00" })
      yield* listing([liveSnapshot({ id: one }), snapshot({ id: two, status: "live", period: 2 })])

      yield* listing([first, snapshot({ id: two, status: "live", period: 2 })])
      const current = yield* listing([first, second])

      assert.deepStrictEqual(snapshotIn(current, one), first)
      assert.deepStrictEqual(snapshotIn(current, two), second)
    }).pipe(Effect.provide(TestDirector.directorOver))
  )

  it.effect("should take a listed game's plays", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one })])

      const current = yield* TestDirector.delivered(Delivery.Plays({ game: one, plays: [play()] }))

      assert.deepStrictEqual(playsIn(current, one), [play()])
    }).pipe(Effect.provide(TestDirector.directorOver))
  )

  it.effect("should drop plays for a game no listing names", () =>
    Effect.gen(function* () {
      const current = yield* TestDirector.delivered(Delivery.Plays({ game: one, plays: [play()] }))

      assert.deepStrictEqual(current.games, [])
    }).pipe(Effect.provide(TestDirector.directorOver))
  )

  it.effect("should take every delivery of a frame", () =>
    Effect.gen(function* () {
      const feed = yield* ProviderFeed
      const next = liveSnapshot({ id: one, clock: "9:00" })

      yield* feed.deliver([listingOf([liveSnapshot({ id: one })]), listingOf([next])])
      const current = yield* TestDirector.latest

      assert.strictEqual(snapshotIn(current, one), next)
    }).pipe(Effect.provide(TestDirector.directorOver))
  )
})

describe("Director#slate", () => {
  it.effect("should give the slate as it is, then each change once", () =>
    Effect.gen(function* () {
      const director = yield* Director
      const given = yield* Ref.make<ReadonlyArray<GameSnapshot | undefined>>([])
      yield* director.slate.pipe(
        Stream.runForEach((current) => Ref.update(given, (all) => [...all, snapshotIn(current, one)])),
        Effect.forkScoped({ startImmediately: true })
      )
      const first = liveSnapshot({ id: one })
      const second = liveSnapshot({ id: one, clock: "9:00" })

      yield* listing([first])
      yield* Effect.yieldNow
      yield* relisted(second)
      yield* Effect.yieldNow
      const all = yield* Ref.get(given)

      assert.deepStrictEqual(all, [undefined, first, second])
    }).pipe(Effect.provide(TestDirector.directorOver))
  )

  it.effect("should give no change for a take that changes nothing", () =>
    Effect.gen(function* () {
      const director = yield* Director
      const given = yield* Ref.make(0)
      yield* director.slate.pipe(
        Stream.runForEach(() => Ref.update(given, (count) => count + 1)),
        Effect.forkScoped({ startImmediately: true })
      )
      yield* listing([liveSnapshot({ id: one })])

      yield* relisted(liveSnapshot({ id: one, clock: "11:00" }))
      yield* Effect.yieldNow
      const count = yield* Ref.get(given)

      assert.strictEqual(count, 2)
    }).pipe(Effect.provide(TestDirector.directorOver))
  )
})

describe("Director, a frame", () => {
  it.effect("should take two deliveries in one frame as the same two in two frames", () =>
    Effect.gen(function* () {
      const feed = yield* ProviderFeed
      const first = [liveSnapshot({ id: one }), liveSnapshot({ id: two, clock: "5:00" })]
      const second = [liveSnapshot({ id: one, clock: "9:00" })]
      const apart = Slate.empty.relisted("fbs", first)[0].relisted("fbs", second)[0]

      yield* feed.deliver([listingOf(first), listingOf(second)])
      const together = yield* TestDirector.latest

      assert.deepStrictEqual(together.games, apart.games)
    }).pipe(Effect.provide(TestDirector.directorOver))
  )

  it.effect("should give back the slate itself for a frame with no deliveries", () =>
    Effect.gen(function* () {
      const feed = yield* ProviderFeed
      const before = yield* listing([liveSnapshot({ id: one })])

      yield* feed.deliver([])
      const current = yield* TestDirector.latest

      assert.strictEqual(current, before)
    }).pipe(Effect.provide(TestDirector.directorOver))
  )
})

describe("Director, a take that raises a defect", () => {
  it.effect("should keep the slate as it was", () =>
    Effect.gen(function* () {
      const before = yield* listing([liveSnapshot({ id: one, clock: "9:00" })])

      const current = yield* relisted(broken(one))

      assert.strictEqual(current, before)
    }).pipe(Effect.provide(TestDirector.directorOver))
  )

  it.effect("should take the game's next snapshot", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one, clock: "9:00" })])
      yield* relisted(broken(one))
      const next = liveSnapshot({ id: one, clock: "7:00" })

      const current = yield* relisted(next)

      assert.strictEqual(snapshotIn(current, one), next)
    }).pipe(Effect.provide(TestDirector.directorOver))
  )
})

describe("Director, a recorded game", () => {
  it.effect(
    "should take NE at BUF's recorded day to its final, with every play the recording has",
    () => {
      return Effect.gen(function* () {
        yield* TestClock.setTime(TestEspn.duringNeAtBuf.epochMilliseconds)
        const day = yield* TestEspn.recordedNeAtBuf
        const decoded = yield* TestEspn.replayed(day)
        const feed = yield* ProviderFeed

        yield* Effect.forEach(decoded, (deliveries) => feed.deliver(deliveries), { discard: true })
        const current = yield* TestDirector.latest

        assert.strictEqual(snapshotIn(current, neAtBuf)?.status, "final")
        assert.strictEqual(playsIn(current, neAtBuf).length, TestEspn.recordedPlays)
      }).pipe(Effect.provide(TestDirector.directorOver))
    },
    { timeout: 60_000 }
  )
})

function snapshotIn(slate: Slate, id: GameId): GameSnapshot | undefined {
  return slate.games.find(({ snapshot }) => snapshot.id === id)?.snapshot
}

function playsIn(slate: Slate, id: GameId): ReadonlyArray<Play> {
  return slate.games.find(({ snapshot }) => snapshot.id === id)?.plays ?? []
}

function listingOf(games: ReadonlyArray<GameSnapshot>) {
  return Delivery.Listing({ league: "fbs", games })
}

/** Delivers an FBS listing of `games`, giving the Director's slate once it has taken it. */
function listing(games: ReadonlyArray<GameSnapshot>) {
  return TestDirector.delivered(listingOf(games))
}

function relisted(game: GameSnapshot) {
  return listing([game])
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
