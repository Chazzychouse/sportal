import { NodeHttpServer } from "@effect/platform-node"
import { type LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { HubConfig } from "./HubConfig.ts"
import * as HubServer from "./HubServer.ts"
import type { Delivery } from "./provider/Provider.ts"
import { GuideReader } from "./source/GuideReader.ts"
import { Source } from "./source/Source.ts"
import * as TestDirector from "./TestDirector.ts"

/** A client of the Hub's API, pointed at the server under test. */
export const makeClient = HttpApiClient.make(SportalApi)

/** The Hub's routes served on an ephemeral port, with an HTTP client pointed at them; YouTube TV unless `source`. */
export function serverUnderTest(source: Layer.Layer<Source, never, GuideReader> = Source.layerYouTubeTv) {
  return HubServer.layer.pipe(
    Layer.provideMerge(hubUnderTest(source)),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )
}

/** Everything behind the API, over a provider the test feeds, against `source`. */
function hubUnderTest(source: Layer.Layer<Source, never, GuideReader>) {
  return TestDirector.directorOver.pipe(
    Layer.provideMerge(source),
    Layer.provideMerge(GuideReader.layerYouTubeTv),
    Layer.provideMerge(HubConfig.layerTest({ SPORTAL_VERSION: "1.2.3" }))
  )
}

/** Opens the live stream: its response, and a queue of its lines that are not blank, as they arrive. */
export const liveLines = Effect.fn("TestHubServer.liveLines")(function* () {
  const http = yield* HttpClient.HttpClient
  const lines = yield* Queue.unbounded<string>()

  const response = yield* http.get("/api/live")
  yield* response.stream.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line !== ""),
    Stream.runForEach((line) => Queue.offer(lines, line)),
    Effect.forkScoped
  )

  return { response, lines }
})

/** Opens the live stream and takes its first message, the current slate: the lines after it. */
export const pastInitialMessages = Effect.fn("TestHubServer.pastInitialMessages")(function* () {
  const { lines } = yield* liveLines()

  yield* Queue.take(lines)

  return lines
})

/** The live message a `data: <json>` line carries. */
export function messageOf(line: string): LiveMessage {
  return Schema.decodeSync(LiveMessageJson)(line.slice("data: ".length))
}

/** The live message first sent after `deliveries`, with no connection open before them. */
export const publishedAfter = Effect.fnUntraced(function* (deliveries: ReadonlyArray<Delivery>) {
  yield* Effect.forEach(deliveries, TestDirector.delivered, { discard: true })
  yield* TestClock.adjust("250 millis")
  const { lines } = yield* liveLines()
  const line = yield* Queue.take(lines)
  return messageOf(line)
})
