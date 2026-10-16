import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { DisplayId } from "@sportal/api/DisplayId"
import { DisplayOffline } from "@sportal/api/DisplayOffline"
import type { RemoteMessage } from "@sportal/api/RemoteMessage"
import { GameId } from "@sportal/domain/Game"
import { Deferred, Effect, Layer, PubSub, Queue, Schema, Stream, SubscriptionRef } from "effect"
import { Atom } from "effect/reactivity"
import { vi } from "vitest"
import { DisplayInput } from "../display/Display.ts"
import { HubClient } from "../hub/HubClient.ts"
import { Shell } from "../shell/Shell.ts"
import * as TestWeb from "../TestWeb.ts"
import { RemoteReport } from "./RemoteReport.ts"
import * as RemoteState from "./RemoteState.ts"

const desk = DisplayId.make("desk")

describe("RemoteState", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should follow the Display from reported to offline and back", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const seen = yield* Effect.gen(function* () {
        const tags = yield* collected(RemoteState.followed(desk), (each) => each._tag)

        yield* TestWeb.answer(hub, "follow desk", hub.follows, reported(reportOf()))
        yield* PubSub.publish(hub.follows, { _tag: "Offline" })
        yield* PubSub.publish(hub.follows, reported(reportOf()))
        return yield* takeN(tags, 4)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(seen, ["Connecting", "Reported", "Offline", "Reported"])
    })
  )

  it.effect("should read a report that does not decode as offline", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const followed = yield* Effect.gen(function* () {
        yield* Atom.get(RemoteState.followed(desk))

        yield* TestWeb.answer(hub, "follow desk", hub.follows, {
          _tag: "Reported",
          report: { screen: "nonsense" }
        })
        return yield* TestWeb.until(RemoteState.followed(desk), (each) => each._tag === "Offline")
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(followed._tag, "Offline")
    })
  )

  it.effect("should be connecting again while the socket is lost", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const followed = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteState.followed(desk))
        yield* TestWeb.answer(hub, "follow desk", hub.follows, reported(reportOf()))
        yield* TestWeb.until(RemoteState.followed(desk), (each) => each._tag === "Reported")

        yield* SubscriptionRef.set(hub.connection, TestWeb.lost)
        return yield* TestWeb.until(RemoteState.followed(desk), (each) => each._tag === "Connecting")
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(followed._tag, "Connecting")
    })
  )

  it.effect("should send a tapped game to the selected tile as Commanded Assign", () =>
    Effect.gen(function* () {
      const { registry, calls, hub } = yield* TestWeb.withShell()

      const sent = yield* Effect.gen(function* () {
        yield* Atom.get(RemoteState.followed(desk))
        yield* TestWeb.answer(hub, "follow desk", hub.follows, reported(reportOf()))
        yield* TestWeb.until(RemoteState.followed(desk), (each) => each._tag === "Reported")

        yield* Atom.set(RemoteState.display(desk), DisplayInput.Chosen({ game: GameId.make("live") }))
        return yield* Queue.take(calls).pipe(Effect.repeat({ until: (call) => call._tag === "Send" }))
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(sent._tag === "Send" ? sent.input : undefined, {
        _tag: "Commanded",
        command: { _tag: "Assign", tile: 0, game: "live" }
      })
    })
  )

  it.effect("should count an input the Hub refuses as the Display offline", () =>
    Effect.gen(function* () {
      const registry = yield* registryWith({ send: () => Effect.fail(new DisplayOffline()) })

      const count = yield* Effect.gen(function* () {
        yield* Atom.set(RemoteState.send(desk), toggle)

        return yield* TestWeb.until(RemoteState.offline, (count) => count > 0)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(count, 1)
    })
  )

  it.effect("should finish a send with nothing mounted", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const done = yield* Queue.unbounded<Schema.Json>()
      const registry = yield* registryWith({ send: (_, input) => heldUntil(gate, done, input) })

      const finished = yield* Effect.gen(function* () {
        yield* Atom.set(RemoteState.send(desk), toggle)
        yield* TestWeb.afterTasks

        yield* Deferred.succeed(gate, undefined)
        return yield* Queue.take(done)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(finished, toggle)
    })
  )

  it.effect("should finish a send when another follows it", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const done = yield* Queue.unbounded<Schema.Json>()
      const registry = yield* registryWith({ send: (_, input) => heldUntil(gate, done, input) })

      const finished = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteState.send(desk))
        yield* Atom.set(RemoteState.send(desk), toggle)
        yield* Atom.set(RemoteState.send(desk), toggle)
        yield* TestWeb.afterTasks

        yield* Deferred.succeed(gate, undefined)
        return yield* takeN(done, 2)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(finished.length, 2)
    })
  )
})

const toggle = { _tag: "Pressed", hotkey: { _tag: "NextLayout" } } as const

/** A registry whose Hub client is `fakes`. */
const registryWith = Effect.fnUntraced(function* (fakes: Parameters<typeof HubClient.layerTest>[0]) {
  const hub = yield* TestWeb.liveHub()

  return TestWeb.registryOf(
    Layer.mergeAll(Shell.layerTest({ record: () => Effect.void }), HubClient.layerTest(fakes), hub.layer)
  )
})

/** A send held until `gate` opens, then recorded in `done`. */
function heldUntil(gate: Deferred.Deferred<void>, done: Queue.Queue<Schema.Json>, input: Schema.Json) {
  return Deferred.await(gate).pipe(Effect.andThen(Queue.offer(done, input)), Effect.asVoid)
}

function reportOf() {
  return new RemoteReport({ screen: TestWeb.withTiles([]) })
}

/** A Reported message, as the Hub sends it. */
function reported(report: RemoteReport): RemoteMessage {
  return { _tag: "Reported", report: Schema.encodeSync(RemoteReport)(report) }
}

/** Each value of `atom`, mapped by `f`, in a queue, collected while the scope lives. */
const collected = Effect.fnUntraced(function* <A, B>(atom: Atom.Atom<A>, f: (value: A) => B) {
  const queue = yield* Queue.unbounded<B>()

  yield* Atom.toStream(atom).pipe(
    Stream.runForEach((value) => Queue.offer(queue, f(value))),
    Effect.forkScoped
  )
  return queue
})

function takeN<A>(queue: Queue.Queue<A>, n: number) {
  return Effect.replicateEffect(Queue.take(queue), n)
}
