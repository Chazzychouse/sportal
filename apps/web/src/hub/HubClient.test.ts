import { assert, describe, it } from "@effect/vitest"
import { DisplayId } from "@sportal/api/DisplayId"
import { Effect, Layer, Queue } from "effect"
import * as TestWeb from "../TestWeb.ts"
import { HubClient } from "./HubClient.ts"

describe("HubClient", () => {
  it.effect("should send a Display's report to the Hub over the socket", () =>
    Effect.gen(function* () {
      const hub = yield* TestWeb.liveHub()

      const request = yield* Effect.gen(function* () {
        const client = yield* HubClient

        yield* client.report(desk, { screen: 1 })
        return yield* Queue.take(hub.requests)
      }).pipe(Effect.scoped, Effect.provide(HubClient.layer.pipe(Layer.provide(hub.layer))))

      assert.deepStrictEqual(request, { _tag: "Report", id: desk, report: { screen: 1 } })
    })
  )

  it.effect("should pass a guide to the Hub over the socket", () =>
    Effect.gen(function* () {
      const hub = yield* TestWeb.liveHub()

      const request = yield* Effect.gen(function* () {
        const client = yield* HubClient

        yield* client.sendGuide("<guide/>")
        return yield* Queue.take(hub.requests)
      }).pipe(Effect.scoped, Effect.provide(HubClient.layer.pipe(Layer.provide(hub.layer))))

      assert.deepStrictEqual(request, { _tag: "SendGuide", guide: "<guide/>" })
    })
  )
})

const desk = DisplayId.make("desk")
