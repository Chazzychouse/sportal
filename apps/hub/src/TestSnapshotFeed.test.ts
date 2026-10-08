import { assert, describe, it, layer } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { liveSnapshot, play, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Schema, Stream } from "effect"
import type { Frame } from "./Frame.ts"
import { DecodeObservation, Provider } from "./provider/Provider.ts"
import { decodedFrames } from "./provider/TestProvider.ts"
import { Delivery } from "./slate/Delivery.ts"
import * as TestSnapshotFeed from "./TestSnapshotFeed.ts"

layer(TestSnapshotFeed.layer)("TestSnapshotFeed.decode", (it) => {
  it.effect("should decode a poll of the snapshot provider to the listing it answered", () =>
    Effect.gen(function* () {
      const games = [snapshot(), liveSnapshot()]
      const frame = TestSnapshotFeed.framed(Delivery.cases.Listing.make({ league: "fbs", games }), received)

      const [decoded] = yield* decodedFrames([frame])

      assert.deepStrictEqual(decoded?.deliveries, [Delivery.cases.Listing.make({ league: "fbs", games })])
      assert.deepStrictEqual(decoded?.observations, [])
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

  it.effect("should say nothing for a Nothing", () =>
    Effect.gen(function* () {
      const frame = said(encode({ _tag: "Nothing" }), "topic-one")

      const [decoded] = yield* decodedFrames([frame])

      assert.deepStrictEqual([decoded?.deliveries, decoded?.observations], [[], []])
    })
  )

  it.effect("should give a body that is not JSON one Decoded, noted FrameUndecoded of source push", () =>
    Effect.gen(function* () {
      const frame = said("not json", "nfl", "whole")

      const all = yield* decodedFrames([frame])

      assert.lengthOf(all, 1)
      const [observation] = all[0]?.observations ?? []
      assert.deepStrictEqual(
        [
          observation?._tag,
          observation !== undefined &&
            DecodeObservation.$is("FrameUndecoded")(observation) && [
              observation.source,
              observation.channel,
              observation.kind
            ]
        ],
        ["FrameUndecoded", ["push", "nfl", "whole"]]
      )
      assert.deepStrictEqual(all[0]?.deliveries, [])
    })
  )

  it.effect("should give one Decoded per frame, with each frame's seq and receive time", () =>
    Effect.gen(function* () {
      const frames = [said("bad"), said(encode({ _tag: "Nothing" })), said("worse")]

      const all = yield* decodedFrames(frames)

      assert.deepStrictEqual(
        all.map(({ seq, at }) => [seq, at.epochMilliseconds]),
        [1, 2, 3].map((seq) => [seq, received.epochMilliseconds])
      )
    })
  )
})

describe("TestSnapshotFeed.framed", () => {
  it.effect("should frame a Listing as its league's poll, on its channel", () =>
    Effect.gen(function* () {
      const nfl = [liveSnapshot()]

      const frame = TestSnapshotFeed.framed(
        Delivery.cases.Listing.make({ league: "nfl", games: nfl }),
        received
      )

      const payload = yield* Schema.decodeEffect(TestSnapshotFeed.SnapshotPayload)(frame.body)
      assert.deepStrictEqual([frame.source, frame.kind, frame.channel], ["poll", "whole", "nfl"])
      assert.deepStrictEqual(payload, Delivery.cases.Listing.make({ league: "nfl", games: nfl }))
    })
  )
})

describe("TestSnapshotFeed.layerFrom", () => {
  it.effect("should deliver the frames it is given, in order", () =>
    Effect.gen(function* () {
      const given = [said("first"), said("second")]

      const frames = yield* Provider.use((provider) => Stream.runCollect(provider.frames)).pipe(
        Effect.provide(TestSnapshotFeed.layerFrom(Stream.fromIterable(given)))
      )

      assert.deepStrictEqual(frames, given)
    })
  )
})

const received = DateTime.makeUnsafe("2026-10-06T18:00:00Z")
const encode = Schema.encodeSync(TestSnapshotFeed.SnapshotPayload)

function said(body: string, channel = "event", kind: Frame["kind"] = "change"): Frame {
  return { receivedAt: received, source: "push", channel, kind, body }
}
