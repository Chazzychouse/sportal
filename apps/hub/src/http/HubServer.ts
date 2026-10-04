import { createServer } from "node:http"
import { networkInterfaces } from "node:os"
import { NodeHttpServer } from "@effect/platform-node"
import { type LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import { DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { HubConfig } from "../HubConfig.ts"
import { Ingest } from "../ingest/Ingest.ts"
import { Source } from "../source/Source.ts"
import { StageSessions } from "../stage/StageSessions.ts"
import { Watch } from "../watch/Watch.ts"
import { lanAddresses } from "./LanAddresses.ts"

/** The handlers for every endpoint group in SportalApi. Exported so tests can drive them without a socket. */
export const ApiHandlers = Layer.mergeAll(
  slateHandlers(),
  stageHandlers(),
  channelHandlers(),
  guideHandlers(),
  hostHandlers()
)

/** Every route the Hub serves: the API, and the live stream. */
export const layer = Layer.mergeAll(
  HttpApiBuilder.layer(SportalApi).pipe(Layer.provide(ApiHandlers)),
  liveRoute()
)

/** The Hub on its configured address: every route, and the built web UI when there is one. */
export const serve = Layer.unwrap(
  Effect.gen(function* () {
    const { webRoot, port, host } = yield* HubConfig
    const routes = Option.match(webRoot, {
      onNone: () => layer,
      onSome: (root) => Layer.mergeAll(layer, HttpStaticServer.layer({ root, spa: true }))
    })
    // Connected Displays hold live streams open. By default shutdown waits 20 seconds for them, and Docker kills at 10.
    const server = NodeHttpServer.layer(createServer, { port, host, gracefulShutdownTimeout: "3 seconds" })
    return HttpRouter.serve(routes).pipe(Layer.provide(server))
  })
)

function slateHandlers() {
  return HttpApiBuilder.group(
    SportalApi,
    "slate",
    Effect.fn(function* (handlers) {
      const ingest = yield* Ingest
      return handlers.handleAll({ current: () => ingest.slate })
    })
  )
}

function stageHandlers() {
  return HttpApiBuilder.group(
    SportalApi,
    "stage",
    Effect.fn(function* (handlers) {
      const sessions = yield* StageSessions
      return handlers.handleAll({
        current: () => sessions.stage,
        dispatch: ({ payload }) => sessions.dispatch(payload.command)
      })
    })
  )
}

function channelHandlers() {
  return HttpApiBuilder.group(
    SportalApi,
    "channels",
    Effect.fn(function* (handlers) {
      const source = yield* Source
      // A channel store that cannot be written is not something a client can fix: it is a server error.
      return handlers.handleAll({
        learn: ({ payload }) =>
          source.learn(payload.network, payload.url).pipe(Effect.catchTag("ChannelStoreError", Effect.die)),
        notCarried: ({ payload }) =>
          source.markNotCarried(payload.network).pipe(Effect.catchTag("ChannelStoreError", Effect.die)),
        forget: ({ payload }) =>
          source.forget(payload.network).pipe(Effect.catchTag("ChannelStoreError", Effect.die))
      })
    })
  )
}

function guideHandlers() {
  return HttpApiBuilder.group(
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
                Effect.logWarning(
                  `HubServer: a guide of ${payload.guide.length} characters could not be read`
                )
              )
            )
      })
    })
  )
}

function hostHandlers() {
  return HttpApiBuilder.group(
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
}

/**
 * GET /api/live — the current slate with its watchability and the stage, then every change, as server-sent events,
 * with a comment every 20 seconds so proxies that close idle connections leave a quiet stream open.
 */
function liveRoute() {
  return HttpRouter.add(
    "GET",
    "/api/live",
    Effect.gen(function* () {
      const watch = yield* Watch
      const sessions = yield* StageSessions
      const messages: Stream.Stream<LiveMessage> = Stream.merge(
        watch.changes.pipe(
          Stream.map(({ slate, watchability }) => ({ _tag: "SlateChanged" as const, slate, watchability }))
        ),
        sessions.changes.pipe(Stream.map((stage) => ({ _tag: "StageChanged" as const, stage })))
      )
      const encode = Schema.encodeSync(LiveMessageJson)
      const events = messages.pipe(Stream.map((message) => `data: ${encode(message)}\n\n`))
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
