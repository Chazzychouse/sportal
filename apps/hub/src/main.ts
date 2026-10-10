import { NodeRuntime, NodeServices, NodeSocket } from "@effect/platform-node"
import { Layer, Runtime } from "effect"
import { FetchHttpClient } from "effect/http"
import { Broadcast } from "./Broadcast.ts"
import { Director } from "./Director.ts"
import { Displays } from "./Displays.ts"
import { HubConfig } from "./HubConfig.ts"
import * as HubServer from "./HubServer.ts"
import * as Espn from "./provider/espn/Espn.ts"
import { isStopping } from "./Shutdown.ts"
import { Source } from "./source/Source.ts"
import * as Telemetry from "./Telemetry.ts"

const Hub = HubServer.layer.pipe(
  Layer.provide(HubServer.layerListen),
  Layer.provide(Displays.layer),
  Layer.provide(Broadcast.layer),
  Layer.provide(Director.layer),
  Layer.provide(Espn.layer),
  Layer.provide(Source.layerAll([Source.layerYouTubeTv, Source.layerTwitch])),
  Layer.provide(Telemetry.layer),
  Layer.provide([HubConfig.layer, FetchHttpClient.layer, NodeSocket.layerWebSocketConstructorWS]),
  Layer.provide(NodeServices.layer)
)

Layer.launch(Hub).pipe(
  NodeRuntime.runMain({
    teardown: (exit, onExit) => (isStopping(exit) ? onExit(0) : Runtime.defaultTeardown(exit, onExit))
  })
)
