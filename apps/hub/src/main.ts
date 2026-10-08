import { NodeRuntime, NodeServices, NodeSocket } from "@effect/platform-node"
import { Layer, Runtime } from "effect"
import { FetchHttpClient } from "effect/http"
import { Director } from "./Director.ts"
import { HubConfig } from "./HubConfig.ts"
import * as HubServer from "./HubServer.ts"
import { isStopping } from "./HubStopping.ts"
import * as Espn from "./provider/espn/Espn.ts"
import * as YouTubeTv from "./source/youtube-tv/YouTubeTv.ts"
import * as Telemetry from "./Telemetry.ts"

const Hub = HubServer.layer.pipe(
  Layer.provide(HubServer.layerListen),
  Layer.provide(Director.layer),
  Layer.provide(Espn.layer),
  Layer.provide(YouTubeTv.layer),
  Layer.provide(Telemetry.layer),
  Layer.provide([HubConfig.layer, FetchHttpClient.layer, NodeSocket.layerWebSocketConstructorWS]),
  Layer.provide(NodeServices.layer)
)

Layer.launch(Hub).pipe(
  NodeRuntime.runMain({
    // The Hub runs until a signal stops it, so stopping is a clean exit.
    teardown: (exit, onExit) => (isStopping(exit) ? onExit(0) : Runtime.defaultTeardown(exit, onExit))
  })
)
