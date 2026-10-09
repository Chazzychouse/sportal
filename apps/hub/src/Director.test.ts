import { assert, describe, it } from "@effect/vitest"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { type Play, PlayId } from "@sportal/domain/Play"
import { liveSnapshot, play, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Ref, Stream, type Tracer } from "effect"
import { Director } from "./Director.ts"
import { decodedFrames, recordedNeAtBuf, recordedPlays } from "./provider/espn/TestEspn.ts"
import { Delivery, ProviderFeed } from "./provider/Provider.ts"
import { Slate } from "./Slate.ts"
import { delivered, directorOver, latest } from "./TestDirector.ts"
import { gauged, recordingLogs, recordingSpans, withMetrics } from "./TestTelemetry.ts"

const one = GameId.make("1")
const two = GameId.make("2")
const three = GameId.make("3")
const neAtBuf = GameId.make("401872971")

describe("Director, the slate", () => {
  it.effect("should start from the empty slate", () =>
    Effect.gen(function* () {
      const current = yield* latest

      assert.strictEqual(current, Slate.empty)
    }).pipe(Effect.provide(directorOver))
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
    }).pipe(Effect.provide(directorOver))
  )

  it.effect("should ignore a snapshot behind its game's", () =>
    Effect.gen(function* () {
      yield* listing([snapshot({ id: one, status: "live", period: 2, clock: "5:00" })])

      const current = yield* takenSnapshot(snapshot({ id: one, status: "live", period: 1, clock: "5:00" }))

      assert.strictEqual(snapshotIn(current, one)?.period, 2)
    }).pipe(Effect.provide(directorOver))
  )

  it.effect("should keep a snapshot of its own for each game", () =>
    Effect.gen(function* () {
      const first = liveSnapshot({ id: one, clock: "9:00" })
      const second = snapshot({ id: two, status: "live", period: 3, clock: "1:00" })
      yield* listing([liveSnapshot({ id: one }), snapshot({ id: two, status: "live", period: 2 })])

      yield* takenSnapshot(first)
      const current = yield* takenSnapshot(second)

      assert.deepStrictEqual(snapshotIn(current, one), first)
      assert.deepStrictEqual(snapshotIn(current, two), second)
    }).pipe(Effect.provide(directorOver))
  )

  it.effect("should take a listed game's plays", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one })])

      const current = yield* delivered(Delivery.Plays({ game: one, plays: [play()] }))

      assert.deepStrictEqual(playsIn(current, one), [play()])
    }).pipe(Effect.provide(directorOver))
  )

  it.effect("should drop plays for a game no listing names", () =>
    Effect.gen(function* () {
      const current = yield* delivered(Delivery.Plays({ game: one, plays: [play()] }))

      assert.deepStrictEqual(current.games, [])
    }).pipe(Effect.provide(directorOver))
  )

  it.effect("should take every delivery of a frame", () =>
    Effect.gen(function* () {
      const feed = yield* ProviderFeed
      const next = liveSnapshot({ id: one, clock: "9:00" })

      yield* feed.deliver([listingOf([liveSnapshot({ id: one })]), Delivery.Snapshot({ snapshot: next })])
      const current = yield* latest

      assert.strictEqual(snapshotIn(current, one), next)
    }).pipe(Effect.provide(directorOver))
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
    }).pipe(Effect.provide(directorOver.pipe(Layer.provideMerge(recordingSpans(ended)))))
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
    }).pipe(Effect.provide(directorOver.pipe(Layer.provideMerge(layer))))
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
      yield* takenSnapshot(second)
      yield* Effect.yieldNow
      const all = yield* Ref.get(given)

      assert.deepStrictEqual(all, [undefined, first, second])
    }).pipe(Effect.provide(directorOver))
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

      yield* takenSnapshot(liveSnapshot({ id: one, clock: "11:00" }))
      yield* Effect.yieldNow
      const count = yield* Ref.get(given)

      assert.strictEqual(count, 2)
    }).pipe(Effect.provide(directorOver))
  )
})

describe("Director, a take that raises a defect", () => {
  it.effect("should keep the slate as it was", () =>
    Effect.gen(function* () {
      const before = yield* listing([liveSnapshot({ id: one, clock: "9:00" })])

      const current = yield* takenSnapshot(broken(one))

      assert.strictEqual(current, before)
    }).pipe(Effect.provide(directorOver))
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
    }).pipe(Effect.provide(directorOver.pipe(Layer.provideMerge(layer))))
  })

  it.effect("should take the game's next snapshot", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one, clock: "9:00" })])
      yield* takenSnapshot(broken(one))
      const next = liveSnapshot({ id: one, clock: "7:00" })

      const current = yield* takenSnapshot(next)

      assert.strictEqual(snapshotIn(current, one), next)
    }).pipe(Effect.provide(directorOver))
  )
})

describe("Director, a recorded game", () => {
  it.effect(
    "should take NE at BUF's recorded day to its final, with every play the recording has, logging no error",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        const frames = yield* recordedNeAtBuf
        const decoded = yield* decodedFrames(frames)
        const feed = yield* ProviderFeed

        yield* Effect.forEach(decoded, (deliveries) => feed.deliver(deliveries), { discard: true })
        const current = yield* latest
        const errors = logs.filter(({ level }) => level === "Error")

        assert.strictEqual(snapshotIn(current, neAtBuf)?.status, "final")
        assert.strictEqual(playsIn(current, neAtBuf).length, recordedPlays)
        assert.deepStrictEqual(errors, [])
      }).pipe(Effect.provide(directorOver.pipe(Layer.provideMerge(layer))))
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
    }).pipe(Effect.provide(directorOver), withMetrics)
  )

  it.effect("should gauge a game no listing names any more as 0", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one }), liveSnapshot({ id: two })])

      yield* listing([liveSnapshot({ id: two })])
      const value = yield* gauged("sportal_game_state", { game: one })

      assert.strictEqual(value, 0)
    }).pipe(Effect.provide(directorOver), withMetrics)
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
  return delivered(listingOf(games))
}

function takenSnapshot(game: GameSnapshot) {
  return delivered(Delivery.Snapshot({ snapshot: game }))
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

describe("Director's play log", () => {
  it.effect("should log each play a take adds once, annotated with its game", () => {
    const { logs, layer } = recordingLogs()
    const game = liveSnapshot({ id: one })
    const first = play({ id: PlayId.make("p1"), sequence: 1, text: "Rush for 1 yard" })
    const second = play({ id: PlayId.make("p2"), sequence: 2, clock: "14:20", text: "Rush for 4 yards" })
    return Effect.gen(function* () {
      yield* listing([game])
      yield* delivered(Delivery.Plays({ game: one, plays: [first] }))

      yield* delivered(Delivery.Plays({ game: one, plays: [first, second] }))

      const played = logs.filter(({ annotations }) => annotations.play !== undefined)
      assert.deepStrictEqual(
        played.map(({ level, annotations }) => ({ level, game: annotations.game, play: annotations.play })),
        [
          { level: "Info", game: one, play: "Rush" },
          { level: "Info", game: one, play: "Rush" }
        ]
      )
      assert.include(played[1]?.message ?? "", `Director: ${game.matchup()} Q1 14:20 Rush for 4 yards`)
    }).pipe(Effect.provide(directorOver.pipe(Layer.provideMerge(layer))))
  })
})
