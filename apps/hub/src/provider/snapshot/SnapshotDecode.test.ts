import { assert, layer } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId } from "@sportal/domain/Game"
import { liveSnapshot, play, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Schedule, Schema, Stream } from "effect"
import { type FeedFrame, Frame } from "../../Frame.ts"
import { Decoder } from "../Decoder.ts"
import { Provider } from "../Provider.ts"
import * as SnapshotDecode from "./SnapshotDecode.ts"
import { SnapshotPayload } from "./SnapshotPayload.ts"
import * as SnapshotProvider from "./SnapshotProvider.ts"

const received = DateTime.makeUnsafe("2026-10-06T18:00:00Z")
const encode = Schema.encodeSync(SnapshotPayload)

layer(SnapshotDecode.layer)("SnapshotDecode", (it) => {
  it.effect("a poll of the snapshot provider decodes to the listing it answered", () =>
    Effect.gen(function* () {
      const games = [snapshot(), liveSnapshot()]
      const frame = yield* Provider.use((provider) => provider.poll("fbs")).pipe(
        Effect.provide(
          SnapshotProvider.layer({
            games: () => Effect.succeed(games),
            polling: Schedule.spaced("10 seconds")
          })
        )
      )
      const [decoded] = yield* decoded_([frame])
      assert.deepStrictEqual(decoded?.deliveries, [Delivery.cases.Listing.make({ league: "fbs", games })])
      assert.deepStrictEqual([decoded?.resyncs, decoded?.notices], [[], []])
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
      const [decoded] = yield* decoded_([said(encode(delivery))])
      assert.deepStrictEqual(decoded?.deliveries, [delivery])
    })
  )

  it.effect("a Resync resyncs the frame's channel", () =>
    Effect.gen(function* () {
      const [decoded] = yield* decoded_([said(encode({ _tag: "Resync" }), "topic-one")])
      assert.deepStrictEqual(
        [decoded?.deliveries, decoded?.resyncs, decoded?.notices],
        [[], ["topic-one"], []]
      )
    })
  )

  it.effect("a body that is not JSON is one Decoded, noted FrameUndecoded of feed snapshot", () =>
    Effect.gen(function* () {
      const all = yield* decoded_([said("not json", "nfl", "response")])
      assert.lengthOf(all, 1)
      const [notice] = all[0]?.notices ?? []
      assert.deepStrictEqual(
        [notice?._tag, notice?._tag === "FrameUndecoded" && [notice.feed, notice.channel, notice.kind]],
        ["FrameUndecoded", ["snapshot", "nfl", "response"]]
      )
      assert.deepStrictEqual(all[0]?.deliveries, [])
    })
  )

  it.effect("N frames give N Decoded, with each frame's seq and receive time", () =>
    Effect.gen(function* () {
      const all = yield* decoded_([said("bad"), said(encode({ _tag: "Resync" })), said("worse")])
      assert.deepStrictEqual(
        all.map(({ seq, at }) => [seq, at.epochMilliseconds]),
        [1, 2, 3].map((seq) => [seq, received.epochMilliseconds])
      )
    })
  )
})

function said(body: string, channel = "event", kind: FeedFrame["kind"] = "message"): FeedFrame {
  return { receivedAt: received, feed: "snapshot", channel, kind, body }
}

function decoded_(frames: ReadonlyArray<FeedFrame>) {
  return Decoder.use((decoder) =>
    decoder
      .decode(Stream.fromIterable(frames.map((frame, index) => new Frame({ ...frame, seq: index + 1 }))))
      .pipe(Stream.runCollect)
  )
}
