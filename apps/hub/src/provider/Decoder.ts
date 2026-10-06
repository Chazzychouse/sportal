import { Context, type Stream } from "effect"
import type { Frame } from "../Frame.ts"
import type { Decoded } from "./Provider.ts"

/**
 * A provider's decode on its own: what each frame it delivered said. Its adapter provides it beside the provider, so a
 * recorded scenario decodes its frames as the provider that recorded them would, without naming that provider.
 */
export class Decoder extends Context.Service<
  Decoder,
  {
    /**
     * What each frame said, in order: a poll response is a `Listing`, a pushed game a `Snapshot`, a plays document
     * change a `Plays`, each `Delivered`. A live feed topic whose document had to be dropped (a missed message, a
     * patch that will not apply) is a `Resync` of its channel, so the live feed can ask for its checkpoint again.
     * Anything decode noticed, a frame that does not decode among it, is `Noted`. Each carries the `seq` of the frame
     * that said it. Never fails, logs, or counts.
     */
    decode(frames: Stream.Stream<Frame>): Stream.Stream<Decoded>
  }
>()("sportal/hub/Decoder") {}
