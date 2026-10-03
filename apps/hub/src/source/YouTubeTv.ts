import { Layer, Option } from "effect"
import { Source } from "./Source.ts"

/** `channels` maps a broadcast network name, as the provider reports it, to that channel's YouTube TV address. */
export const layer = (channels: Readonly<Record<string, string>>) =>
  Layer.succeed(
    Source,
    Source.of({
      locate: (game) => {
        const url = game.broadcasts.map((network) => channels[network]).find((found) => found !== undefined)
        return url === undefined ? Option.none() : Option.some({ _tag: "WebView", url })
      }
    })
  )
