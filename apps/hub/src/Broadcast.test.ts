import { assert, describe, it } from "@effect/vitest"
import type { SlateChanged } from "@sportal/api/LiveMessage"
import { GameId } from "@sportal/domain/Game"
import { PlayId } from "@sportal/domain/Play"
import { broadcast, play, snapshot } from "@sportal/domain/TestGame"
import { type Cause, Effect, Layer, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Broadcast } from "./Broadcast.ts"
import { Director } from "./Director.ts"
import { Delivery, Provider } from "./provider/Provider.ts"
import { Source } from "./source/Source.ts"
import * as TestHub from "./TestHub.ts"

describe("Broadcast", () => {
  describe("sharing", () => {
    it.effect("should not read the source's availability again for a subscriber that joins", () =>
      Effect.gen(function* () {
        let reads = 0
        const counted = Source.layerTest(() => {
          reads += 1
          return { _tag: "NotCarried", why: "StreamingOnly" }
        })

        yield* broadcasting(
          (frames) =>
            Effect.gen(function* () {
              yield* TestHub.alaAtMsstListed(frames)
              yield* pastFirstMessage()
              const readForOne = reads

              yield* pastFirstMessage()

              assert.strictEqual(reads, readForOne)
            }),
          counted
        )
      })
    )
  })

  describe("settling", () => {
    it.effect("should send a burst of slate changes once, when it settles", () =>
      broadcasting((frames) =>
        Effect.gen(function* () {
          yield* TestHub.alaAtMsstListed(frames)
          const messages = yield* pastFirstMessage()
          const pushes = [2, 3, 4].map((period) =>
            Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsstInPeriod(period)] })
          )

          yield* Effect.forEach(pushes, (push) => TestHub.offered(frames, push))
          // The broadcast reads each slate in turn; it reads the burst before the clock moves on.
          yield* Effect.yieldNow
          yield* TestClock.adjust("250 millis")
          const message = yield* Queue.take(messages)
          const waiting = yield* Queue.size(messages)

          assert.deepStrictEqual(
            message.slate.games.map((game) => game.snapshot.period),
            [4]
          )
          assert.strictEqual(waiting, 0)
        })
      )
    )

    it.effect("should send nothing when the 30-second recheck finds no game's availability changed", () =>
      broadcasting((frames) =>
        Effect.gen(function* () {
          yield* TestHub.alaAtMsstListed(frames)
          const messages = yield* pastFirstMessage()

          yield* TestClock.adjust("30 seconds")
          yield* TestHub.offered(
            frames,
            Delivery.Listing({ league: "fbs", games: [TestHub.alaAtMsstInPeriod(2)] })
          )
          yield* TestClock.adjust("250 millis")
          const message = yield* Queue.take(messages)

          assert.deepStrictEqual(
            message.slate.games.map((game) => game.snapshot.period),
            [2]
          )
        })
      )
    )
  })

  describe("projection", () => {
    it.effect("should publish the listing order with leagues in their order", () =>
      broadcasting((frames) =>
        Effect.gen(function* () {
          const fbs = ["3", "1", "2"].map((id) =>
            snapshot({ id: GameId.make(id), league: "fbs", status: "live", period: 1, clock: "10:00" })
          )
          const nfl = snapshot({ id: GameId.make("9"), league: "nfl", status: "live" })

          const message = yield* publishedAfter(frames, [
            Delivery.Listing({ league: "fbs", games: fbs }),
            Delivery.Listing({ league: "nfl", games: [nfl] })
          ])

          assert.deepStrictEqual(
            message.slate.games.map((game) => game.snapshot.id),
            ["9", "3", "1", "2"]
          )
        })
      )
    )

    it.effect("should publish the accepted snapshot rather than the original listing", () =>
      broadcasting((frames) =>
        Effect.gen(function* () {
          const first = snapshot({ id: GameId.make("1"), status: "live", period: 1, clock: "10:00" })
          const next = snapshot({ ...first, period: 2 })

          const message = yield* publishedAfter(frames, [
            Delivery.Listing({ league: "fbs", games: [first] }),
            Delivery.Listing({ league: "fbs", games: [next] })
          ])

          assert.strictEqual(message.slate.games[0]?.snapshot.period, 2)
        })
      )
    )

    it.effect("should publish each listed game's plays", () =>
      broadcasting((frames) =>
        Effect.gen(function* () {
          const listed = snapshot({ id: GameId.make("1"), status: "live" })
          const recordedPlay = play({ id: PlayId.make("p1"), sequence: 1 })

          const message = yield* publishedAfter(frames, [
            Delivery.Listing({ league: "fbs", games: [listed] }),
            Delivery.Plays({ game: listed.id, plays: [recordedPlay] })
          ])

          assert.deepStrictEqual(message.slate.games[0]?.plays, [recordedPlay])
        })
      )
    )

    it.effect("should publish only the last ten plays in sequence order", () =>
      broadcasting((frames) =>
        Effect.gen(function* () {
          const listed = snapshot({ id: GameId.make("1"), status: "live" })
          const plays = Array.from({ length: 12 }, (_, index) =>
            play({ id: PlayId.make(`p${index + 1}`), sequence: index + 1 })
          ).toReversed()

          const message = yield* publishedAfter(frames, [
            Delivery.Listing({ league: "fbs", games: [listed] }),
            Delivery.Plays({ game: listed.id, plays })
          ])

          assert.deepStrictEqual(
            message.slate.games[0]?.plays.map(({ sequence }) => sequence),
            [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
          )
        })
      )
    )

    it.effect("should publish a listed final game", () =>
      broadcasting((frames) =>
        Effect.gen(function* () {
          const final = snapshot({ id: GameId.make("1"), status: "final" })

          const message = yield* publishedAfter(frames, [Delivery.Listing({ league: "fbs", games: [final] })])

          assert.deepStrictEqual(
            message.slate.games.map((game) => game.snapshot),
            [final]
          )
        })
      )
    )

    it.effect("should publish each listed game's classification, by its id", () =>
      broadcasting((frames) =>
        Effect.gen(function* () {
          const listed = snapshot({ id: GameId.make("1"), status: "live", period: 1, clock: "10:00" })

          const message = yield* publishedAfter(frames, [
            Delivery.Listing({ league: "fbs", games: [listed] })
          ])

          assert.strictEqual(message.classifications[GameId.make("1")]?.moment._tag, "Live")
        })
      )
    )

    it.effect("should publish every source's availability for each game, by its id", () =>
      broadcasting(
        (frames) =>
          Effect.gen(function* () {
            const listed = snapshot({ id: GameId.make("1"), status: "live" })

            const message = yield* publishedAfter(frames, [
              Delivery.Listing({ league: "fbs", games: [listed] })
            ])

            assert.deepStrictEqual(message.availability[GameId.make("1")], [
              { _tag: "NotCarried", why: "StreamingOnly" },
              { _tag: "NoGuide", source: "Twitch" }
            ])
          }),
        Source.layerAll([
          Source.layerTest(() => ({ _tag: "NotCarried", why: "StreamingOnly" })),
          Source.layerTest(() => ({ _tag: "NoGuide", source: "Twitch" }))
        ])
      )
    )
  })

  describe("availability", () => {
    it.effect(
      "should send a game as carried once a snapshot says it has kicked off, with nothing else changing",
      () =>
        broadcasting(
          (frames) =>
            Effect.gen(function* () {
              const scheduled = snapshot({
                id: TestHub.alaAtMsst.id,
                broadcasts: [broadcast("Prime Video", "streaming")]
              })
              yield* TestHub.offered(frames, Delivery.Listing({ league: "fbs", games: [scheduled] }))
              yield* TestClock.adjust("250 millis")
              const messages = yield* pastFirstMessage()

              yield* TestHub.offered(
                frames,
                Delivery.Listing({ league: "fbs", games: [snapshot({ ...scheduled, status: "live" })] })
              )
              yield* TestClock.adjust("250 millis")
              const message = yield* Queue.take(messages)

              assert.deepStrictEqual(
                message.availability[TestHub.alaAtMsst.id]?.map(({ _tag }) => _tag),
                ["Carried"]
              )
            }),
          Source.layerTwitch
        )
    )
  })
})

