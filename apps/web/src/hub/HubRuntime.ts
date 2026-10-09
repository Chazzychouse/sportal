import { Layer, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { HubClient } from "./HubClient.ts"

/** The one runtime the web UI runs the Hub client in; React handlers run their effects here. */
export const runtime = ManagedRuntime.make(HubClient.layer.pipe(Layer.provide(FetchHttpClient.layer)))
