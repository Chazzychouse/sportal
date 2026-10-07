import type { LeagueId } from "@sportal/domain/League"
import { Context, Effect, Layer, Stream } from "effect"
import { type FeedFrame, Frame } from "../Frame.ts"
import * as TestSnapshotFeed from "../TestSnapshotFeed.ts"
import { Decoder } from "./Decoder.ts"
import { type Decoded, Provider } from "./Provider.ts"

/** The snapshot feed's decode, which dies at a frame whose body is `body`. */
export function dyingAt(body: string): Layer.Layer<Decoder> {
  return Layer.effect(
    Decoder,
    Effect.map(Decoder, (decoder) =>
      Decoder.of({
        decode: (frames) =>
          decoder.decode(
            frames.pipe(
              Stream.tap((frame) => (frame.body === body ? Effect.die("decode died") : Effect.void))
            )
          )
      })
    )
  ).pipe(Layer.provide(TestSnapshotFeed.decoder))
}

/** The games one poll of `league` lists, as the provided `Decoder` reads it. */
export function listedBy(league: LeagueId) {
  return Effect.gen(function* () {
    const provider = yield* Provider
    const polled = yield* provider.poll(league)
    const said = yield* decodedFrames([polled])
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

/** What the provided `Decoder` says each of some frames said, numbered from 1. */
export class FramesDecoded extends Context.Service<FramesDecoded, ReadonlyArray<Decoded>>()(
  "test/FramesDecoded"
) {
  /** Decodes the frames `frames` gives once, for every test the layer is provided to: a recording takes seconds. */
  static layer<E>(frames: Effect.Effect<ReadonlyArray<FeedFrame>, E>) {
    return Layer.effect(
      FramesDecoded,
      Effect.gen(function* () {
        const made = yield* frames

        return yield* decodedFrames(made)
      })
    )
  }
}
