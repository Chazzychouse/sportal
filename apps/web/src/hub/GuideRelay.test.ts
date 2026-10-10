import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect, Layer, Queue, Ref, Stream } from "effect"
import { Atom } from "effect/reactivity"
import { vi } from "vitest"
import { Shell } from "../shell/Shell.ts"
import * as TestWeb from "../TestWeb.ts"
import * as GuideRelay from "./GuideRelay.ts"
import { HubClient } from "./HubClient.ts"
import * as LiveStream from "./LiveStream.ts"

describe("GuideRelay.relay", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should send each guide the shell reads to the Hub", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell({ guideRead: Stream.make("<guide/>") })

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(GuideRelay.relay)
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "SendGuide", guide: "<guide/>" })
    })
  )

  it.effect("should ask the shell to read the guide when the live stream connects", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell()

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(GuideRelay.relay)
        const source = yield* TestWeb.opened
        source.onopen?.()
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "ReadGuide" })
    })
  )

  it.effect("should not ask again for a message while the live stream stays connected", () =>
    Effect.gen(function* () {
      const guides = yield* Queue.unbounded<string>()
      const { registry, calls } = yield* TestWeb.withShell({ guideRead: Stream.fromQueue(guides) })

      const second = yield* Effect.gen(function* () {
        yield* Atom.mount(GuideRelay.relay)
        const source = yield* TestWeb.opened
        source.onopen?.()
        yield* Queue.take(calls)
        source.onmessage?.({ data: TestWeb.slateMessage([]) })
        yield* TestWeb.until(LiveStream.live, (live) => live.slate.games.length === 0)
        yield* Queue.offer(guides, "<later/>")
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(second, { _tag: "SendGuide", guide: "<later/>" })
    })
  )

  it.effect("should listen for guides before it first asks for one", () =>
    Effect.gen(function* () {
      const listening = yield* Ref.make(false)
      const asked = yield* Queue.unbounded<boolean>()
      const shell = Shell.layerTest({
        guideRead: Stream.unwrap(Effect.as(Ref.set(listening, true), Stream.never)),
        record: (call) =>
          call._tag === "ReadGuide"
            ? Ref.get(listening).pipe(
                Effect.flatMap((on) => Queue.offer(asked, on)),
                Effect.asVoid
              )
            : Effect.void
      })
      const registry = TestWeb.registryOf(
        Layer.merge(
          shell,
          HubClient.layerTest(() => Effect.void)
        )
      )

      const listeningWhenAsked = yield* Effect.gen(function* () {
        yield* Atom.mount(GuideRelay.relay)
        const source = yield* TestWeb.opened
        source.onopen?.()
        return yield* Queue.take(asked)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.isTrue(listeningWhenAsked)
    })
  )
})
