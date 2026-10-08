import { Layer } from "effect"
import type { HttpClient } from "effect/http"
import type * as Socket from "effect/socket/Socket"
import type { HubConfig } from "../../HubConfig.ts"
import type { Scenarios, ScenarioUnknown, ScenarioUnreadable } from "../../scenario/Scenarios.ts"
import type { Provider } from "../Provider.ts"
import * as EspnProvider from "./EspnProvider.ts"
import { FastCast } from "./FastCast.ts"
import * as ScenarioProvider from "./ScenarioProvider.ts"

/** ESPN live: the provider, polling its scoreboards and pushing through FastCast, read by ESPN's decode. */
export const layer: Layer.Layer<
  Provider,
  never,
  HttpClient.HttpClient | Socket.WebSocketConstructor | HubConfig
> = EspnProvider.layer.pipe(Layer.provide(FastCast.layer))

/** A scenario's ESPN frames replayed as the provider, read by ESPN's decode. */
export const layerScenario: Layer.Layer<
  Provider,
  ScenarioUnknown | ScenarioUnreadable,
  HubConfig | Scenarios
> = ScenarioProvider.layer
