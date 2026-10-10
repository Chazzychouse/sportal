import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect, Option, Queue, Schema } from "effect"
import { Atom } from "effect/reactivity"
import { vi } from "vitest"
import * as AutopilotState from "../autopilot/AutopilotState.ts"
import { AutopilotInput } from "../autopilot/AutopilotState.ts"
import * as PromptsState from "../prompts/PromptsState.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import * as TestWeb from "../TestWeb.ts"
import * as RemoteLink from "./RemoteLink.ts"
import { RemoteReport } from "./RemoteReport.ts"

describe("RemoteLink", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should report once its input stream opens", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)
        const source = yield* inputStream

        source.onopen?.()
        return yield* nextReport(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(decodeReport(call.report).screen.layout, "Quad")
    })
  )

  it.effect("should not report before its input stream opens", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell()

      const size = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)
        yield* inputStream
        yield* Effect.yieldNow
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
        const source = yield* inputStream
        source.onopen?.()
        yield* nextReport(calls)

        yield* Atom.set(DisplayScreen.screen, { _tag: "SetLayout", layout: "Single" })
        return yield* nextReport(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(decodeReport(call.report).screen.layout, "Single")
    })
  )

  it.effect("should report again after its input stream reopens", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)
        const source = yield* inputStream
        source.onopen?.()
        yield* nextReport(calls)

        source.onerror?.()
        source.onopen?.()
        return yield* nextReport(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(decodeReport(call.report).screen.layout, "Quad")
    })
  )

  it.effect("should not report while its input stream is closed", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell()

      const size = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)
        const source = yield* inputStream
        source.onopen?.()
        yield* nextReport(calls)
        source.onerror?.()
        yield* Effect.yieldNow

        yield* Atom.set(DisplayScreen.screen, { _tag: "SetLayout", layout: "Single" })
        yield* Effect.yieldNow
        return yield* Queue.size(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(size, 0)
    })
  )

  it.effect("should apply a Commanded input to the Screen as yours", () =>
    Effect.gen(function* () {
      yield* TestWeb.keep(TestWeb.withTiles(["live", "soon"]))
      const { registry } = yield* TestWeb.withShell()

      const pilot = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)
        yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())
        const source = yield* inputStream

        source.onmessage?.({
          data: JSON.stringify({ _tag: "Commanded", command: { _tag: "Promote", tile: 1 } })
        })
        return yield* TestWeb.until(AutopilotState.autopilot, (pilot) => Option.isSome(pilot.suspended.main))
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isTrue(Option.isSome(pilot.suspended.main))
    })
  )

  it.effect("should route a Pressed input as a hotkey", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const prompts = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)
        const source = yield* inputStream

        source.onmessage?.({ data: JSON.stringify({ _tag: "Pressed", hotkey: { _tag: "TogglePrompts" } }) })
        return yield* TestWeb.until(PromptsState.prompts, (prompts) => !prompts.on)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isFalse(prompts.on)
    })
  )

  it.effect("should change nothing for an input that does not decode", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const [before, after] = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteLink.link)
        const before = yield* Atom.get(DisplayScreen.screen)
        const source = yield* inputStream

        source.onmessage?.({ data: JSON.stringify({ _tag: "Shouted" }) })
        yield* Effect.yieldNow
        const after = yield* Atom.get(DisplayScreen.screen)
        return [before, after] as const
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(after, before)
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

/** The input stream the link opened, at this Display's id. */
const inputStream = Effect.gen(function* () {
  const id = yield* Atom.get(RemoteLink.displayId)
  return yield* TestWeb.openedAt(`/api/displays/${id}/inputs`)
})

/** The next report the link sent the Hub. */
const nextReport = Effect.fnUntraced(function* (calls: Queue.Queue<TestWeb.TestWebCall>) {
  while (true) {
    const call = yield* Queue.take(calls)
    if (call._tag === "Report") return { report: call.report }
  }
})

const decodeReport = Schema.decodeUnknownSync(RemoteReport)
