import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import type { ShellBridge } from "@sportal/api/ShellBridge"
import { Effect, Layer, Queue, Stream } from "effect"
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

  it.effect("should still send a guide after the send before it died", () =>
    Effect.gen(function* () {
      const sent = yield* Queue.unbounded<string>()
      const registry = TestWeb.registryOf(
        Layer.merge(
          Shell.layerTest({ guideRead: Stream.make("<first/>", "<second/>"), record: () => Effect.void }),
          HubClient.layerTest({
            sendGuide: (guide) =>
              guide === "<first/>"
                ? Effect.die("The Hub's answer did not decode")
                : Effect.asVoid(Queue.offer(sent, guide))
          })
        )
      )

      const second = yield* Effect.gen(function* () {
        yield* Atom.mount(GuideRelay.relay)
        return yield* Queue.take(sent)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(second, "<second/>")
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
      const log = yield* Queue.unbounded<"Listen" | "ReadGuide">()
      const bridge: ShellBridge = {
        syncTiles: () => {},
        setHidden: () => {},
        setFullScreen: () => {},
        onFullScreenChanged: () => () => {},
        onHotkey: () => () => {},
        onTilePressed: () => () => {},
        openSignIn: () => {},
        onGuideRead: () => {
          Queue.offerUnsafe(log, "Listen")
          return () => {}
        },
        readGuide: () => {
          Queue.offerUnsafe(log, "ReadGuide")
        }
      }
      const registry = TestWeb.registryOf(Layer.merge(Shell.layerBridge(bridge), HubClient.layerTest()))

      const firstTwo = yield* Effect.gen(function* () {
        yield* Atom.mount(LiveStream.live)
        const source = yield* TestWeb.opened
        source.onopen?.()
        yield* TestWeb.until(LiveStream.live, (live) =>
          LiveStream.Connection.$is("Connected")(live.connection)
        )
        yield* Atom.mount(GuideRelay.relay)
        return yield* Queue.takeN(log, 2)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(firstTwo, ["Listen", "ReadGuide"])
    })
  )
})
