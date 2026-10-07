import { type FileSystem, Layer, type Path } from "effect"
import type { HttpClient } from "effect/http"
import type * as Socket from "effect/socket/Socket"
import type { HubConfig } from "../../HubConfig.ts"
import type { Scenarios, ScenarioUnknown, ScenarioUnreadable } from "../../scenario/Scenarios.ts"
import type { Archiver } from "../Archiver.ts"
import type { Decoder } from "../Decoder.ts"
import type { Provider } from "../Provider.ts"
import * as EspnArchiver from "./EspnArchiver.ts"
import * as EspnDecoder from "./EspnDecoder.ts"
import * as EspnProvider from "./EspnProvider.ts"
import { FastCast } from "./FastCast.ts"
import * as ScenarioProvider from "./ScenarioProvider.ts"

/** ESPN live: the provider, its push FastCast, and ESPN's decode. */
export const layer: Layer.Layer<
  Provider | Decoder,
  never,
  HttpClient.HttpClient | Socket.WebSocketConstructor | HubConfig
> = Layer.merge(EspnProvider.layer.pipe(Layer.provide(FastCast.layer)), EspnDecoder.layer)

/** A scenario's ESPN frames replayed as the provider, and ESPN's decode. */
export const layerScenario: Layer.Layer<
  Provider | Decoder,
  ScenarioUnknown | ScenarioUnreadable,
  HubConfig | Scenarios
> = Layer.merge(ScenarioProvider.layer, EspnDecoder.layer)

/** The corpus's ESPN: its decode, and its archiver of finished games. No provider. */
export const layerArchival: Layer.Layer<
  Decoder | Archiver,
  never,
  HttpClient.HttpClient | HubConfig | FileSystem.FileSystem | Path.Path
> = Layer.merge(EspnDecoder.layer, EspnArchiver.layer)
