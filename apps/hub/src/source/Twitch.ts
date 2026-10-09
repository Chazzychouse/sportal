import { Network } from "@sportal/domain/Game"
import { DateTime } from "effect"
import { ChannelId, Guide } from "./Guide.ts"

/**
 * Twitch's channels the Hub plays, each with the network whose every broadcast it carries. A lineup is never read,
 * so its reading time is the epoch; it lists no airings, so the guide's reach never applies to it.
 */
export const lineup = new Guide({
  source: "Twitch",
  readAt: DateTime.makeUnsafe(0),
  channels: [
    {
      id: ChannelId.make("primevideo"),
      name: "Prime Video",
      live: {
        _tag: "WebView",
        url: "https://player.twitch.tv/?channel=primevideo&parent=twitch.tv&player=popout"
      },
      network: Network.make("Prime Video")
    }
  ],
  airings: []
})
