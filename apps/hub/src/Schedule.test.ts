import { assert, describe, it } from "@effect/vitest"
import { CalendarDate } from "@sportal/api/GamesQuery"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { GameId } from "@sportal/domain/Game"
import { play, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Queue, type Stream } from "effect"
import { TestClock } from "effect/testing"
import { Delivery } from "./provider/Provider.ts"
import { Schedule } from "./Schedule.ts"
import { Source } from "./source/Source.ts"
import * as TestHub from "./TestHub.ts"

describe("Schedule#list", () => {
  it.effect("should answer today with the slate's games starting today", () =>
    TestHub.scheduled({}, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.offered(
          frames,
          Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsst, yesterdaysFinal] })
        )
        const schedule = yield* Schedule

        const answer = yield* schedule.list({})

        assert.deepStrictEqual(
          answer.games.map(({ snapshot }) => snapshot.id),
          [TestHub.alaAtMsst.id]
        )
      })
    )
  )

  it.effect("should answer today with a live game that started yesterday", () =>
    TestHub.scheduled({}, (frames) =>
      Effect.gen(function* () {
        const lateLastNight = snapshot({ ...yesterdaysFinal, status: "live", period: 7 })
        yield* TestHub.offered(frames, Delivery.Listing({ league: "fbs", games: [lateLastNight] }))
        const schedule = yield* Schedule

        const answer = yield* schedule.list({})

        assert.deepStrictEqual(
          answer.games.map(({ snapshot }) => snapshot.id),
          [lateLastNight.id]
        )
      })
    )
  )

  it.effect("should answer another day with the provider's listing for it", () =>
    TestHub.scheduled({ listing: () => Effect.succeed([tomorrows]) }, () =>
      Effect.gen(function* () {
        const schedule = yield* Schedule

        const answer = yield* schedule.list({ date: tomorrow })

        assert.strictEqual(answer.date, tomorrow)
        assert.deepStrictEqual(
          answer.games.map(({ snapshot }) => snapshot.id),
          [tomorrows.id]
        )
      })
    )
  )

  it.effect("should ask the provider for a past day only once", () => {
    const asked = counted()
    return TestHub.scheduled({ listing: asked.listing }, () =>
      Effect.gen(function* () {
        const schedule = yield* Schedule
        yield* schedule.list({ date: yesterday })

        yield* TestClock.adjust("1 day")
        yield* schedule.list({ date: yesterday })

        assert.strictEqual(asked.times(), 1)
      })
    )
  })

  it.effect("should ask the provider for a future day again after 10 minutes", () => {
    const asked = counted()
    return TestHub.scheduled({ listing: asked.listing }, () =>
      Effect.gen(function* () {
        const schedule = yield* Schedule
        yield* schedule.list({ date: tomorrow })

        yield* TestClock.adjust("10 minutes")
        yield* schedule.list({ date: tomorrow })

        assert.strictEqual(asked.times(), 2)
      })
    )
  })

  it.effect("should fail as unavailable when the provider cannot list the day", () =>
    TestHub.scheduled({}, () =>
      Effect.gen(function* () {
        const schedule = yield* Schedule

        const error = yield* schedule.list({ date: tomorrow }).pipe(Effect.flip)

        assert.strictEqual(error._tag, "ScheduleUnavailable")
      })
    )
  )

  it.effect("should keep only the query's leagues", () =>
    TestHub.scheduled({}, (frames) =>
      Effect.gen(function* () {
        const nfl = snapshot({ id: GameId.make("9"), league: "nfl", status: "live" })
        yield* TestHub.offered(frames, Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsst] }))
        yield* TestHub.offered(frames, Delivery.Listing({ league: "nfl", games: [nfl] }))
        const schedule = yield* Schedule

        const answer = yield* schedule.list({ league: ["nfl"] })

        assert.deepStrictEqual(
          answer.games.map(({ snapshot }) => snapshot.id),
          [nfl.id]
        )
      })
    )
  )
})

