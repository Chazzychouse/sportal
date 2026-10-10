import { createServer } from "node:http"
import { NodeHttpServer, type NodeServices } from "@effect/platform-node"
import { LiveMessage, type SlateChanged } from "@sportal/api/LiveMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import {
  DateTime,
  Effect,
  type FileSystem,
  Layer,
  Option,
  type Path,
  type PlatformError,
  Record,
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
  HttpStaticServer
} from "effect/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Director } from "./Director.ts"
import { HubConfig } from "./HubConfig.ts"
import { Source } from "./source/Source.ts"

export const layer: Layer.Layer<
  never,
  PlatformError.PlatformError,
  | HubConfig
  | Director
  | Source
  | HttpServer.HttpServer
  | HttpPlatform.HttpPlatform
  | Etag.Generator
  | FileSystem.FileSystem
  | Path.Path
> = Layer.unwrap(
  Effect.gen(function* () {
    const { webRoot } = yield* HubConfig
    const api = HttpApiBuilder.layer(SportalApi).pipe(
      Layer.provide(Layer.mergeAll(guideHandlers, hostHandlers, liveHandlers))
    )
    const web = Option.match(webRoot, {
      onNone: () => Layer.empty,
      onSome: (root) => HttpStaticServer.layer({ root, spa: true })
    })
    return HttpRouter.serve(Layer.mergeAll(api, web))
  })
)

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
    const messages = yield* liveMessages
    return handlers.handleAll({
      // Every connection reads the one `messages` stream.
      stream: () =>
        Effect.sync(() => {
          // `tick` emits once at the start; only the later ticks are wanted.
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

/**
 * The live stream's messages, built once for every connection: the slate, and each game's availability as of when
 * it is sent, first as it is, then once each burst of slate changes settles and every 30 seconds, so a guide read or
 * a guide going stale shows, unless what it sends is the same. A connection joining gets the last one at once.
 */
const liveMessages = Effect.gen(function* () {
  const director = yield* Director
  const source = yield* Source

  return yield* Stream.zipLatest(settled(director.slate), Stream.tick("30 seconds")).pipe(
    Stream.mapEffect(([slate]) =>
      Effect.gen(function* () {
        const availabilityOf = yield* source.availability
        const now = yield* DateTime.now

        const availability = Record.fromEntries(
          slate.games.map(({ snapshot }) => [snapshot.id, availabilityOf(snapshot, now)] as const)
        )
        return { _tag: "SlateChanged", slate: slate.recent(), availability } satisfies SlateChanged
      })
    ),
    Stream.changesWith(samePublished),
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
