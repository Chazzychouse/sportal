import { NodeSocket } from "@effect/platform-node"
import { Layer } from "effect"
import { Director } from "./Director.ts"
import * as Espn from "./provider/espn/Espn.ts"
import * as YouTubeTv from "./source/youtube-tv/YouTubeTv.ts"

/** What the Hub plays: the live day, the Director taking what ESPN decodes, against YouTube TV. */
export const layer = Director.layer.pipe(
  Layer.provide(Espn.layer.pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS))),
  Layer.provideMerge(YouTubeTv.layer)
)