describe("Schedule#listLive", () => {
  it.effect("should send the answer again when a game in it changes", () =>
    TestHub.scheduled({}, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const schedule = yield* Schedule
        const live = yield* schedule.listLive({})
        const answers = yield* pastFirst(live)

        yield* TestHub.offered(
          frames,
          Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsstInPeriod(2)] })
        )
        yield* TestClock.adjust("250 millis")
        const answer = yield* Queue.take(answers)

        assert.deepStrictEqual(
          answer.games.map(({ snapshot }) => snapshot.period),
          [2]
        )
      })
    )
  )

  it.effect("should not send an answer that is the same as the last", () =>
    TestHub.scheduled({}, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const schedule = yield* Schedule
        const live = yield* schedule.listLive({})
        const answers = yield* pastFirst(live)

        yield* TestHub.offered(frames, Delivery.Plays({ game: TestHub.alaAtMsst.id, plays: [play()] }))
        yield* TestClock.adjust("250 millis")
        yield* TestHub.offered(
          frames,
          Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsstInPeriod(2)] })
        )
        yield* TestClock.adjust("250 millis")
        const answer = yield* Queue.take(answers)

        assert.deepStrictEqual(
          answer.games.map(({ snapshot }) => snapshot.period),
          [2]
        )
      })
    )
  )

  it.effect("should send the answer again when a game's availability changes", () => {
    let availability: ChannelAvailability = { _tag: "NotCarried", why: "StreamingOnly" }
    const source = Source.layerTest(() => availability)
    return TestHub.scheduled(
      {},
      (frames) =>
        Effect.gen(function* () {
          yield* TestHub.alaAtMsstListed(frames)
          const schedule = yield* Schedule
          const live = yield* schedule.listLive({})
          const answers = yield* pastFirst(live)

          availability = { _tag: "NoGuide", source: "YouTube TV" }
          yield* TestClock.adjust("30 seconds")
          yield* TestClock.adjust("250 millis")
          const answer = yield* Queue.take(answers)

          assert.deepStrictEqual(
            answer.games.map((game) => game.availability),
            [[{ _tag: "NoGuide", source: "YouTube TV" }]]
          )
        }),
      source
    )
  })

  it.effect("should send a burst of changes once, when it settles", () =>
    TestHub.scheduled({}, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const schedule = yield* Schedule
        const live = yield* schedule.listLive({})
        const answers = yield* pastFirst(live)
        const pushes = [2, 3, 4].map((period) =>
          Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsstInPeriod(period)] })
        )

        yield* Effect.forEach(pushes, (push) => TestHub.offered(frames, push))
        // The answer reads each slate in turn; it reads the burst before the clock moves on.
        yield* Effect.yieldNow
        yield* TestClock.adjust("250 millis")
        const answer = yield* Queue.take(answers)
        const waiting = yield* Queue.size(answers)

        assert.deepStrictEqual(
          answer.games.map(({ snapshot }) => snapshot.period),
          [4]
        )
        assert.strictEqual(waiting, 0)
      })
    )
  )

  it.effect("should send nothing when the 30-second recheck finds no game's availability changed", () =>
    TestHub.scheduled({}, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const schedule = yield* Schedule
        const live = yield* schedule.listLive({})
        const answers = yield* pastFirst(live)

        yield* TestClock.adjust("30 seconds")
        yield* TestHub.offered(
          frames,
          Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsstInPeriod(2)] })
        )
        yield* TestClock.adjust("250 millis")
        const answer = yield* Queue.take(answers)

        assert.deepStrictEqual(
          answer.games.map(({ snapshot }) => snapshot.period),
          [2]
        )
      })
    )
  )

  it.effect("should send every source's availability for each game", () =>
    TestHub.scheduled(
      {},
      (frames) =>
        Effect.gen(function* () {
          yield* TestHub.alaAtMsstListed(frames)
          const schedule = yield* Schedule
          const live = yield* schedule.listLive({})

          const answers = yield* TestHub.received(live)
          const answer = yield* Queue.take(answers)

          assert.deepStrictEqual(
            answer.games.map(({ availability }) => availability),
            [
              [
                { _tag: "NotCarried", why: "StreamingOnly" },
                { _tag: "NoGuide", source: "Twitch" }
              ]
            ]
          )
        }),
      Source.layerAll([
        Source.layerTest(() => ({ _tag: "NotCarried", why: "StreamingOnly" })),
        Source.layerTest(() => ({ _tag: "NoGuide", source: "Twitch" }))
      ])
    )
  )
})

describe("Schedule#game", () => {
  it.effect("should answer a game on today's slate with its availability", () =>
    TestHub.scheduled({}, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const schedule = yield* Schedule

        const game = yield* schedule.game(TestHub.alaAtMsst.id)

        assert.strictEqual(game.snapshot.id, TestHub.alaAtMsst.id)
        assert.deepStrictEqual(game.availability, [{ _tag: "NoGuide", source: "YouTube TV" }])
      })
    )
  )

  it.effect("should answer a game of a day it already listed", () =>
    TestHub.scheduled({ listing: () => Effect.succeed([tomorrows]) }, () =>
      Effect.gen(function* () {
        const schedule = yield* Schedule
        yield* schedule.list({ date: tomorrow })

        const game = yield* schedule.game(tomorrows.id)

        assert.strictEqual(game.snapshot.id, tomorrows.id)
      })
    )
  )

  it.effect("should fail as not found for a game no held day lists", () =>
    TestHub.scheduled({}, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        const schedule = yield* Schedule

        const error = yield* schedule.game(GameId.make("nope")).pipe(Effect.flip)

        assert.strictEqual(error._tag, "GameNotFound")
      })
    )
  )
})

