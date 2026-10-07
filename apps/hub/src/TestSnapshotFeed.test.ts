import { assert, describe, it, layer } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId } from "@sportal/domain/Game"
import { liveSnapshot, play, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Exit, Schedule, Schema } from "effect"
import type { FeedFrame } from "./Frame.ts"
import { Provider, ProviderError } from "./provider/Provider.ts"
import { decodedFrames } from "./provider/TestDecoder.ts"
import * as TestSnapshotFeed from "./TestSnapshotFeed.ts"

const received = DateTime.makeUnsafe("2026-10-06T18:00:00Z")
const encode = Schema.encodeSync(TestSnapshotFeed.SnapshotPayload)

layer(TestSnapshotFeed.decoder)("TestSnapshotFeed.decoder", (it) => {
  it.effect("a poll of the snapshot provider decodes to the listing it answered", () =>
    Effect.gen(function* () {
      const games = [snapshot(), liveSnapshot()]
      const frame = yield* Provider.use((provider) => provider.poll("fbs")).pipe(
        Effect.provide(
          TestSnapshotFeed.provider({
            games: () => Effect.succeed(games),
            polling: Schedule.spaced("10 seconds")
          })
        )
      )
      const [decoded] = yield* decodedFrames([frame])
      assert.deepStrictEqual(decoded?.deliveries, [Delivery.cases.Listing.make({ league: "fbs", games })])
      assert.deepStrictEqual([decoded?.resyncs, decoded?.observations], [[], []])
    })
  )

  it.effect.each([
    { name: "Snapshot", delivery: Delivery.cases.Snapshot.make({ snapshot: liveSnapshot(), from: "push" }) },
    {
      name: "Snapshot polled",
      delivery: Delivery.cases.Snapshot.make({ snapshot: liveSnapshot(), from: "poll" })
    },
    { name: "Plays", delivery: Delivery.cases.Plays.make({ game: GameId.make("401"), plays: [play()] }) }
  ])("a $name round-trips through a frame", ({ delivery }) =>
    Effect.gen(function* () {
      const [decoded] = yield* decodedFrames([said(encode(delivery))])
      assert.deepStrictEqual(decoded?.deliveries, [delivery])
    })
  )

  it.effect("a Resync resyncs the frame's channel", () =>
    Effect.gen(function* () {
      const [decoded] = yield* decodedFrames([said(encode({ _tag: "Resync" }), "topic-one")])
      assert.deepStrictEqual(
        [decoded?.deliveries, decoded?.resyncs, decoded?.observations],
        [[], ["topic-one"], []]
      )
    })
  )

  it.effect("a body that is not JSON is one Decoded, noted FrameUndecoded of feed snapshot", () =>
    Effect.gen(function* () {
      const all = yield* decodedFrames([said("not json", "nfl", "response")])
      assert.lengthOf(all, 1)
      const [observation] = all[0]?.observations ?? []
      assert.deepStrictEqual(
        [
          observation?._tag,
          observation?._tag === "FrameUndecoded" && [observation.feed, observation.channel, observation.kind]
        ],
        ["FrameUndecoded", ["snapshot", "nfl", "response"]]
      )
      assert.deepStrictEqual(all[0]?.deliveries, [])
    })
  )

  it.effect("N frames give N Decoded, with each frame's seq and receive time", () =>
    Effect.gen(function* () {
      const all = yield* decodedFrames([said("bad"), said(encode({ _tag: "Resync" })), said("worse")])
      assert.deepStrictEqual(
        all.map(({ seq, at }) => [seq, at.epochMilliseconds]),
        [1, 2, 3].map((seq) => [seq, received.epochMilliseconds])
      )
    })
  )
})

describe("TestSnapshotFeed.provider", () => {
  it.effect("a poll's frame is a Listing of the games of that league, on its channel", () =>
    Effect.gen(function* () {
      const nfl = [liveSnapshot()]
      const provider = yield* Provider
      const frame = yield* provider.poll("nfl")
      assert.deepStrictEqual([frame.feed, frame.kind, frame.channel], ["snapshot", "response", "nfl"])
      assert.deepStrictEqual(
        yield* Schema.decodeEffect(TestSnapshotFeed.SnapshotPayload)(frame.body),
        Delivery.cases.Listing.make({ league: "nfl", games: nfl })
      )
    }).pipe(
      Effect.provide(
        TestSnapshotFeed.provider({
          games: (league) => Effect.succeed(league === "nfl" ? [liveSnapshot()] : [snapshot()]),
          polling: Schedule.spaced("10 seconds")
        })
      )
    )
  )

  it.effect("`games` that fails fails the poll with its ProviderError", () =>
    Effect.gen(function* () {
      const error = new ProviderError({ reason: "Refused", league: "fbs", cause: "no" })
      const exit = yield* Effect.exit(Provider.use((provider) => provider.poll("fbs"))).pipe(
        Effect.provide(
          TestSnapshotFeed.provider({
            games: () => Effect.fail(error),
            polling: Schedule.spaced("10 seconds")
          })
        )
      )
      assert.deepStrictEqual(exit, Exit.fail(error))
    })
  )

  it.effect("its polling is the given Schedule", () => {
    const polling = Schedule.spaced("3 seconds")
    return Effect.gen(function* () {
      assert.strictEqual((yield* Provider).polling, polling)
    }).pipe(Effect.provide(TestSnapshotFeed.provider({ games: () => Effect.succeed([]), polling })))
  })
})

function said(body: string, channel = "event", kind: FeedFrame["kind"] = "message"): FeedFrame {
  return { receivedAt: received, feed: "snapshot", channel, kind, body }
}
