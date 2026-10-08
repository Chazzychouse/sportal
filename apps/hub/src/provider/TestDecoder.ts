import type { LeagueId } from "@sportal/domain/League"
import { Context, Effect, Layer, Stream } from "effect"
import { type Frame, LoggedFrame } from "../Frame.ts"
import { Delivery } from "../slate/Delivery.ts"
import { type Decoded, Decoder } from "./Decoder.ts"
import { Provider } from "./Provider.ts"

/** The games one poll of `league` lists, as the provided `Decoder` reads it. */
export const listedBy = Effect.fn("TestDecoder.listedBy")(function* (league: LeagueId) {
  const provider = yield* Provider
  const polled = yield* provider.poll(league)
  const said = yield* decodedFrames([polled])

  return said.flatMap((one) =>
    one.deliveries.flatMap((delivery) => (Delivery.guards.Listing(delivery) ? delivery.games : []))
  )
})

/** What the provided `Decoder` says each of `frames` said, numbered from 1. */
export const decodedFrames = Effect.fn("TestDecoder.decodedFrames")(function* (frames: ReadonlyArray<Frame>) {
  const decoder = yield* Decoder
  const numbered = frames.map((frame, index) => new LoggedFrame({ ...frame, seq: index + 1 }))

  return yield* decoder.decode(Stream.fromIterable(numbered)).pipe(Stream.runCollect)
})

/** What the provided `Decoder` says each of some frames said, numbered from 1. */
export class FramesDecoded extends Context.Service<FramesDecoded, ReadonlyArray<Decoded>>()(
  "sportal/hub/provider/FramesDecoded"
) {
  /** Decodes the frames `frames` gives once, for every test the layer is provided to: a recording takes seconds. */
  static layerOf<E>(frames: Effect.Effect<ReadonlyArray<Frame>, E>) {
    return Layer.effect(
      FramesDecoded,
      Effect.gen(function* () {
        const made = yield* frames

        return yield* decodedFrames(made)
      })
    )
  }
}
