import { Layer } from "effect"
import type { HttpClient } from "effect/http"
import type * as Socket from "effect/socket/Socket"
import type { HubConfig } from "../../HubConfig.ts"
import type { Provider } from "../Provider.ts"
import * as EspnProvider from "./EspnProvider.ts"
import { FastCast } from "./FastCast.ts"

/** ESPN live: the provider, polling its scoreboards and pushing through FastCast, read by ESPN's decode. */
export const layer: Layer.Layer<
  Provider,
  never,
  HttpClient.HttpClient | Socket.WebSocketConstructor | HubConfig
> = EspnProvider.layer.pipe(Layer.provide(FastCast.layer))
