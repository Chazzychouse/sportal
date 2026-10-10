import { assert, describe, it } from "@effect/vitest"
import { GameId, GameSnapshot, type GameStatus } from "@sportal/domain/Game"
import { type Play, PlayId } from "@sportal/domain/Play"
import { Slate } from "@sportal/domain/Slate"
import { liveSnapshot, play, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Metric, Ref, Stream, type Tracer } from "effect"
import { TestClock } from "effect/testing"
import { Director } from "./Director.ts"
import * as TestEspn from "./provider/espn/TestEspn.ts"
import { Delivery } from "./provider/Provider.ts"
import { ProviderFeed } from "./provider/ProviderFeed.ts"
import * as TestDirector from "./TestDirector.ts"
import { gauged, recordingLogs, recordingSpans, withMetrics } from "./TestTelemetry.ts"

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

  it.effect("should span each take with its count of deliveries", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one })])

      // `deliver` answers once the Director has asked for the next frame, which can be before the span around it ends.
      const take = yield* Effect.yieldNow.pipe(
        Effect.andThen(Effect.sync(() => ended.find((span) => span.name === "Director.take"))),
        Effect.repeat({ until: (span) => span !== undefined, times: 100 })
      )

      assert.isDefined(take, "the take's span ended")
      assert.strictEqual(take?.attributes.get("sportal.deliveries"), 1)
    }).pipe(Effect.provide(TestDirector.directorOver.pipe(Layer.provideMerge(recordingSpans(ended)))))
  })

  it.effect("should log at Error when the provider's frames end", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      const feed = yield* ProviderFeed

      yield* feed.end
      yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => logs.length > 0, times: 100 }))

      const stopped = logs.filter(({ level }) => level === "Error")
      assert.strictEqual(stopped.length, 1)
      assert.include(stopped[0]?.message, "the provider's frames stopped")
      assert.include(stopped[0]?.message, "the provider's frames ended")
    }).pipe(Effect.provide(TestDirector.directorOver.pipe(Layer.provideMerge(layer))))
  })
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

  it.effect("should log the defect at Error with its cause", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one, clock: "9:00" })])

      yield* relisted(broken(one))
      const errors = logs.filter(({ level }) => level === "Error")

      assert.strictEqual(errors.length, 1)
      assert.include(errors[0]?.message, "a take raised a defect; the slate keeps what it had")
      assert.include(errors[0]?.cause, "a broken snapshot")
    }).pipe(Effect.provide(TestDirector.directorOver.pipe(Layer.provideMerge(layer))))
  })

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
    "should take NE at BUF's recorded day to its final, with every play the recording has, logging no error",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        yield* TestClock.setTime(TestEspn.duringNeAtBuf.epochMilliseconds)
        const day = yield* TestEspn.recordedNeAtBuf
        const decoded = yield* TestEspn.replayed(day)
        const feed = yield* ProviderFeed

        yield* Effect.forEach(decoded, (deliveries) => feed.deliver(deliveries), { discard: true })
        const current = yield* TestDirector.latest
        const errors = logs.filter(({ level }) => level === "Error")

        assert.strictEqual(snapshotIn(current, neAtBuf)?.status, "final")
        assert.strictEqual(playsIn(current, neAtBuf).length, TestEspn.recordedPlays)
        assert.deepStrictEqual(errors, [])
      }).pipe(Effect.provide(TestDirector.directorOver.pipe(Layer.provideMerge(layer))))
    },
    { timeout: 60_000 }
  )
})

