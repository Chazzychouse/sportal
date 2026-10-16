import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect, Queue, Schema, SubscriptionRef } from "effect"
import { Atom } from "effect/reactivity"
import { vi } from "vitest"
import * as DisplayState from "../display/DisplayState.ts"
import { Connection } from "../hub/HubSocket.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import * as TestWeb from "../TestWeb.ts"
import * as RemoteLink from "./RemoteLink.ts"
import { RemoteReport } from "./RemoteReport.ts"

describe("RemoteLink", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should report once the Hub has registered it", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)

        return yield* nextReport(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(decodeReport(call.report).screen.layout, "Quad")
    })
  )

  it.effect("should not report before the socket connects", () =>
    Effect.gen(function* () {
      const { registry, calls, hub } = yield* TestWeb.withShell()
      yield* SubscriptionRef.set(hub.connection, Connection.Connecting())

      const size = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)
        yield* TestWeb.afterTasks
        return yield* Queue.size(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(size, 0)
    })
  )

  it.effect("should report again when the Screen changes", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)
        yield* nextReport(calls)

        yield* Atom.set(DisplayScreen.screen, { _tag: "SetLayout", layout: "Single" })
        return yield* nextReport(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(decodeReport(call.report).screen.layout, "Single")
    })
  )

  it.effect("should report again once the Hub registers it after the socket was lost", () =>
    Effect.gen(function* () {
      const { registry, calls, hub } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)
        const query = yield* inputsQuery
        yield* nextReport(calls)
        yield* SubscriptionRef.set(hub.connection, TestWeb.lost)
        yield* TestWeb.dropped(hub, query)

        yield* SubscriptionRef.set(hub.connection, Connection.Connected())
        return yield* nextReport(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(decodeReport(call.report).screen.layout, "Quad")
    })
  )

  it.effect("should not report while the socket is lost", () =>
    Effect.gen(function* () {
      const { registry, calls, hub } = yield* TestWeb.withShell()

      const size = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)
        const query = yield* inputsQuery
        yield* nextReport(calls)
        yield* SubscriptionRef.set(hub.connection, TestWeb.lost)
        yield* TestWeb.dropped(hub, query)

        yield* Atom.set(DisplayScreen.screen, { _tag: "SetLayout", layout: "Single" })
        yield* TestWeb.afterTasks
        return yield* Queue.size(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(size, 0)
    })
  )

  it.effect("should apply a Commanded input to the Screen", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.withTiles(["live", "soon"]))
      const { registry, hub } = yield* TestWeb.withShell()

      const screen = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)
        const query = yield* inputsQuery

        yield* TestWeb.answer(hub, query, hub.inputs, {
          _tag: "Commanded",
          command: { _tag: "SetLayout", layout: "Single" }
        })
        return yield* TestWeb.until(DisplayScreen.screen, (screen) => screen.layout === "Single")
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(screen.layout, "Single")
    })
  )

  it.effect("should route a Pressed input as a hotkey", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const display = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)
        const query = yield* inputsQuery

        yield* TestWeb.answer(hub, query, hub.inputs, { _tag: "Pressed", hotkey: { _tag: "ShowKeys" } })
        return yield* TestWeb.until(DisplayState.display, (display) => display.shows("Keys"))
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isTrue(display.shows("Keys"))
    })
  )

  it.effect("should drop an input that does not decode and apply the next one", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const [before, after, display] = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)
        const before = yield* Atom.get(DisplayScreen.screen)
        const query = yield* inputsQuery

        yield* TestWeb.answer(hub, query, hub.inputs, { _tag: "Shouted" })
        yield* Effect.yieldNow
        const after = yield* Atom.get(DisplayScreen.screen)
        yield* TestWeb.answer(hub, query, hub.inputs, { _tag: "Pressed", hotkey: { _tag: "ShowKeys" } })
        const display = yield* TestWeb.until(DisplayState.display, (display) => display.shows("Keys"))
        return [before, after, display] as const
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(after, before)
      assert.isTrue(display.shows("Keys"))
    })
  )

  it.effect("should make a Display id outside a secure context, where crypto has no randomUUID", () =>
    Effect.gen(function* () {
      vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(171) })
      const { registry } = yield* TestWeb.withShell()

      const id = yield* Atom.get(RemoteLink.displayId).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(id, "ab".repeat(16))
    })
  )

  it.effect("should keep the same Display id across reads", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const [first, second] = yield* Effect.gen(function* () {
        const first = yield* Atom.get(RemoteLink.displayId)
        const second = yield* Atom.get(RemoteLink.displayId)
        return [first, second] as const
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(second, first)
      assert.strictEqual(localStorage.getItem("sportal/display-id"), JSON.stringify(first))
    })
  )
})

/** The name of this Display's input query on the fake Hub. */
const inputsQuery = Effect.map(Atom.get(RemoteLink.displayId), (id) => `inputs ${id}`)

/** The next report the link sent the Hub. */
const nextReport = Effect.fnUntraced(function* (calls: Queue.Queue<TestWeb.TestWebCall>) {
  while (true) {
    const call = yield* Queue.take(calls)
    if (call._tag === "Report") return { report: call.report }
  }
})

const decodeReport = Schema.decodeUnknownSync(RemoteReport)
