import { DateTime } from "effect"
import { type Airing, ChannelId, Guide } from "./Guide.ts"

/** A YouTube TV guide read at `readAt` with one live channel, `live-1`, showing `airings`. */
export function onLiveChannel(readAt: DateTime.Utc, airings: ReadonlyArray<Airing>): Guide {
  return new Guide({
    source: "YouTube TV",
    readAt,
    channels: [
      {
        id: ChannelId.make("live-1"),
        name: "Live 1",
        live: { _tag: "WebView", url: "https://tv.youtube.com/watch/live1" }
      }
    ],
    airings
  })
}

/** An airing of `title` on `channel` from `begin` to `end`, given as ISO instants. */
export function airing(channel: ChannelId, title: string, begin: string, end: string): Airing {
  return { channel, title, begin: DateTime.makeUnsafe(begin), end: DateTime.makeUnsafe(end) }
}