function broadcasting<A, E, R>(
  test: (frames: TestHub.Frames) => Effect.Effect<A, E, R>,
  source: Layer.Layer<Source> = Source.layerYouTubeTv
) {
  return Effect.gen(function* () {
    const frames = yield* Queue.bounded<ReadonlyArray<Delivery>, Cause.Done>(1)
    const broadcast = Broadcast.layer.pipe(
      Layer.provide(Director.layer),
      Layer.provide(Provider.layerTest(frames)),
      Layer.provide(source)
    )

    return yield* test(frames).pipe(Effect.scoped, Effect.provide(broadcast))
  })
}

/** Subscribes to the broadcast: a queue of its messages, as they arrive. */
const subscribed = Effect.fn("Broadcast.test.subscribed")(function* () {
  const { messages } = yield* Broadcast
  const received = yield* Queue.unbounded<SlateChanged>()

  yield* messages.pipe(
    Stream.runForEach((message) => Queue.offer(received, message)),
    Effect.forkScoped
  )

  return received
})

/** Subscribes and takes the first message, the current slate: the messages after it. */
const pastFirstMessage = Effect.fn("Broadcast.test.pastFirstMessage")(function* () {
  const messages = yield* subscribed()

  yield* Queue.take(messages)

  return messages
})

/** The message first sent after `deliveries`, with no subscriber before them. */
const publishedAfter = Effect.fnUntraced(function* (
  frames: TestHub.Frames,
  deliveries: ReadonlyArray<Delivery>
) {
  yield* Effect.forEach(deliveries, (delivery) => TestHub.offered(frames, delivery), { discard: true })
  yield* TestClock.adjust("250 millis")
  const messages = yield* subscribed()
  return yield* Queue.take(messages)
})
