import { createServer } from "node:http"
import { NodeHttpServer, type NodeServices } from "@effect/platform-node"
import { LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import {
  DateTime,
  Effect,
  type FileSystem,
  Layer,
  Option,
  type Path,
  type PlatformError,
  Schema,
  Sink,
  Stream
} from "effect"
import {
  type Etag,
  type HttpPlatform,
  HttpRouter,
  type HttpServer,
  type HttpServerError,
  HttpServerResponse,
  HttpStaticServer
} from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Director } from "./Director.ts"
import { HubConfig } from "./HubConfig.ts"
import { GuideReader } from "./source/GuideReader.ts"

/**
 * The Hub's routes on the HTTP server in context: the API, the live stream, and the built web UI when there is one.
 */
export const layer: Layer.Layer<
  never,
  PlatformError.PlatformError,
  | HubConfig
  | Director
  | GuideReader
  | HttpServer.HttpServer
  | HttpPlatform.HttpPlatform
  | Etag.Generator
  | FileSystem.FileSystem
  | Path.Path
> = Layer.unwrap(
  Effect.gen(function* () {
    const { webRoot } = yield* HubConfig
    const api = HttpApiBuilder.layer(SportalApi).pipe(
      Layer.provide(Layer.mergeAll(screenHandlers, guideHandlers, hostHandlers))
    )
    const web = Option.match(webRoot, {
      onNone: () => Layer.empty,
      onSome: (root) => HttpStaticServer.layer({ root, spa: true })
    })
    return HttpRouter.serve(Layer.mergeAll(api, liveRoute, web))
  })
)

/** An HTTP server on the configured address, for `layer` to put the Hub's routes on. */
export const layerListen: Layer.Layer<
  HttpServer.HttpServer | HttpPlatform.HttpPlatform | Etag.Generator | NodeServices.NodeServices,
  HttpServerError.ServeError,
  HubConfig
> = Layer.unwrap(
  Effect.gen(function* () {
    const { port, host } = yield* HubConfig
    // Connected Displays hold live streams open. By default shutdown waits 20 seconds for them, and Docker kills at 10.
    return NodeHttpServer.layer(createServer, { port, host, gracefulShutdownTimeout: "3 seconds" })
  })
)

const screenHandlers = HttpApiBuilder.group(
  SportalApi,
  "screen",
  Effect.fn(function* (handlers) {
    const director = yield* Director
    return handlers.handleAll({
      current: () => director.screen,
      dispatch: ({ payload }) => director.dispatch(payload.command)
    })
  })
)

const guideHandlers = HttpApiBuilder.group(
  SportalApi,
  "guide",
  Effect.fn(function* (handlers) {
    const reader = yield* GuideReader
    return handlers.handleAll({
      read: ({ payload }) =>
        reader
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

/**
 * GET /api/live — the current slate, each game beside its availability, and the screen, then every change, as
 * server-sent events, with a comment every 20 seconds so proxies that close idle connections leave a quiet stream open.
 */
const liveRoute = HttpRouter.add(
  "GET",
  "/api/live",
  Effect.gen(function* () {
    const director = yield* Director
    const screenChanges = director.screenChanges.pipe(
      Stream.map((next) => LiveMessage.cases.ScreenChanged.make({ screen: next }))
    )
    const slateChanges = director.published.pipe(settled)
    const messages: Stream.Stream<LiveMessage> = Stream.merge(slateChanges, screenChanges)
    const encode = Schema.encodeEffect(LiveMessageJson)
    const events = messages.pipe(
      Stream.mapEffect((message) => Effect.map(encode(message), (json) => `data: ${json}\n\n`))
    )
    // `tick` emits once at the start; only the later ticks are wanted.
    const keepAlive = Stream.tick("20 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ": keep-alive\n\n")
    )
    return HttpServerResponse.stream(Stream.merge(events, keepAlive).pipe(Stream.encodeText), {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" }
    })
  })
)

/**
 * The slate as it is, then each burst of changes once it settles 250 ms after the last, so changes arriving more often
 * than that, without a pause, send nothing until they pause.
 */
function settled<A>(changes: Stream.Stream<A>): Stream.Stream<A> {
  return Stream.unwrap(
    Effect.map(Stream.peel(changes, Sink.head()), ([current, rest]) =>
      Stream.concat(Stream.fromIterable(Option.toArray(current)), rest.pipe(Stream.debounce("250 millis")))
    )
  )
}
