import type { LeagueId } from "@sportal/domain/League"
import { Data, type Option } from "effect"
import type { Topic } from "./Topic.ts"

/** One thing ESPN delivered, as received, before its decode reads it. */
export type Frame = Data.TaggedEnum<{
  /** A poll's response: `league`'s whole site scoreboard. */
  Polled: { readonly league: LeagueId; readonly body: string }
  /** A socket text: a change to its topic's document, or any other op; no topic or mid when the text names none. */
  Pushed: {
    readonly topic: Option.Option<Topic>
    readonly mid: Option.Option<number>
    readonly body: string
  }
  /** The checkpoint an `H` pointed to: `topic`'s whole document as of `mid`. */
  Checkpoint: { readonly topic: Topic; readonly mid: number; readonly body: string }
}>
export const Frame = Data.taggedEnum<Frame>()
