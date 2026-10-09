import { createServer } from "node:http"
import { NodeHttpServer, type NodeServices } from "@effect/platform-node"
import { LiveMessage, LiveMessageJson, type SlateChanged } from "@sportal/api/LiveMessage"
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
import { Source } from "./source/Source.ts"

/**
 * The Hub's routes on the HTTP server in context: the API, the live stream, and the built web UI when there is one.
 */
export const layer: Layer.Layer<
  never,
  PlatformError.PlatformError,
  | HubConfig
  | Director
  | Source
  | GuideReader
  | HttpServer.HttpServer
  | HttpPlatform.HttpPlatform
  | Etag.Generator
  | FileSystem.FileSystem
  | Path.Path
> = Layer.unwrap(
  Effect.gen(function* () {
    const { webRoot } = yield* HubConfig
    const events = yield* liveEvents
    const api = HttpApiBuilder.layer(SportalApi).pipe(
      Layer.provide(Layer.mergeAll(guideHandlers, hostHandlers))
    )
    const web = Option.match(webRoot, {
      onNone: () => Layer.empty,
      onSome: (root) => HttpStaticServer.layer({ root, spa: true })
    })
    return HttpRouter.serve(Layer.mergeAll(api, liveRoute(events), web))
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
 * GET /api/live — the current slate, each game beside its availability, then every change to either, as server-sent
 * events, with a comment every 20 seconds so proxies that close idle connections leave a quiet stream open. Every
 * connection reads the one `events` stream.
 */
function liveRoute(events: Stream.Stream<string, Schema.SchemaError>) {
  return HttpRouter.add(
    "GET",
    "/api/live",
    Effect.sync(() => {
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
}

/**
 * The live stream's events, built once for every connection: the slate, each game beside its availability as of when
 * it is sent, first as it is, then once each burst of changes to the slate or the availability settles, unless what
 * it sends is the same; each as an SSE `data:` line. A connection joining gets the last one at once.
 */
const liveEvents = Effect.gen(function* () {
  const director = yield* Director
  const source = yield* Source
  const encode = Schema.encodeEffect(LiveMessageJson)

  return yield* settled(Stream.zipLatest(director.slate, source.availability)).pipe(
    Stream.mapEffect(([slate, availabilityOf]) =>
      Effect.map(DateTime.now, (now): SlateChanged => {
        const games = slate.games.map((game) => ({
          game: game.recent(),
          availability: availabilityOf(game.snapshot, now)
        }))
        return { _tag: "SlateChanged", games }
      })
    ),
    Stream.changesWith(samePublished),
    Stream.mapEffect((message) => Effect.map(encode(message), (json) => `data: ${json}\n\n`)),
    Stream.share({ capacity: "unbounded", replay: 1 })
  )
})

const samePublished = Schema.toEquivalence(LiveMessage.cases.SlateChanged)

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
