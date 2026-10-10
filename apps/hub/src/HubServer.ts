import { createServer } from "node:http"
import { NodeHttpServer, type NodeServices } from "@effect/platform-node"
import { SportalApi } from "@sportal/api/SportalApi"
import {
  DateTime,
  Effect,
  type FileSystem,
  Layer,
  Option,
  type Path,
  type PlatformError,
  Stream
} from "effect"
import {
  type Etag,
  type HttpClient,
  type HttpPlatform,
  HttpRouter,
  type HttpServer,
  type HttpServerError,
  HttpStaticServer
} from "effect/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Broadcast } from "./Broadcast.ts"
import { HubConfig } from "./HubConfig.ts"
import { Source } from "./source/Source.ts"
import * as TelemetryRelay from "./TelemetryRelay.ts"

const guideHandlers = HttpApiBuilder.group(
  SportalApi,
  "guide",
  Effect.fn(function* (handlers) {
    const source = yield* Source
    return handlers.handleAll({
      read: ({ payload }) =>
        source
          .readGuide(payload.guide)
          .pipe(
            Effect.tapError(() =>
              Effect.logWarning(`HubServer: a guide of ${payload.guide.length} characters could not be read`)
            )
          )
    })
  })
)

const hostHandlers = HttpApiBuilder.group(
  SportalApi,
  "host",
  Effect.fn(function* (handlers) {
    const config = yield* HubConfig
    const startedAt = yield* DateTime.now
    return handlers.handleAll({
      health: () => Effect.succeed({ version: config.version, startedAt })
    })
  })
)

const liveHandlers = HttpApiBuilder.group(
  SportalApi,
  "live",
  Effect.fn(function* (handlers) {
    const { messages } = yield* Broadcast
    return handlers.handleAll({
      stream: () =>
        Effect.sync(() => {
          const keepAlive = Stream.tick("20 seconds").pipe(
            Stream.drop(1),
            Stream.map(() => ({ event: "keep-alive", data: "" }) as const)
          )
          const events = Stream.map(messages, (data) => ({ event: "message", data }) as const)
          return HttpApiSchema.withHeaders({
            body: Stream.merge(events, keepAlive),
            headers: { "cache-control": "no-cache" } as const
          })
        })
    })
  })
)

const api = HttpApiBuilder.layer(SportalApi).pipe(Layer.provide([guideHandlers, hostHandlers, liveHandlers]))

const web = Layer.unwrap(
  Effect.gen(function* () {
    const { webRoot } = yield* HubConfig
    return Option.match(webRoot, {
      onNone: () => Layer.empty,
      onSome: (root) => HttpStaticServer.layer({ root, spa: true })
    })
  })
)

export const layer: Layer.Layer<
  never,
  PlatformError.PlatformError,
  | HubConfig
  | Broadcast
  | Source
  | HttpClient.HttpClient
  | HttpServer.HttpServer
  | HttpPlatform.HttpPlatform
  | Etag.Generator
  | FileSystem.FileSystem
  | Path.Path
> = HttpRouter.serve(Layer.mergeAll(api, web, TelemetryRelay.layer))

export const layerListen: Layer.Layer<
  HttpServer.HttpServer | HttpPlatform.HttpPlatform | Etag.Generator | NodeServices.NodeServices,
  HttpServerError.ServeError,
  HubConfig
> = Layer.unwrap(
  Effect.gen(function* () {
    const { port, host } = yield* HubConfig
    return NodeHttpServer.layer(createServer, { port, host, gracefulShutdownTimeout: "3 seconds" })
  })
)
