import { type LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import { Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Ingest } from "../ingest/Ingest.ts"
import { StageSessions } from "../stage/StageSessions.ts"

/** The handlers for every endpoint group in SportalApi. Exported so tests can drive them without a socket. */
export const ApiHandlers = Layer.mergeAll(slateHandlers(), stageHandlers())

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

/** GET /api/live — the current slate and stage, then every change, as server-sent events. */
function liveRoute() {
  return HttpRouter.add(
    "GET",
    "/api/live",
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const sessions = yield* StageSessions
      const messages: Stream.Stream<LiveMessage> = Stream.merge(
        ingest.changes.pipe(Stream.map((slate) => ({ _tag: "SlateChanged" as const, slate }))),
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
