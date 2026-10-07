import type { Delivery } from "@sportal/domain/Delivery"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { DateTime, Effect, type Layer, Option, Schedule, Schema, Stream } from "effect"
import { type FeedFrame, Frame } from "./Frame.ts"
import { LiveGames } from "./LiveGames.ts"
import { Decoder } from "./provider/Decoder.ts"
import { Decoded, type Polling, Provider, type ProviderError } from "./provider/Provider.ts"
import { SnapshotPayload } from "./provider/snapshot/SnapshotPayload.ts"
import * as SnapshotProvider from "./provider/snapshot/SnapshotProvider.ts"

/**
 * The snapshot feed as a test's provider: a poll of a league is the games `games` answers. It pushes `options.push`'s
 * frames, none by default, and is polled every 10 seconds unless `options.polling` says otherwise. Tests read its frames
 * with `SnapshotDecode.layer`.
 */
export function polled(
  games: (league: LeagueId) => Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderError>,
  options: {
    readonly polling?: Polling
    readonly push?: Stream.Stream<FeedFrame, ProviderError>
  } = {}
): Layer.Layer<Provider> {
  return SnapshotProvider.layer({
    games,
    polling: options.polling ?? Schedule.spaced("10 seconds"),
    ...(options.push === undefined ? {} : { push: options.push })
  })
}

/** A snapshot feed frame pushed on `channel`, received at the clock's now, that says `payload`. */
export function pushed(payload: typeof SnapshotPayload.Type, channel: string) {
  return Effect.map(
    DateTime.now,
    (receivedAt): FeedFrame => ({
      receivedAt,
      feed: "snapshot",
      channel,
      kind: "message",
      body: Schema.encodeSync(SnapshotPayload)(payload)
    })
  )
}

/**
 * `delivery` taken into the fold at the test clock's now, as the only delivery of frame `seq`, or of the frame after the
 * fold's last when no `seq` is given.
 */
export function taken(delivery: Delivery, seq?: number) {
  return LiveGames.use((liveGames) =>
    Effect.gen(function* () {
      const last = Option.getOrElse((yield* liveGames.latest).seq, () => 0)
      yield* liveGames.take(delivered(delivery, yield* DateTime.now, seq ?? last + 1))
    })
  )
}

/** Frame `seq`, received at `at`, that said only `delivery`. */
export function delivered(delivery: Delivery, at: DateTime.Utc, seq: number): Decoded {
  return new Decoded({ seq, at, deliveries: [delivery], resyncs: [], notices: [] })
}

/** The games one poll of `league` lists, as the provided `Decoder` reads it. */
export function listedBy(league: LeagueId) {
  return Effect.gen(function* () {
    const said = yield* decodedFrames([yield* (yield* Provider).poll(league)])
    return said.flatMap((one) =>
      one.deliveries.flatMap((delivery) => (delivery._tag === "Listing" ? delivery.games : []))
    )
  })
}

/** What the provided `Decoder` says each of `frames` said, numbered from 1. */
export function decodedFrames(frames: ReadonlyArray<FeedFrame>) {
  return Decoder.use((decoder) =>
    decoder
      .decode(Stream.fromIterable(frames.map((frame, index) => new Frame({ ...frame, seq: index + 1 }))))
      .pipe(Stream.runCollect)
  )
}
