import { assert, describe, it, layer } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { liveSnapshot, play, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Exit, Schedule, Schema } from "effect"
import type { FeedFrame } from "./Frame.ts"
import { DecodeObservation } from "./provider/Decoder.ts"
import { Provider, ProviderUnavailable } from "./provider/Provider.ts"
import { decodedFrames } from "./provider/TestDecoder.ts"
import * as TestSnapshotFeed from "./TestSnapshotFeed.ts"

layer(TestSnapshotFeed.layerDecoder)("TestSnapshotFeed.layerDecoder", (it) => {
  it.effect("should decode a poll of the snapshot provider to the listing it answered", () =>
    Effect.gen(function* () {
      const games = [snapshot(), liveSnapshot()]
      const frame = yield* Provider.use((provider) => provider.poll("fbs")).pipe(
        Effect.provide(providerListing(() => games))
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
  ])("should round-trip a $name through a frame", ({ delivery }) =>
    Effect.gen(function* () {
      const frame = said(encode(delivery))

      const [decoded] = yield* decodedFrames([frame])

      assert.deepStrictEqual(decoded?.deliveries, [delivery])
    })
  )

  it.effect("should resync the frame's channel on a Resync", () =>
    Effect.gen(function* () {
      const frame = said(encode({ _tag: "Resync" }), "topic-one")

      const [decoded] = yield* decodedFrames([frame])

      assert.deepStrictEqual(
        [decoded?.deliveries, decoded?.resyncs, decoded?.observations],
        [[], ["topic-one"], []]
      )
    })
  )

  it.effect("should give a body that is not JSON one Decoded, noted FrameUndecoded of feed snapshot", () =>
    Effect.gen(function* () {
      const frame = said("not json", "nfl", "response")

      const all = yield* decodedFrames([frame])

      assert.lengthOf(all, 1)
      const [observation] = all[0]?.observations ?? []
      assert.deepStrictEqual(
        [
          observation?._tag,
          observation !== undefined &&
            DecodeObservation.$is("FrameUndecoded")(observation) && [
              observation.feed,
              observation.channel,
              observation.kind
            ]
        ],
        ["FrameUndecoded", ["snapshot", "nfl", "response"]]
      )
      assert.deepStrictEqual(all[0]?.deliveries, [])
    })
  )

  it.effect("should give one Decoded per frame, with each frame's seq and receive time", () =>
    Effect.gen(function* () {
      const frames = [said("bad"), said(encode({ _tag: "Resync" })), said("worse")]

      const all = yield* decodedFrames(frames)

      assert.deepStrictEqual(
        all.map(({ seq, at }) => [seq, at.epochMilliseconds]),
        [1, 2, 3].map((seq) => [seq, received.epochMilliseconds])
      )
    })
  )
})

describe("TestSnapshotFeed.layer", () => {
  it.effect("should give a poll's frame as a Listing of the games of that league, on its channel", () =>
    Effect.gen(function* () {
      const nfl = [liveSnapshot()]
      const provider = yield* Provider

      const frame = yield* provider.poll("nfl")

      const payload = yield* Schema.decodeEffect(TestSnapshotFeed.SnapshotPayload)(frame.body)
      assert.deepStrictEqual([frame.feed, frame.kind, frame.channel], ["snapshot", "response", "nfl"])
      assert.deepStrictEqual(payload, Delivery.cases.Listing.make({ league: "nfl", games: nfl }))
    }).pipe(Effect.provide(providerListing((league) => (league === "nfl" ? [liveSnapshot()] : [snapshot()]))))
  )

  it.effect("should fail the poll with the ProviderUnavailable `games` fails with", () =>
    Effect.gen(function* () {
      const error = new ProviderUnavailable({ reason: "Refused", league: "fbs", cause: "no" })
      const failing = TestSnapshotFeed.layer({ games: () => Effect.fail(error) })

      const exit = yield* Effect.exit(Provider.use((provider) => provider.poll("fbs"))).pipe(
        Effect.provide(failing)
      )

      assert.deepStrictEqual(exit, Exit.fail(error))
    })
  )

  it.effect("should poll on the given Schedule", () => {
    const polling = Schedule.spaced("3 seconds")

    return Effect.gen(function* () {
      const provider = yield* Provider

      assert.strictEqual(provider.polling, polling)
    }).pipe(Effect.provide(TestSnapshotFeed.layer({ games: () => Effect.succeed([]), polling })))
  })
})

const received = DateTime.makeUnsafe("2026-10-06T18:00:00Z")
const encode = Schema.encodeSync(TestSnapshotFeed.SnapshotPayload)

function said(body: string, channel = "event", kind: FeedFrame["kind"] = "message"): FeedFrame {
  return { receivedAt: received, feed: "snapshot", channel, kind, body }
}

/** The snapshot provider listing `games` of each league. */
function providerListing(games: (league: LeagueId) => ReadonlyArray<GameSnapshot>) {
  return TestSnapshotFeed.layer({ games: (league) => Effect.succeed(games(league)) })
}
