import { Context, type Stream } from "effect"
import type { Frame } from "../Frame.ts"
import type { Decoded } from "./Provider.ts"

/**
 * A provider's decode on its own: what each frame it delivered said. Its adapter provides it as a layer of its own, and
 * `HubMode` pairs it with its provider, so a recorded scenario decodes its frames as the provider that recorded them
 * would.
 */
export class Decoder extends Context.Service<
  Decoder,
  {
    /**
     * What each frame said, exactly one `Decoded` per frame, in order: a poll response is a `Listing`, a pushed game a
     * `Snapshot`, a plays document change a `Plays`. A live feed topic whose document had to be dropped (a missed
     * message, a patch that will not apply) is a resync of its channel, so the live feed can ask for its checkpoint
     * again. Anything decode noticed, a frame that does not decode among it, is a notice. A frame that said nothing is
     * a `Decoded` with three empty arrays. Never fails, logs, or counts.
     */
    decode(frames: Stream.Stream<Frame>): Stream.Stream<Decoded>
  }
>()("sportal/hub/Decoder") {}
