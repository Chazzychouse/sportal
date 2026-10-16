import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { vi } from "vitest"
import * as TestWeb from "../TestWeb.ts"
import * as LiveStream from "./LiveStream.ts"

describe("LiveStream.of", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should be connecting before the stream first opens", () =>
    Effect.gen(function* () {
      yield* TestWeb.openedBy(counted)
      const state = yield* Atom.get(counted)

      assert.strictEqual(state.connection._tag, "Connecting")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should stay connecting after an error before the stream first opens", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.openedBy(counted)

      source.onerror?.()
      source.onmessage?.({ data: countMessage(1) })
      const after = yield* TestWeb.until(counted, (state) => state.value > 0)

      assert.strictEqual(after.connection._tag, "Connecting")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should publish nothing for an error while connecting or already lost", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.openedBy(counted)
      const listening = yield* Deferred.make<void>()
      const published = yield* Atom.toStream(counted).pipe(
        Stream.tap(() => Deferred.succeed(listening, undefined)),
        Stream.takeUntil((state) => state.value > 0),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Deferred.await(listening)

      source.onerror?.()
      source.onopen?.()
      source.onerror?.()
      source.onerror?.()
      source.onmessage?.({ data: countMessage(1) })
      const states = yield* Fiber.join(published)

      const connections = Array.from(states, (state) => state.connection._tag)
      assert.deepStrictEqual(connections, ["Connecting", "Connected", "Lost", "Lost"])
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should be connected once open", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.openedBy(counted)

      source.onopen?.()

      yield* TestWeb.until(counted, (state) => state.connection._tag === "Connected")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should be lost after an error once open", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.openedBy(counted)
      source.onopen?.()
      yield* TestWeb.until(counted, (state) => state.connection._tag === "Connected")

      source.onerror?.()

      yield* TestWeb.until(counted, (state) => state.connection._tag === "Lost")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should be connected again when it reopens after it was lost", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.openedBy(counted)
      source.onopen?.()
      yield* TestWeb.until(counted, (state) => state.connection._tag === "Connected")
      source.onerror?.()
      yield* TestWeb.until(counted, (state) => state.connection._tag === "Lost")

      source.onerror?.()
      source.onopen?.()

      yield* TestWeb.until(counted, (state) => state.connection._tag === "Connected")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should fold each message into its value", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.openedBy(counted)

      source.onmessage?.({ data: countMessage(2) })
      source.onmessage?.({ data: countMessage(3) })
      const state = yield* TestWeb.until(counted, (current) => current.value === 5)

      assert.strictEqual(state.value, 5)
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should skip a malformed message and keep reading", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.openedBy(counted)
      source.onopen?.()
      const before = yield* TestWeb.until(counted, (state) => state.connection._tag === "Connected")

      source.onmessage?.({ data: "{not json" })
      source.onmessage?.({ data: JSON.stringify({ count: "nope" }) })
      source.onmessage?.({ data: countMessage(1) })
      const after = yield* TestWeb.until(counted, (state) => state.value > 0)

      assert.strictEqual(after.connection, before.connection)
      assert.strictEqual(after.value, 1)
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should open its url and close it when the registry goes", () =>
    Effect.gen(function* () {
      const source = yield* Effect.scoped(Effect.provide(TestWeb.openedBy(counted), AtomRegistry.layer))

      assert.strictEqual(source.url, "/api/counts/live")
      assert.isTrue(source.closed)
    })
  )
})

/** A message of the test stream: a count to add. */
const Count = Schema.fromJsonString(Schema.Struct({ count: Schema.Finite }))

/** A live stream of counts, summed from zero; kept alive so a test's reads all see one EventSource. */
const counted = LiveStream.of("/api/counts/live", Count, 0, (sum, { count }) => sum + count).pipe(
  Atom.keepAlive
)

function countMessage(count: number) {
  return Schema.encodeSync(Count)({ count })
}
