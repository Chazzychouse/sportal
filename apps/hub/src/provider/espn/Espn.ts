import { Layer } from "effect"
import type { HttpClient } from "effect/http"
import type * as Socket from "effect/socket/Socket"
import type { Provider } from "../Provider.ts"
import { EspnLeague } from "./EspnLeague.ts"
import * as EspnProvider from "./EspnProvider.ts"
import { FastCast } from "./FastCast.ts"

/** ESPN live: the provider, polling every followed league's scoreboard and pushing through FastCast, read by ESPN's decode. */
export const layer: Layer.Layer<Provider, never, HttpClient.HttpClient | Socket.WebSocketConstructor> =
  EspnProvider.layer(EspnLeague.followed).pipe(Layer.provide(FastCast.layer))
