import type { LeagueId } from "@sportal/domain/League"
import { Data, type Option, type Schema } from "effect"
import type { Topic } from "./Topic.ts"

/** One thing ESPN delivered, as received, before its decode reads it. */
export type Frame = Data.TaggedEnum<{
  /** A poll's response: `league`'s whole site scoreboard. */
  Polled: { readonly league: LeagueId; readonly body: string }
  /** A poll that brought nothing: it did not connect, or was refused. */
  PollFailed: { readonly league: LeagueId }
  /** A socket text: a change to its topic's document, or any other op; no topic or mid when the text names none. */
  Pushed: {
    readonly topic: Option.Option<Topic>
    readonly mid: Option.Option<number>
    readonly body: string
  }
  /** The checkpoint an `H` pointed to, decoded: `topic`'s whole document as of `mid`. */
  Checkpoint: { readonly topic: Topic; readonly mid: number; readonly document: Schema.Json }
}>
export const Frame = Data.taggedEnum<Frame>()
