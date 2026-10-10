import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import * as TestWeb from "../TestWeb.ts"
import * as ServerEvents from "./ServerEvents.ts"

describe("ServerEvents.from", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should open a new EventSource after the browser closes one", () =>
    Effect.gen(function* () {
      yield* ServerEvents.from("/api/live").pipe(Stream.runDrain, Effect.forkChild)
      const first = yield* TestWeb.openedAt("/api/live")
      first.onopen?.()

      closedByBrowser(first)
      yield* TestClock.adjust("5 seconds")
      const second = yield* TestWeb.openedAt("/api/live")

      assert.notStrictEqual(second, first)
    })
  )

  it.effect("should close the EventSource the browser closed", () =>
    Effect.gen(function* () {
      yield* ServerEvents.from("/api/live").pipe(Stream.runDrain, Effect.forkChild)
      const first = yield* TestWeb.openedAt("/api/live")
      first.onopen?.()

      closedByBrowser(first)
      yield* TestClock.adjust("5 seconds")
      yield* TestWeb.openedAt("/api/live")

      assert.isTrue(first.closed)
    })
  )

  it.effect("should report Errored then Opened across a reopening", () =>
    Effect.gen(function* () {
      const events = yield* ServerEvents.from("/api/live").pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild
      )
      const first = yield* TestWeb.openedAt("/api/live")
      first.onopen?.()

      closedByBrowser(first)
      yield* TestClock.adjust("5 seconds")
      const second = yield* TestWeb.reopened(first)
      second.onopen?.()
      const tags = Array.from(yield* Fiber.join(events), (event) => event._tag)

      assert.deepStrictEqual(tags, ["Opened", "Errored", "Opened"])
    })
  )

  it.effect("should wait longer before each reopening while the Hub stays away", () =>
    Effect.gen(function* () {
      yield* ServerEvents.from("/api/live").pipe(Stream.runDrain, Effect.forkChild)
      const first = yield* TestWeb.openedAt("/api/live")
      closedByBrowser(first)
      yield* TestClock.adjust("5 seconds")
      const second = yield* TestWeb.openedAt("/api/live")

      closedByBrowser(second)
      yield* TestClock.adjust("500 millis")
      yield* Effect.yieldNow

      assert.strictEqual(TestWeb.FakeEventSource.opened.length, 2)
    })
  )
})

/** Fails `source` as the browser does for a response that is not an event stream: closed, for good. */
function closedByBrowser(source: TestWeb.FakeEventSource) {
  source.readyState = TestWeb.FakeEventSource.CLOSED
  source.onerror?.()
}
