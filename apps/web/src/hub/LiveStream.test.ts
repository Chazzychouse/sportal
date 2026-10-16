import { assert, describe, it } from "@effect/vitest"
import { Effect, SubscriptionRef } from "effect"
import { Atom } from "effect/reactivity"
import * as TestWeb from "../TestWeb.ts"
import { Connection } from "./HubSocket.ts"
import * as LiveStream from "./LiveStream.ts"

describe("LiveStream.of", () => {
  it.effect("should be connecting before the socket first connects", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()
      yield* SubscriptionRef.set(hub.connection, Connection.Connecting())

      const state = yield* Atom.get(counted).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(state.connection._tag, "Connecting")
    })
  )

  it.effect("should be lost when the socket is lost", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const state = yield* Effect.gen(function* () {
        yield* Atom.mount(counted)

        yield* SubscriptionRef.set(hub.connection, TestWeb.lost)
        return yield* TestWeb.until(counted, ({ connection }) => connection._tag === "Lost")
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(state.connection, TestWeb.lost)
    })
  )

  it.effect("should fold each element into its value", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const state = yield* Effect.gen(function* () {
        yield* Atom.mount(counted)

        yield* TestWeb.answer(hub, "games", hub.lists, TestWeb.todayList)
        yield* TestWeb.answer(hub, "games", hub.lists, TestWeb.todayList)
        return yield* TestWeb.until(counted, ({ value }) => value === 8)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(state.value, 8)
    })
  )

  it.effect("should ask its query again when the socket connects again", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const state = yield* Effect.gen(function* () {
        yield* Atom.mount(counted)
        yield* TestWeb.answer(hub, "games", hub.lists, TestWeb.todayList)
        yield* TestWeb.until(counted, ({ value }) => value === 4)
        yield* SubscriptionRef.set(hub.connection, TestWeb.lost)
        yield* TestWeb.dropped(hub, "games")

        yield* SubscriptionRef.set(hub.connection, Connection.Connected())
        yield* TestWeb.answer(hub, "games", hub.lists, TestWeb.todayList)
        return yield* TestWeb.until(counted, ({ value }) => value === 8)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(state.connection._tag, "Connected")
    })
  )

  it.effect("should end its query on the Hub when the registry goes", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()
      yield* Effect.andThen(Atom.get(counted), TestWeb.asked(hub, "games")).pipe(
        Effect.scoped,
        Effect.provide(registry)
      )

      const open = yield* TestWeb.dropped(hub, "games")

      assert.notInclude(open, "games")
    })
  )
})

/** Today's games, counted across every answer; kept alive so a test's reads all see one query. */
const counted = LiveStream.of(
  (client) => client.listLive({}),
  0,
  (count, { games }) => count + games.length
).pipe(Atom.keepAlive)
