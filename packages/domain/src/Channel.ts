import { Data, type DateTime, type Option, Schema } from "effect"
import { StreamLocator } from "./Stream.ts"

/** The sources Sportal can play video from, by the name people know them by. */
export const SourceName = Schema.Literal("YouTube TV")
export type SourceName = typeof SourceName.Type

/** A channel as a source names it ("News 3", "ESPN2"), and the address that plays it live. */
export const Channel = Schema.Struct({ name: Schema.String, source: SourceName, locator: StreamLocator })
export type Channel = typeof Channel.Type

/**
 * Whether and where a source can show one game: carried, upcoming (its airing is still to come, or past what
 * the guide lists), not carried with why, or no guide (the source has no fresh guide to say).
 */
export type ChannelAvailability = Data.TaggedEnum<{
  Carried: { readonly channel: Channel }
  Upcoming: { readonly channel: Option.Option<string>; readonly begin: Option.Option<DateTime.Utc> }
  NoGuide: { readonly source: SourceName }
  NotCarried: { readonly why: "NoStream" | "StreamingOnly" | "NotInGuide" }
}>
export const ChannelAvailability = Data.taggedEnum<ChannelAvailability>()
