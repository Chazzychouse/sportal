import { networkInterfaces } from "node:os"
import { type LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import { Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
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
  return HttpApiBuilder.group(SportalApi, "host", (handlers) =>
    Effect.succeed(
      handlers.handleAll({ addresses: () => Effect.sync(() => lanAddresses(networkInterfaces())) })
    )
  )
}

/** GET /api/live — the current slate with its watchability and the stage, then every change, as server-sent events. */
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
      return HttpServerResponse.stream(
        messages.pipe(
          Stream.map((message) => `data: ${encode(message)}\n\n`),
          Stream.encodeText
        ),
        { contentType: "text/event-stream", headers: { "cache-control": "no-cache" } }
      )
    })
  )
}
