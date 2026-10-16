import { createServer } from "node:http"
import { networkInterfaces } from "node:os"
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
import { Displays } from "./Displays.ts"
import { HubConfig } from "./HubConfig.ts"
import { Source } from "./source/Source.ts"

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
      health: () => Effect.succeed({ version: config.version, startedAt }),
      addresses: () => Effect.sync(() => lanAddresses(networkInterfaces()))
    })
  })
)

const liveHandlers = HttpApiBuilder.group(
  SportalApi,
  "live",
  Effect.fn(function* (handlers) {
    const { messages } = yield* Broadcast
    return handlers.handleAll({
      stream: () => Effect.sync(() => sse(messages))
    })
  })
)

const displaysHandlers = HttpApiBuilder.group(
  SportalApi,
  "displays",
  Effect.fn(function* (handlers) {
    const displays = yield* Displays
    return handlers.handleAll({
      inputs: ({ params }) =>
        Effect.map(displays.connect(params.id), (inputs) => sse(inputs, { openNow: true })),
      report: ({ params, payload }) => displays.report(params.id, payload),
      follow: ({ params }) => Effect.sync(() => sse(displays.follow(params.id))),
      send: ({ params, payload }) => displays.send(params.id, payload)
    })
  })
)

const api = HttpApiBuilder.layer(SportalApi).pipe(
  Layer.provide([guideHandlers, hostHandlers, liveHandlers, displaysHandlers])
)

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
  | Displays
  | Source
  | HttpClient.HttpClient
  | HttpServer.HttpServer
  | HttpPlatform.HttpPlatform
  | Etag.Generator
  | FileSystem.FileSystem
  | Path.Path
> = HttpRouter.serve(Layer.mergeAll(api, web))

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

/**
 * The addresses a phone on the home network can reach this machine at: its external IPv4 addresses, home
 * ranges (192.168, 10, 172.16–31) first, then any other, such as a VPN's. Container and VM bridges are left
 * out, since nothing outside the machine can reach them. Takes the shape of `os.networkInterfaces()`.
 */
function lanAddresses(
  interfaces: Record<
    string,
    ReadonlyArray<{ address: string; family: string; internal: boolean }> | undefined
  >
): ReadonlyArray<string> {
  return Object.entries(interfaces)
    .filter(([name]) => !bridges.test(name))
    .flatMap(([, addresses]) => addresses ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map(({ address }) => address)
    .filter((address) => !address.startsWith("169.254."))
    .sort((a, b) => rank(a) - rank(b))
}

const bridges = /^(docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|podman)/

function rank(address: string) {
  if (address.startsWith("192.168.")) return 0
  if (address.startsWith("10.")) return 1
  return /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 2 : 3
}

/**
 * `data` as server-sent `message` events, with a keep-alive event every 20 seconds so a proxy, or the server
 * itself, notices a stream whose client is gone. The response only starts with its first event, so a stream
 * that may have no data for a while sends a keep-alive at once (`openNow`), and its client sees it open.
 */
function sse<A>(data: Stream.Stream<A>, { openNow = false }: { openNow?: boolean } = {}) {
  const keepAlive = Stream.tick("20 seconds").pipe(
    Stream.drop(openNow ? 0 : 1),
    Stream.map(() => ({ event: "keep-alive", data: "" }) as const)
  )
  const events = Stream.map(data, (each) => ({ event: "message", data: each }) as const)
  return HttpApiSchema.withHeaders({
    body: Stream.merge(events, keepAlive),
    headers: { "cache-control": "no-cache" } as const
  })
}
