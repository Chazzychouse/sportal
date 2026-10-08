import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import type { Frame } from "../../Frame.ts"
import { Scenarios } from "../../scenario/Scenarios.ts"
import type { Delivery } from "../../slate/Delivery.ts"
import * as EspnDecoder from "./EspnDecoder.ts"

/** A WebSocket constructor for tests that never push: opening a socket throws. */
export const noSocket = Layer.succeed(Socket.WebSocketConstructor, () => {
  throw new Error("this test opens no socket")
})

/**
 * This adapter's fixtures folder, where NE at BUF's frames on 2026-10-04 are kept as the recorded scenario
 * `neAtBufFrames`: imported from the recording, its game topic's frames and every scoreboard poll of the day, trimmed
 * to it.
 */
export const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const neAtBufFrames = "nfl-2026-10-04-ne-buf"

/**
 * Every play id NE at BUF's recorded frames add, the same plays its summary's drives list. Measured once over the
 * fixture: every play id its topic's patches add, whole or one at a time (none is removed, moved, or copied), counted
 * with
 *   zcat nfl-2026-10-04-ne-buf.frames.jsonl.gz | jq -r 'select(.kind=="change") | .body | fromjson
 *     | select(.op=="P" or .op=="R") | .pl | fromjson | .pl | fromjson | .[]
 *     | select(.path|test("^/entities/plays(/[^/]+)?$"))
 *     | if .path=="/entities/plays" then (.value|keys[]) else (.path|ltrimstr("/entities/plays/")) end' | sort -u | wc -l
 */
export const recordedPlays = 182

/** NE at BUF's recorded frames, read back as the recorded scenario `neAtBufFrames`. */
export const recordedNeAtBuf = Scenarios.use((scenarios) => scenarios.load(neAtBufFrames)).pipe(
  Effect.flatMap(({ frames }) => Stream.runCollect(frames)),
  Effect.provide(Scenarios.layerFrom(fixtures).pipe(Layer.provideMerge(NodeServices.layer)))
)

/** What ESPN's decode says each of `frames` said. */
export const decodedFrames = Effect.fn("TestEspn.decodedFrames")(function* (frames: ReadonlyArray<Frame>) {
  return yield* EspnDecoder.decode(Stream.fromIterable(frames)).pipe(Stream.runCollect)
})

/** What ESPN's decode says each of some frames said. */
export class FramesDecoded extends Context.Service<FramesDecoded, ReadonlyArray<ReadonlyArray<Delivery>>>()(
  "sportal/hub/provider/espn/FramesDecoded"
) {
  /** Decodes the frames `frames` gives once, for every test the layer is provided to: a recording takes seconds. */
  static layerOf<E>(frames: Effect.Effect<ReadonlyArray<Frame>, E>) {
    return Layer.effect(FramesDecoded, Effect.flatMap(frames, decodedFrames))
  }
}
