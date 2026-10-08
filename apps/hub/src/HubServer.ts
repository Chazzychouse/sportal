import { createServer } from "node:http"
import { networkInterfaces } from "node:os"
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
import { HubConfig } from "./HubConfig.ts"
import { LiveStage } from "./LiveStage.ts"
import { Board } from "./slate/Board.ts"
import { Source } from "./source/Source.ts"

/**
 * The Hub's routes on the HTTP server in context: the API, the live stream, and the built web UI when there is one.
 */
export const layer: Layer.Layer<
  never,
  PlatformError.PlatformError,
  | HubConfig
  | Board
  | LiveStage
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
      Layer.provide(Layer.mergeAll(stageHandlers, guideHandlers, hostHandlers))
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

const stageHandlers = HttpApiBuilder.group(
  SportalApi,
  "stage",
  Effect.fn(function* (handlers) {
    const stage = yield* LiveStage
    return handlers.handleAll({
      current: () => stage.stage,
      dispatch: ({ payload }) => stage.dispatch(payload.command)
    })
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
      addresses: () => Effect.sync(() => lanAddresses(networkInterfaces())),
      health: () => Effect.succeed({ version: config.version, startedAt })
    })
  })
)

/**
 * GET /api/live — the current slate and the stage, then every change, as server-sent events,
 * with a comment every 20 seconds so proxies that close idle connections leave a quiet stream open.
 */
const liveRoute = HttpRouter.add(
  "GET",
  "/api/live",
  Effect.gen(function* () {
    const board = yield* Board
    const stage = yield* LiveStage
    const stageChanges = stage.changes.pipe(
      Stream.map((next) => LiveMessage.cases.StageChanged.make({ stage: next }))
    )
    const slateChanges = board.changes.pipe(
      settled,
      Stream.map((slate) => slate.published())
    )
    const messages: Stream.Stream<LiveMessage> = Stream.merge(slateChanges, stageChanges)
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
