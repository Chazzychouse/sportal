import { type ChannelCarriage, ChannelLineup } from "@sportal/domain/Source"
import { Effect, Layer } from "effect"
import { Source } from "./Source.ts"

/** YouTube TV as a source that knows a fixed list of carriages. */
export const layer = (carriages: ReadonlyArray<ChannelCarriage>) =>
  Layer.succeed(
    Source,
    Source.of({ lineup: Effect.succeed(new ChannelLineup({ source: "YouTube TV", guide, carriages })) })
  )

const guide = { _tag: "WebView", url: "https://tv.youtube.com/live" } as const
