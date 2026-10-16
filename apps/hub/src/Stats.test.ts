import { assert, describe, it } from "@effect/vitest"
import { CalendarDate } from "@sportal/api/GamesQuery"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { GameStats } from "@sportal/domain/GameStats"
import { HighlightId } from "@sportal/domain/Highlight"
import type { LeagueId } from "@sportal/domain/League"
import { PlayId } from "@sportal/domain/Play"
import { highlight, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Delivery, ProviderUnavailable } from "./provider/Provider.ts"
import { Stats } from "./Stats.ts"
import * as TestHub from "./TestHub.ts"

describe("Stats#stats", () => {
  it.effect("should answer an upcoming game with empty stats", () =>
    TestHub.withStats({}, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [upcoming])
        const stats = yield* Stats

        const answer = yield* stats.stats(upcoming.id)

        assert.deepStrictEqual(answer, GameStats.empty(upcoming.id))
      })
    )
  )

  it.effect("should not ask the provider for an upcoming game's stats", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [upcoming])
        const stats = yield* Stats

        yield* stats.stats(upcoming.id)

        assert.strictEqual(asked.times(), 0)
      })
    )
  })

  it.effect("should ask the provider for a final game's stats only once", () => {
    const asked = counted((game) => Effect.succeed(withHighlight(game)))
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [finalA])
        const stats = yield* Stats
        yield* stats.stats(finalA.id)

        yield* TestClock.adjust("1 hour")
        yield* stats.stats(finalA.id)

        assert.strictEqual(asked.times(), 1)
      })
    )
  })

  it.effect("should ask again after 10 minutes for a final game with no highlights yet", () => {
    const asked = counted((game, times) =>
      Effect.succeed(times === 1 ? GameStats.empty(game) : withHighlight(game))
    )
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [finalA])
        const stats = yield* Stats
        yield* stats.stats(finalA.id)

        yield* TestClock.adjust("10 minutes")
        const later = yield* stats.stats(finalA.id)

        assert.deepStrictEqual(later.highlights.length, 1)
      })
    )
  })

  it.effect("should not ask again after 10 minutes for a final game with highlights", () => {
    const asked = counted((game) => Effect.succeed(withHighlight(game)))
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [finalA])
        const stats = yield* Stats
        yield* stats.stats(finalA.id)

        yield* TestClock.adjust("10 minutes")
        yield* stats.stats(finalA.id)

        assert.strictEqual(asked.times(), 1)
      })
    )
  })

  it.effect("should ask the provider again for a final game whose stats were unavailable", () => {
    const asked = counted(() => Effect.fail(unanswered))
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [finalA])
        const stats = yield* Stats
        yield* Effect.flip(stats.stats(finalA.id))

        yield* Effect.flip(stats.stats(finalA.id))

        assert.strictEqual(asked.times(), 2)
      })
    )
  })

  it.effect("should fail as unavailable when the provider cannot give the stats", () =>
    TestHub.withStats({}, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [finalA])
        const stats = yield* Stats

        const error = yield* Effect.flip(stats.stats(finalA.id))

        assert.strictEqual(error._tag, "StatsUnavailable")
      })
    )
  )

  it.effect("should fail as not found for a game no day lists", () =>
    TestHub.withStats({}, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const stats = yield* Stats

        const error = yield* Effect.flip(stats.stats(GameId.make("nope")))

        assert.strictEqual(error._tag, "GameNotFound")
      })
    )
  )

  it.effect("should not ask again for a live game's stats asked once", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const stats = yield* Stats
        yield* stats.stats(TestHub.alaAtMsst.id)

        yield* TestClock.adjust("2 minutes")

        assert.strictEqual(asked.times(), 1)
      })
    )
  })
})

describe("Stats#statsLive", () => {
  it.effect("should send a live game's stats again after each refresh", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const values = yield* followed(TestHub.alaAtMsst.id)
        yield* Queue.take(values)

        yield* TestClock.adjust("30 seconds")
        const second = yield* Queue.take(values)

        assert.deepStrictEqual(second.scoringPlays, [PlayId.make("p2")])
      })
    )
  })

  it.effect("should stop refreshing a live game a refresh after nothing follows it", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        yield* Effect.scoped(Effect.flatMap(followed(TestHub.alaAtMsst.id), Queue.take))
        yield* TestClock.adjust("2 minutes")
        const stopped = asked.times()

        yield* TestClock.adjust("2 minutes")

        assert.strictEqual(asked.times(), stopped)
      })
    )
  })

  it.effect("should fetch a live game once a refresh however many follow it", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const one = yield* followed(TestHub.alaAtMsst.id)
        const other = yield* followed(TestHub.alaAtMsst.id)
        yield* Queue.take(one)
        yield* Queue.take(other)

        yield* TestClock.adjust("30 seconds")
        yield* Queue.take(one)
        yield* Queue.take(other)

        assert.strictEqual(asked.times(), 2)
      })
    )
  })

  it.effect("should not fetch a live game again at once when it is followed again within a refresh", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        yield* Effect.scoped(Effect.flatMap(followed(TestHub.alaAtMsst.id), Queue.take))
        yield* TestClock.adjust("10 seconds")

        yield* Effect.scoped(Effect.flatMap(followed(TestHub.alaAtMsst.id), Queue.take))

        assert.strictEqual(asked.times(), 1)
      })
    )
  })

  it.effect("should keep refreshing a live game after a refresh dies", () => {
    const asked = counted((game, times) =>
      times === 2
        ? Effect.die("refresh died")
        : Effect.succeed(
            new GameStats({ ...GameStats.empty(game), scoringPlays: [PlayId.make(`p${times}`)] })
          )
    )
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const values = yield* followed(TestHub.alaAtMsst.id)
        yield* Queue.take(values)

        yield* TestClock.adjust("60 seconds")
        const next = yield* Queue.take(values)

        assert.deepStrictEqual(next.scoringPlays, [PlayId.make("p3")])
      })
    )
  })

  it.effect("should send an upcoming game's empty stats without asking the provider", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [upcoming])
        const values = yield* followed(upcoming.id)

        const first = yield* Queue.take(values)

        assert.deepStrictEqual([first, asked.times()], [GameStats.empty(upcoming.id), 0])
      })
    )
  })
})

