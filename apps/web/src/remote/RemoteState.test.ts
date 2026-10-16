import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { DisplayId } from "@sportal/api/DisplayId"
import { DisplayOffline } from "@sportal/api/DisplayOffline"
import { RemoteMessageJson } from "@sportal/api/RemoteMessage"
import { GameId } from "@sportal/domain/Game"
import { Deferred, Effect, Layer, Queue, Schema, Stream } from "effect"
import { Atom } from "effect/reactivity"
import { vi } from "vitest"
import { DisplayInput } from "../display/Display.ts"
import { HubClient } from "../hub/HubClient.ts"
import { Shell } from "../shell/Shell.ts"
import { StripCard } from "../slate/StripCard.ts"
import * as TestWeb from "../TestWeb.ts"
import { RemoteReport } from "./RemoteReport.ts"
import * as RemoteState from "./RemoteState.ts"

const desk = DisplayId.make("desk")

describe("RemoteState", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should follow the Display from reported to offline and back", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const seen = yield* Effect.gen(function* () {
        const tags = yield* collected(RemoteState.followed(desk), (each) => each._tag)
        const source = yield* TestWeb.openedAt("/api/displays/desk")

        source.onmessage?.({ data: reported(reportOf()) })
        source.onmessage?.({ data: offline })
        source.onmessage?.({ data: reported(reportOf()) })
        return yield* takeN(tags, 4)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(seen, ["Connecting", "Reported", "Offline", "Reported"])
    })
  )

  it.effect("should read a report that does not decode as offline", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const followed = yield* Effect.gen(function* () {
        yield* Atom.get(RemoteState.followed(desk))
        const source = yield* TestWeb.openedAt("/api/displays/desk")

        source.onmessage?.({ data: JSON.stringify({ _tag: "Reported", report: { screen: "nonsense" } }) })
        return yield* TestWeb.until(RemoteState.followed(desk), (each) => each._tag === "Offline")
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(followed._tag, "Offline")
    })
  )

  it.effect("should send a tapped slate game to the selected tile as Commanded Assign", () =>
    Effect.gen(function* () {
      const { registry, calls } = yield* TestWeb.withShell()

      const sent = yield* Effect.gen(function* () {
        yield* Atom.get(RemoteState.followed(desk))
        const source = yield* TestWeb.openedAt("/api/displays/desk")
        source.onmessage?.({ data: reported(reportOf()) })
        yield* TestWeb.until(RemoteState.followed(desk), (each) => each._tag === "Reported")

        yield* Atom.set(
          RemoteState.display(desk),
          DisplayInput.Dropped({ card: cardFor(GameId.make("live")) })
        )
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
      const registry = registryWith({ send: () => Effect.fail(new DisplayOffline()) })

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
      const registry = registryWith({ send: (_, input) => heldUntil(gate, done, input) })

      const finished = yield* Effect.gen(function* () {
        yield* Atom.set(RemoteState.send(desk), toggle)
        yield* afterTasks

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
      const registry = registryWith({ send: (_, input) => heldUntil(gate, done, input) })

      const finished = yield* Effect.gen(function* () {
        yield* Atom.mount(RemoteState.send(desk))
        yield* Atom.set(RemoteState.send(desk), toggle)
        yield* Atom.set(RemoteState.send(desk), toggle)
        yield* afterTasks

        yield* Deferred.succeed(gate, undefined)
        return yield* takeN(done, 2)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(finished.length, 2)
    })
  )
})

const toggle = { _tag: "Pressed", hotkey: { _tag: "ToggleSlate" } } as const

/** A registry whose Hub client is `fakes`. */
function registryWith(fakes: Parameters<typeof HubClient.layerTest>[0]) {
  return TestWeb.registryOf(
    Layer.merge(Shell.layerTest({ record: () => Effect.void }), HubClient.layerTest(fakes))
  )
}

/** A send held until `gate` opens, then recorded in `done`. */
function heldUntil(gate: Deferred.Deferred<void>, done: Queue.Queue<Schema.Json>, input: Schema.Json) {
  return Deferred.await(gate).pipe(Effect.andThen(Queue.offer(done, input)), Effect.asVoid)
}

/** Waits past the registry's next scheduled tasks, where it removes an atom nothing holds. */
const afterTasks = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))

function reportOf() {
  return new RemoteReport({ screen: TestWeb.withTiles([]) })
}

const encodeMessage = Schema.encodeSync(RemoteMessageJson)

/** A Reported message's data, as the Hub sends it. */
function reported(report: RemoteReport) {
  return encodeMessage({ _tag: "Reported", report: Schema.encodeSync(RemoteReport)(report) })
}

/** An Offline message's data. */
const offline = encodeMessage({ _tag: "Offline" })

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

/** The strip card of the test slate's game `id`, on a Quad with every tile empty. */
function cardFor(id: GameId) {
  const card = StripCard.of(TestWeb.withTiles([]), TestWeb.slate).find((each) => each.id === id)
  if (card === undefined) throw new Error(`No card for ${id}`)
  return card
}
