import { assert, describe, it } from "@effect/vitest"
import type { ShellBridge } from "@sportal/api/ShellBridge"
import { Effect, Layer, Queue, Stream, SubscriptionRef } from "effect"
import { Atom } from "effect/reactivity"
import { Shell } from "../shell/Shell.ts"
import * as TestWeb from "../TestWeb.ts"
import * as GuideRelay from "./GuideRelay.ts"
import { HubClient } from "./HubClient.ts"
import { Connection } from "./HubSocket.ts"

describe("GuideRelay.relay", () => {
  it.effect("should send each guide the shell reads to the Hub", () =>
    Effect.gen(function* () {
      const { registry, calls, hub } = yield* TestWeb.withShell({ guideRead: Stream.make("<guide/>") })
      yield* SubscriptionRef.set(hub.connection, Connection.Connecting())

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
      const hub = yield* TestWeb.liveHub()
      const registry = TestWeb.registryOf(
        Layer.mergeAll(
          Shell.layerTest({ guideRead: Stream.make("<first/>", "<second/>"), record: () => Effect.void }),
          HubClient.layerTest({
            sendGuide: (guide) =>
              guide === "<first/>"
                ? Effect.die("The Hub's answer did not decode")
                : Effect.asVoid(Queue.offer(sent, guide))
          }),
          hub.layer
        )
      )

      const second = yield* Effect.gen(function* () {
        yield* Atom.mount(GuideRelay.relay)
        return yield* Queue.take(sent)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(second, "<second/>")
    })
  )

  it.effect("should ask the shell to read the guide when the socket connects", () =>
    Effect.gen(function* () {
      const { registry, calls, hub } = yield* TestWeb.withShell()
      yield* SubscriptionRef.set(hub.connection, Connection.Connecting())

      const call = yield* Effect.gen(function* () {
        yield* Atom.mount(GuideRelay.relay)

        yield* SubscriptionRef.set(hub.connection, Connection.Connected())
        return yield* Queue.take(calls)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(call, { _tag: "ReadGuide" })
    })
  )

  it.effect("should not ask again for a message while the socket stays connected", () =>
    Effect.gen(function* () {
      const guides = yield* Queue.unbounded<string>()
      const { registry, calls, hub } = yield* TestWeb.withShell({ guideRead: Stream.fromQueue(guides) })

      const second = yield* Effect.gen(function* () {
        yield* Atom.mount(GuideRelay.relay)
        yield* Queue.take(calls)
        yield* SubscriptionRef.set(hub.connection, Connection.Connected())
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
        },
        setGuideOpen: () => {}
      }
      const hub = yield* TestWeb.liveHub()
      const registry = TestWeb.registryOf(
        Layer.mergeAll(Shell.layerBridge(bridge), HubClient.layerTest(), hub.layer)
      )

      const firstTwo = yield* Effect.gen(function* () {
        yield* Atom.mount(GuideRelay.relay)
        return yield* Queue.takeN(log, 2)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(firstTwo, ["Listen", "ReadGuide"])
    })
  )
})