describe("Stats#highlights", () => {
  it.effect("should give the highlights of the day's final games in the league", () =>
    TestHub.withStats({ stats: (_, game) => Effect.succeed(withHighlight(game)) }, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [finalA, finalB, TestHub.alaAtMsst])
        const stats = yield* Stats

        const highlights = yield* stats.highlights("fbs", today)

        assert.deepStrictEqual(highlights.map(({ id }) => id).toSorted(), [
          HighlightId.make(`clip-${finalA.id}`),
          HighlightId.make(`clip-${finalB.id}`)
        ])
      })
    )
  )

  it.effect("should fetch each final game's stats once", () => {
    const asked = counted()
    return TestHub.withStats({ stats: asked.stats }, (frames) =>
      Effect.gen(function* () {
        yield* listed(frames, [finalA, finalB])
        const stats = yield* Stats
        yield* stats.highlights("fbs", today)

        yield* stats.highlights("fbs", today)

        assert.strictEqual(asked.times(), 2)
      })
    )
  })

  it.effect("should leave out a final game whose stats are unavailable", () =>
    TestHub.withStats(
      {
        stats: (_, game) =>
          game === finalA.id ? Effect.fail(unanswered) : Effect.succeed(withHighlight(game))
      },
      (frames) =>
        Effect.gen(function* () {
          yield* listed(frames, [finalA, finalB])
          const stats = yield* Stats

          const highlights = yield* stats.highlights("fbs", today)

          assert.deepStrictEqual(
            highlights.map(({ id }) => id),
            [HighlightId.make(`clip-${finalB.id}`)]
          )
        })
    )
  )
})

const today = CalendarDate.make("2026-10-03")

const upcoming = snapshot({ id: GameId.make("10") })

const finalA = snapshot({
  id: GameId.make("11"),
  status: "final",
  startsAt: DateTime.makeUnsafe("2026-10-03T16:00:00Z")
})

const finalB = snapshot({
  id: GameId.make("12"),
  status: "final",
  startsAt: DateTime.makeUnsafe("2026-10-03T17:00:00Z")
})

const unanswered = new ProviderUnavailable({ reason: "Unanswered", cause: "test" })

/** Delivers the fbs listing of `games`, so the Director has them, and moves on 250 ms for it to settle. */
const listed = Effect.fnUntraced(function* (frames: TestHub.Frames, games: ReadonlyArray<GameSnapshot>) {
  yield* TestHub.offered(frames, Delivery.Listing({ league: "fbs", games }))
  yield* TestClock.adjust("250 millis")
})

/** A queue of what the live stats of `id` send, for the rest of the test's scope. */
const followed = Effect.fnUntraced(function* (id: GameId) {
  const stats = yield* Stats
  const live = yield* stats.statsLive(id)

  return yield* TestHub.received(Stream.orDie(live))
})

/**
 * The provider's stats, each the `n`th answer's (`answer`, by default empty stats whose one scoring play is `p<n>`), and
 * how many times it was asked.
 */
function counted(
  answer: (game: GameId, times: number) => Effect.Effect<GameStats, ProviderUnavailable> = (game, times) =>
    Effect.succeed(new GameStats({ ...GameStats.empty(game), scoringPlays: [PlayId.make(`p${times}`)] }))
) {
  let times = 0
  return {
    stats: (_league: LeagueId, game: GameId) =>
      Effect.suspend(() => {
        times += 1
        return answer(game, times)
      }),
    times: () => times
  }
}

/** Empty stats of `game` with one highlight, `clip-<game>`. */
function withHighlight(game: GameId): GameStats {
  const clip = highlight({ id: HighlightId.make(`clip-${game}`), game })
  return new GameStats({ ...GameStats.empty(game), highlights: [clip] })
}
