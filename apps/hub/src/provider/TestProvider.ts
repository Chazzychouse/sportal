import type { LeagueId } from "@sportal/domain/League"
import { Context, Effect, Layer, Option, Stream } from "effect"
import { type Frame, LoggedFrame } from "../Frame.ts"
import { Delivery } from "../slate/Delivery.ts"
import { type Decoded, Provider } from "./Provider.ts"

/** The games the provided `Provider`'s first frame polled from `league` lists, as its own decode reads it. */
export const listedBy = Effect.fn("TestProvider.listedBy")(function* (league: LeagueId) {
  const provider = yield* Provider
  const polled = yield* provider.frames.pipe(
    Stream.filter((frame) => frame.source === "poll" && frame.channel === league),
    Stream.runHead
  )
  const said = yield* decodedFrames(Option.toArray(polled))

  return said.flatMap((one) =>
    one.deliveries.flatMap((delivery) => (Delivery.guards.Listing(delivery) ? delivery.games : []))
  )
})

/** What the provided `Provider`'s decode says each of `frames` said, numbered from 1. */
export const decodedFrames = Effect.fn("TestProvider.decodedFrames")(function* (
  frames: ReadonlyArray<Frame>
) {
  const provider = yield* Provider
  const numbered = frames.map((frame, index) => new LoggedFrame({ ...frame, seq: index + 1 }))

  return yield* provider.decode(Stream.fromIterable(numbered)).pipe(Stream.runCollect)
})

/** What the provided `Provider`'s decode says each of some frames said, numbered from 1. */
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
