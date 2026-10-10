import { Schema } from "effect"

/** The sources Sportal can play video from, by the name people know them by. */
export const SourceName = Schema.Literals(["YouTube TV", "Twitch"])
export type SourceName = typeof SourceName.Type

/** What a Display must load to play a stream: for now, always a web view's address. */
export const StreamLocator = Schema.TaggedUnion({ WebView: { url: Schema.String } })
export type StreamLocator = typeof StreamLocator.Type

/** A channel as a source names it ("News 3", "ESPN2"), and the address that plays it live. */
export const Channel = Schema.Struct({ name: Schema.String, source: SourceName, locator: StreamLocator })
export type Channel = typeof Channel.Type

/**
 * Whether and where a source can show one game: carried, upcoming (its airing is still to come, or past what
 * the guide lists), not carried with why, or no guide (the source has no fresh guide to say).
 */
export const ChannelAvailability = Schema.TaggedUnion({
  Carried: { channel: Channel },
  Upcoming: {
    channel: Schema.OptionFromOptionalKey(Schema.String),
    begin: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString)
  },
  NoGuide: { source: SourceName },
  NotCarried: { why: Schema.Literals(["NoStream", "StreamingOnly", "NotInGuide"]) }
})
export type ChannelAvailability = typeof ChannelAvailability.Type