describe("Schedule#plays", () => {
  it.effect("should page a slate game's plays newest first", () =>
    TestHub.scheduled({}, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        yield* TestHub.offered(
          frames,
          Delivery.Plays({ game: TestHub.alaAtMsst.id, plays: TestHub.playsUpTo(3) })
        )
        const schedule = yield* Schedule

        const page = yield* schedule.plays(TestHub.alaAtMsst.id, { limit: 2 })

        assert.deepStrictEqual(
          page.plays.map(({ sequence }) => sequence),
          [3, 2]
        )
        assert.isTrue(page.more)
      })
    )
  )

  it.effect("should fetch an off-slate game's plays from the provider", () =>
    TestHub.scheduled(
      { listing: () => Effect.succeed([tomorrows]), plays: () => Effect.succeed(TestHub.playsUpTo(2)) },
      () =>
        Effect.gen(function* () {
          const schedule = yield* Schedule
          yield* schedule.list({ date: tomorrow })

          const page = yield* schedule.plays(tomorrows.id, {})

          assert.deepStrictEqual(
            page.plays.map(({ sequence }) => sequence),
            [2, 1]
          )
        })
    )
  )
})

describe("Schedule#playsLive", () => {
  it.effect("should start with a reset to the latest page", () =>
    TestHub.scheduled({}, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        yield* TestHub.offered(
          frames,
          Delivery.Plays({ game: TestHub.alaAtMsst.id, plays: TestHub.playsUpTo(2) })
        )
        const schedule = yield* Schedule
        const live = yield* schedule.playsLive(TestHub.alaAtMsst.id)
        const changes = yield* TestHub.received(live)

        const change = yield* Queue.take(changes)

        assert.strictEqual(change._tag, "Reset")
        assert.deepStrictEqual(
          change.plays.map(({ sequence }) => sequence),
          [2, 1]
        )
      })
    )
  )

  it.effect("should append a play the slate takes", () =>
    TestHub.scheduled({}, (frames) =>
      Effect.gen(function* () {
        yield* TestHub.alaAtMsstListed(frames)
        yield* TestHub.offered(
          frames,
          Delivery.Plays({ game: TestHub.alaAtMsst.id, plays: TestHub.playsUpTo(2) })
        )
        const schedule = yield* Schedule
        const live = yield* schedule.playsLive(TestHub.alaAtMsst.id)
        const changes = yield* pastFirst(live)

        yield* TestHub.offered(
          frames,
          Delivery.Plays({ game: TestHub.alaAtMsst.id, plays: TestHub.playsUpTo(3) })
        )
        const change = yield* Queue.take(changes)

        assert.strictEqual(change._tag, "Appended")
        assert.deepStrictEqual(
          change.plays.map(({ sequence }) => sequence),
          [3]
        )
      })
    )
  )
})

/** Yesterday and tomorrow, on `TestHub.onAlaAtMsstDay`. */
const yesterday = CalendarDate.make("2026-10-02")
const tomorrow = CalendarDate.make("2026-10-04")

/** A game that started yesterday evening, US Eastern, and is over. */
const yesterdaysFinal = snapshot({
  id: GameId.make("2"),
  status: "final",
  startsAt: DateTime.makeUnsafe("2026-10-02T23:30:00Z")
})

/** A game tomorrow, US Eastern, off today's slate. */
const tomorrows = snapshot({ id: GameId.make("3"), startsAt: DateTime.makeUnsafe("2026-10-04T17:00:00Z") })

/** A provider's listing that answers `tomorrows` for any day, and how many times it was asked. */
function counted() {
  let times = 0
  return {
    listing: () =>
      Effect.sync(() => {
        times += 1
        return [tomorrows]
      }),
    times: () => times
  }
}

/** The values a live answer sends, past its first: the current one. */
const pastFirst = Effect.fnUntraced(function* <A>(live: Stream.Stream<A>) {
  const values = yield* TestHub.received(live)

  yield* Queue.take(values)

  return values
})
