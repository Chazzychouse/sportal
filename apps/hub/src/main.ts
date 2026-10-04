import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Exit, Layer, Runtime } from "effect"
import { FetchHttpClient } from "effect/http"
import * as Database from "./database/Database.ts"
import { HubConfig } from "./HubConfig.ts"
import * as HubMode from "./HubMode.ts"
import * as HubServer from "./http/HubServer.ts"
import { StageSessions } from "./stage/StageSessions.ts"
import * as Telemetry from "./Telemetry.ts"

const Hub = HubServer.serve.pipe(
  Layer.provide(StageSessions.layer),
  Layer.provide(HubMode.layer),
  Layer.provide(Database.inDataDir),
  Layer.provide(Telemetry.layer),
  Layer.provide([HubConfig.layer, FetchHttpClient.layer]),
  Layer.provide(NodeServices.layer)
)

Layer.launch(Hub).pipe(
  NodeRuntime.runMain({
    // The Hub runs until a signal stops it, so being interrupted is a clean stop.
    teardown: (exit, onExit) =>
      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        ? onExit(0)
        : Runtime.defaultTeardown(exit, onExit)
  })
)
