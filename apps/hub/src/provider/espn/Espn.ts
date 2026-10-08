import { type FileSystem, Layer, type Path } from "effect"
import type { HttpClient } from "effect/http"
import type * as Socket from "effect/socket/Socket"
import type { HubConfig } from "../../HubConfig.ts"
import type { Scenarios, ScenarioUnknown, ScenarioUnreadable } from "../../scenario/Scenarios.ts"
import type { Archiver } from "../Archiver.ts"
import type { Provider } from "../Provider.ts"
import * as EspnArchiver from "./EspnArchiver.ts"
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

/**
 * The corpus's ESPN: the provider, for its decode, and its archiver of finished games. The corpus never runs the
 * provider's frames, so nothing is polled and no socket opens.
 */
export const layerArchival: Layer.Layer<
  Provider | Archiver,
  never,
  HttpClient.HttpClient | Socket.WebSocketConstructor | HubConfig | FileSystem.FileSystem | Path.Path
> = Layer.merge(layer, EspnArchiver.layer)
