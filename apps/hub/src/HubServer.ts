import { createServer } from "node:http"
import { networkInterfaces } from "node:os"
import { NodeHttpServer, type NodeServices } from "@effect/platform-node"
import type { DisplayMessage } from "@sportal/api/DisplayMessage"
import { HubApi } from "@sportal/api/HubApi"
import { SportalApi } from "@sportal/api/SportalApi"
import {
  DateTime,
  Effect,
  type FileSystem,
  Layer,
  Option,
  type Path,
  type PlatformError,
  type Schema,
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
import { HttpApiBuilder } from "effect/http-api"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { Displays } from "./Displays.ts"
import { HubConfig } from "./HubConfig.ts"
import { Schedule } from "./Schedule.ts"
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

const gamesHandlers = HttpApiBuilder.group(
  SportalApi,
  "games",
  Effect.fn(function* (handlers) {
    const schedule = yield* Schedule
    return handlers.handleAll({
      list: ({ query }) => schedule.list(query),
      game: ({ params }) => schedule.game(params.id),
      plays: ({ params, query }) => schedule.plays(params.id, query)
    })
  })
)

const displaysHandlers = HttpApiBuilder.group(
  SportalApi,
  "displays",
  Effect.fn(function* (handlers) {
    const displays = yield* Displays
    return handlers.handleAll({
      report: ({ params, payload }) => displays.report(params.id, payload),
      send: ({ params, payload }) => displays.send(params.id, payload)
    })
  })
)

const api = HttpApiBuilder.layer(SportalApi).pipe(
  Layer.provide([guideHandlers, hostHandlers, gamesHandlers, displaysHandlers])
)

const liveHandlers = HubApi.toLayer(
  Effect.gen(function* () {
    const schedule = yield* Schedule
    const displays = yield* Displays
    return HubApi.of({
      listLive: (query) => Stream.unwrap(schedule.listLive(query)),
      gameLive: ({ id }) => Stream.unwrap(schedule.gameLive(id)),
      playsLive: ({ id }) => Stream.unwrap(schedule.playsLive(id)),
      inputs: ({ display }) => Stream.unwrap(Effect.map(displays.connect(display), registered)),
      follow: ({ display }) => displays.follow(display)
    })
  })
)

/** The live queries, on the same server and port as the API: one WebSocket per page carries every one it asks. */
const live = RpcServer.layerHttp({ group: HubApi, path: "/api/socket", protocol: "websocket" }).pipe(
  Layer.provide([liveHandlers, RpcSerialization.layerJson])
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
  | Schedule
  | Displays
  | Source
  | HttpClient.HttpClient
  | HttpServer.HttpServer
  | HttpPlatform.HttpPlatform
  | Etag.Generator
  | FileSystem.FileSystem
  | Path.Path
> = HttpRouter.serve(Layer.mergeAll(api, live, web))

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

/** A Display's inputs as its input stream sends them: that the Hub has registered it, then each input. */
function registered(inputs: Stream.Stream<Schema.Json>): Stream.Stream<DisplayMessage> {
  const sent = Stream.map(inputs, (input): DisplayMessage => ({ _tag: "Sent", input }))
  return Stream.concat(Stream.succeed<DisplayMessage>({ _tag: "Registered" }), sent)
}
