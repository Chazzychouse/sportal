import { SportalApi } from "@sportal/api/SportalApi"
import type { StageCommand } from "@sportal/domain/Stage"
import { Context, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"

class HubClient extends Context.Service<HubClient, HttpApiClient.ForApi<typeof SportalApi>>()(
  "sportal/web/HubClient"
) {
  static readonly layer = Layer.effect(HubClient, HttpApiClient.make(SportalApi)).pipe(
    Layer.provide(FetchHttpClient.layer)
  )
}

const runtime = ManagedRuntime.make(HubClient.layer)

/** Sends a stage command. The resulting stage arrives on the live stream, not from this call. */
export function dispatch(command: StageCommand): void {
  runtime.runFork(HubClient.use((hub) => hub.stage.dispatch({ payload: { command } })))
}