describe("Director's game state gauge", () => {
  it.effect("should gauge a listed live game as 2", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one })])

      const value = yield* gauged("sportal_game_state", { game: one })

      assert.strictEqual(value, 2)
    }).pipe(Effect.provide(TestDirector.directorOver), withMetrics)
  )

  it.effect("should gauge a progressed game's status, period, clock, kickoff, update time, and scores", () =>
    Effect.gen(function* () {
      const acceptedAt = DateTime.makeUnsafe("2026-10-09T20:00:00Z")
      const kickoff = DateTime.makeUnsafe("2026-10-09T17:00:00Z")
      const game = liveSnapshot({
        id: one,
        status: "halftime",
        period: 2,
        clock: "0:00",
        kickoff,
        away: { team: team("BUF"), score: 17 },
        home: { team: team("NE"), score: 14 }
      })
      yield* TestClock.setTime(DateTime.toEpochMillis(acceptedAt))

      yield* listing([game])
      const status = yield* gauged("sportal_game_status", { game: one })
      const period = yield* gauged("sportal_game_period", { game: one })
      const clock = yield* gauged("sportal_game_clock", { game: one })
      const measuredKickoff = yield* gauged("sportal_game_kickoff", { game: one })
      const updatedAt = yield* gauged("sportal_game_updated_at", { game: one })
      const away = yield* gauged("sportal_game_score", {
        game: one,
        side: "away",
        team: "BUF"
      })
      const home = yield* gauged("sportal_game_score", {
        game: one,
        side: "home",
        team: "NE"
      })

      assert.strictEqual(status, 3)
      assert.strictEqual(period, 2)
      assert.strictEqual(clock, 0)
      assert.strictEqual(measuredKickoff, DateTime.toEpochSeconds(kickoff))
      assert.strictEqual(updatedAt, DateTime.toEpochSeconds(acceptedAt))
      assert.strictEqual(away, 17)
      assert.strictEqual(home, 14)
    }).pipe(Effect.provide(TestDirector.directorOver), withMetrics)
  )

  const statuses: ReadonlyArray<readonly [GameStatus, number]> = [
    ["scheduled", 1],
    ["live", 2],
    ["halftime", 3],
    ["delayed", 4],
    ["final", 5],
    ["postponed", 6],
    ["canceled", 7]
  ]

  it.effect.each(statuses)("should gauge %s status as %d", ([status, expected]) =>
    Effect.gen(function* () {
      yield* listing([snapshot({ id: one, status })])

      const value = yield* gauged("sportal_game_status", { game: one })

      assert.strictEqual(value, expected)
    }).pipe(Effect.provide(TestDirector.directorOver), withMetrics)
  )

  it.effect("should update current values without creating series from changing values", () =>
    Effect.gen(function* () {
      const first = liveSnapshot({
        id: one,
        away: { team: team("BUF"), score: 7 },
        home: { team: team("NE"), score: 3 }
      })
      const second = liveSnapshot({
        id: one,
        clock: "8:00",
        away: { team: team("BUF"), score: 14 },
        home: { team: team("NE"), score: 3 }
      })
      yield* listing([first])

      yield* relisted(second)
      const metrics = yield* Metric.snapshot
      const scores = metrics.filter(
        (metric) => metric.id === "sportal_game_score" && metric.attributes?.game === one
      )
      const clocks = metrics.filter(
        (metric) => metric.id === "sportal_game_clock" && metric.attributes?.game === one
      )
      const clock = yield* gauged("sportal_game_clock", { game: one })
      const away = yield* gauged("sportal_game_score", {
        game: one,
        side: "away",
        team: "BUF"
      })

      assert.strictEqual(scores.length, 2)
      assert.strictEqual(clocks.length, 1)
      assert.strictEqual(clock, 480)
      assert.strictEqual(away, 14)
    }).pipe(Effect.provide(TestDirector.directorOver), withMetrics)
  )

  it.effect("should drop the series of a game no listing names any more", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one }), liveSnapshot({ id: two })])

      yield* listing([liveSnapshot({ id: two })])
      const value = yield* gauged("sportal_game_state", { game: one })

      assert.isUndefined(value)
    }).pipe(Effect.provide(TestDirector.directorOver), withMetrics)
  )

  it.effect("should drop every current-value series of a game no listing names", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one }), liveSnapshot({ id: two })])

      yield* listing([liveSnapshot({ id: two })])
      const metrics = yield* Metric.snapshot
      const forgotten = metrics.filter(({ attributes }) => attributes?.game === one)

      assert.deepStrictEqual(forgotten, [])
    }).pipe(Effect.provide(TestDirector.directorOver), withMetrics)
  )

  it.effect("should gauge a game listed again after it was delisted", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one }), liveSnapshot({ id: two })])
      yield* listing([liveSnapshot({ id: two })])

      yield* listing([liveSnapshot({ id: one }), liveSnapshot({ id: two })])
      const value = yield* gauged("sportal_game_state", { game: one })

      assert.strictEqual(value, 2)
    }).pipe(Effect.provide(TestDirector.directorOver), withMetrics)
  )
})

describe("Director's play log", () => {
  it.effect("should log each play a take adds once, annotated with its game", () => {
    const { logs, layer } = recordingLogs()
    const game = liveSnapshot({ id: one })
    const first = play({ id: PlayId.make("p1"), sequence: 1, text: "Rush for 1 yard" })
    const second = play({ id: PlayId.make("p2"), sequence: 2, clock: "14:20", text: "Rush for 4 yards" })
    return Effect.gen(function* () {
      yield* listing([game])
      yield* TestDirector.delivered(Delivery.Plays({ game: one, plays: [first] }))

      yield* TestDirector.delivered(Delivery.Plays({ game: one, plays: [first, second] }))

      const played = logs.filter(({ annotations }) => annotations.play !== undefined)
      assert.deepStrictEqual(
        played.map(({ level, annotations }) => ({ level, game: annotations.game, play: annotations.play })),
        [
          { level: "Info", game: one, play: "Rush" },
          { level: "Info", game: one, play: "Rush" }
        ]
      )
      assert.include(played[1]?.message ?? "", `Director: ${game.matchup()} Q1 14:20 Rush for 4 yards`)
    }).pipe(Effect.provide(TestDirector.directorOver.pipe(Layer.provideMerge(layer))))
  })
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
