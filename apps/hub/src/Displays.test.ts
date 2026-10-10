import { assert, describe, it } from "@effect/vitest"
import { DisplayId } from "@sportal/api/DisplayId"
import type { RemoteMessage } from "@sportal/api/RemoteMessage"
import { Effect, Fiber, Queue, Stream } from "effect"
import { Displays } from "./Displays.ts"

const desk = DisplayId.make("desk")

describe("Displays", () => {
  it.effect("should pass an input sent to its Display", () =>
    Effect.gen(function* () {
      const displays = yield* Displays
      const inputs = yield* displays.connect(desk)
      const taken = yield* Stream.runHead(inputs).pipe(Effect.forkScoped)

      yield* displays.send(desk, { _tag: "Pressed" })

      const input = yield* Fiber.join(taken)
      assert.deepStrictEqual(input._tag === "Some" ? input.value : undefined, { _tag: "Pressed" })
    }).pipe(Effect.scoped, Effect.provide(Displays.layer))
  )

  it.effect("should refuse an input for a Display that is not connected", () =>
    Effect.gen(function* () {
      const displays = yield* Displays

      const error = yield* displays.send(desk, { _tag: "Pressed" }).pipe(Effect.flip)

      assert.strictEqual(error._tag, "DisplayOffline")
    }).pipe(Effect.provide(Displays.layer))
  )

  it.effect("should refuse a report from a Display that is not connected", () =>
    Effect.gen(function* () {
      const displays = yield* Displays

      const error = yield* displays.report(desk, { screen: 1 }).pipe(Effect.flip)

      assert.strictEqual(error._tag, "DisplayOffline")
    }).pipe(Effect.provide(Displays.layer))
  )

  it.effect("should give a follower the current report, then each new one", () =>
    Effect.gen(function* () {
      const displays = yield* Displays
      const inputs = yield* displays.connect(desk)
      yield* Stream.runDrain(inputs).pipe(Effect.forkScoped)
      yield* displays.report(desk, { screen: 1 })
      const seen = yield* followed(displays)

      yield* displays.report(desk, { screen: 2 })

      assert.deepStrictEqual(yield* Queue.take(seen), { _tag: "Reported", report: { screen: 1 } })
      assert.deepStrictEqual(yield* Queue.take(seen), { _tag: "Reported", report: { screen: 2 } })
    }).pipe(Effect.scoped, Effect.provide(Displays.layer))
  )

  it.effect("should tell a follower its Display is offline before it has reported", () =>
    Effect.gen(function* () {
      const displays = yield* Displays
      const inputs = yield* displays.connect(desk)
      yield* Stream.runDrain(inputs).pipe(Effect.forkScoped)

      const seen = yield* followed(displays)

      assert.deepStrictEqual(yield* Queue.take(seen), { _tag: "Offline" })
    }).pipe(Effect.scoped, Effect.provide(Displays.layer))
  )

  it.effect("should tell a follower its Display went offline when its input stream ends", () =>
    Effect.gen(function* () {
      const displays = yield* Displays
      const inputs = yield* displays.connect(desk)
      const connected = yield* Stream.runDrain(inputs).pipe(Effect.forkScoped)
      yield* displays.report(desk, { screen: 1 })
      const seen = yield* followed(displays)
      yield* Queue.take(seen)

      yield* Fiber.interrupt(connected)

      assert.deepStrictEqual(yield* Queue.take(seen), { _tag: "Offline" })
    }).pipe(Effect.scoped, Effect.provide(Displays.layer))
  )

  it.effect("should forget a Display's report when it disconnects", () =>
    Effect.gen(function* () {
      const displays = yield* Displays
      const first = yield* displays.connect(desk)
      const connected = yield* Stream.runDrain(first).pipe(Effect.forkScoped)
      yield* displays.report(desk, { screen: 1 })
      yield* Fiber.interrupt(connected)

      const again = yield* displays.connect(desk)
      yield* Stream.runDrain(again).pipe(Effect.forkScoped)
      const seen = yield* followed(displays)

      assert.deepStrictEqual(yield* Queue.take(seen), { _tag: "Offline" })
    }).pipe(Effect.scoped, Effect.provide(Displays.layer))
  )
})

/** Follows the desk: a queue of each Remote message, as it comes. */
const followed = Effect.fnUntraced(function* (displays: Displays["Service"]) {
  const seen = yield* Queue.unbounded<RemoteMessage>()
  yield* displays.follow(desk).pipe(
    Stream.runForEach((message) => Queue.offer(seen, message)),
    Effect.forkScoped
  )
  yield* Effect.yieldNow
  return seen
})
