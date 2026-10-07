import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Layer, Runtime } from "effect"
import { FetchHttpClient } from "effect/http"
import { HubConfig } from "./HubConfig.ts"
import * as HubMode from "./HubMode.ts"
import { isStopping } from "./HubStopping.ts"
import * as HubServer from "./hub-server/HubServer.ts"
import { LiveStage } from "./LiveStage.ts"
import * as Telemetry from "./Telemetry.ts"

const Hub = HubServer.serve.pipe(
  Layer.provide(HubServer.listen),
  Layer.provide(LiveStage.layer),
  Layer.provide(HubMode.layer),
  Layer.provide(Telemetry.layer),
  Layer.provide([HubConfig.layer, FetchHttpClient.layer]),
  Layer.provide(NodeServices.layer)
)

Layer.launch(Hub).pipe(
  NodeRuntime.runMain({
    // The Hub runs until a signal stops it, so stopping is a clean exit.
    teardown: (exit, onExit) => (isStopping(exit) ? onExit(0) : Runtime.defaultTeardown(exit, onExit))
  })
)
