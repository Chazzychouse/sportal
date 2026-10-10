import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Atom } from "effect/reactivity"
import { HubClient } from "./hub/HubClient.ts"
import { Shell } from "./shell/Shell.ts"

/** The one runtime the web UI's effects run in: the Hub client and the Shell. Tests swap `runtime.layer`. */
export const runtime = Atom.runtime(
  Layer.mergeAll(HubClient.layer, Shell.layer).pipe(Layer.provide(FetchHttpClient.layer))
)
