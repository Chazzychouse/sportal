import { Data, type Option, type Schema } from "effect"
import type * as FastCastMessage from "./FastCastMessage.ts"
import type { Topic } from "./Topic.ts"

/** One thing FastCast delivered, as received, before its decode reads it. */
export type Frame = Data.TaggedEnum<{
  /**
   * A socket text, read once as its envelope: a change to its topic's document, or any other op. No envelope when the
   * text is not JSON with an op; no topic or mid unless it frames as a known op naming them.
   */
  Pushed: {
    readonly topic: Option.Option<Topic>
    readonly mid: Option.Option<number>
    readonly envelope: Option.Option<FastCastMessage.Envelope>
  }
  /** The checkpoint an `H` pointed to, decoded: `topic`'s whole document as of `mid`. */
  Checkpoint: { readonly topic: Topic; readonly mid: number; readonly document: Schema.Json }
}>
export const Frame = Data.taggedEnum<Frame>()
