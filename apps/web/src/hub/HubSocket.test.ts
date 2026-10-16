import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect, Queue, Stream, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import * as TestWeb from "../TestWeb.ts"
import { type Connection, HubSocket } from "./HubSocket.ts"

describe("HubSocket", () => {
  beforeEach(() => {
    FakeWebSocket.dialed = []
    vi.stubGlobal("WebSocket", FakeWebSocket)
    vi.stubGlobal("location", { href: "http://desk.local:4401/remote/abc" })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should dial /api/socket on the page's host", () =>
    Effect.gen(function* () {
      const url = yield* Effect.gen(function* () {
        yield* connections
        const socket = yield* dialed(0)
        return socket.url
      }).pipe(Effect.scoped, Effect.provide(HubSocket.layer))

      assert.strictEqual(url, "ws://desk.local:4401/api/socket")
    })
  )

  it.effect("should be connecting before the socket first opens", () =>
    Effect.gen(function* () {
      const first = yield* Effect.gen(function* () {
        const published = yield* connections
        return yield* Queue.take(published)
      }).pipe(Effect.scoped, Effect.provide(HubSocket.layer))

      assert.strictEqual(first, "Connecting")
    })
  )

  it.effect("should be connected once the socket opens", () =>
    Effect.gen(function* () {
      const published = yield* Effect.gen(function* () {
        const published = yield* connections
        const socket = yield* dialed(0)

        socket.open()
        return yield* Queue.takeN(published, 2)
      }).pipe(Effect.scoped, Effect.provide(HubSocket.layer))

      assert.deepStrictEqual(published, ["Connecting", "Connected"])
    })
  )

  it.effect("should be lost when an open socket closes", () =>
    Effect.gen(function* () {
      const lost = yield* Effect.gen(function* () {
        const published = yield* connections
        const socket = yield* dialed(0)
        socket.open()
        yield* Queue.takeN(published, 2)

        socket.drop()
        return yield* Queue.take(published)
      }).pipe(Effect.scoped, Effect.provide(HubSocket.layer))

      assert.strictEqual(lost, "Lost")
    })
  )

  it.effect("should stay connecting when the socket fails before it first opens", () =>
    Effect.gen(function* () {
      const published = yield* Effect.gen(function* () {
        const published = yield* connections
        const first = yield* dialed(0)

        first.drop()
        yield* TestClock.adjust("1 second")
        const second = yield* dialed(1)
        second.open()
        return yield* Queue.takeN(published, 2)
      }).pipe(Effect.scoped, Effect.provide(HubSocket.layer))

      assert.deepStrictEqual(published, ["Connecting", "Connected"])
    })
  )

  it.effect(
    "should publish nothing for a failed reopening while lost, then be connected on a new socket",
    () =>
      Effect.gen(function* () {
        const published = yield* Effect.gen(function* () {
          const published = yield* connections
          const first = yield* dialed(0)
          first.open()
          yield* Queue.takeN(published, 2)
          first.drop()
          yield* TestClock.adjust("1 second")
          const second = yield* dialed(1)

          second.drop()
          yield* TestClock.adjust("1 second")
          const third = yield* dialed(2)
          third.open()
          return yield* Queue.takeN(published, 2)
        }).pipe(Effect.scoped, Effect.provide(HubSocket.layer))

        assert.deepStrictEqual(published, ["Lost", "Connected"])
      })
  )

  it.effect("should wait longer before each reopening while the Hub stays away", () =>
    Effect.gen(function* () {
      const count = yield* Effect.gen(function* () {
        yield* connections
        const first = yield* dialed(0)
        first.drop()
        yield* TestClock.adjust("500 millis")
        const second = yield* dialed(1)

        second.drop()
        yield* TestClock.adjust("500 millis")
        yield* Effect.yieldNow
        return FakeWebSocket.dialed.length
      }).pipe(Effect.scoped, Effect.provide(HubSocket.layer))

      assert.strictEqual(count, 2)
    })
  )
})

describe("HubSocket#live", () => {
  it.effect("should ask a refused query again 10 seconds later, and send what the Hub answers then", () =>
    Effect.gen(function* () {
      const hub = yield* TestWeb.liveHub()
      yield* SubscriptionRef.set(hub.refusals, 1)

      const answer = yield* Effect.gen(function* () {
        const socket = yield* HubSocket
        const answers = yield* Queue.unbounded<GameId>()
        const live = socket.live((client) => client.gameLive({ id: game.id }))
        yield* live.pipe(
          Stream.runForEach(({ snapshot }) => Queue.offer(answers, snapshot.id)),
          Effect.forkScoped
        )
        yield* SubscriptionRef.changes(hub.refusals).pipe(
          Stream.filter((left) => left === 0),
          Stream.runHead
        )

        yield* TestClock.adjust("10 seconds")
        yield* TestWeb.answer(hub, `game ${game.id}`, hub.games, { snapshot: game, availability: [] })
        return yield* Queue.take(answers)
      }).pipe(Effect.scoped, Effect.provide(hub.layer))

      assert.strictEqual(answer, game.id)
    })
  )
})

/** A game the Hub refuses before it answers it. */
const game = snapshot({ id: GameId.make("401") })

/** Each connection the socket publishes, by its tag, in a queue, while the test's scope lives. */
const connections = Effect.gen(function* () {
  const socket = yield* HubSocket
  const published = yield* Queue.unbounded<Connection["_tag"]>()

  yield* socket.connection.pipe(
    Stream.runForEach((each) => Queue.offer(published, each._tag)),
    Effect.forkScoped
  )
  return published
})

/** The `n`th socket dialed, 0-based, once the client listens on it. */
function dialed(n: number): Effect.Effect<FakeWebSocket> {
  return Effect.suspend(() => {
    const socket = FakeWebSocket.dialed[n]
    return socket?.listening() === true
      ? Effect.succeed(socket)
      : Effect.flatMap(Effect.yieldNow, () => dialed(n))
  })
}

/**
 * A browser WebSocket a test drives by hand: it records each one dialed, and the test opens it or drops it as the
 * browser would. What the client sends goes nowhere, so no pong ever comes: a test stays under 5 s after an open.
 */
class FakeWebSocket {
  static dialed: Array<FakeWebSocket> = []
  readyState = 0
  readonly url: string
  private readonly listeners = new Map<string, Set<(event: FakeEvent) => void>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.dialed.push(this)
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener))
  }

  removeEventListener(type: string, listener: (event: FakeEvent) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  send() {}

  close() {}

  /** Whether the client listens for its close yet. */
  listening() {
    return (this.listeners.get("close")?.size ?? 0) > 0
  }

  open() {
    this.readyState = 1
    this.dispatch({ type: "open" })
  }

  /** Closes it as a lost connection does: abnormally, 1006. */
  drop() {
    this.readyState = 3
    this.dispatch({ type: "close", code: 1006 })
  }

  private dispatch(event: FakeEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event)
  }
}

interface FakeEvent {
  readonly type: string
  readonly code?: number
}
