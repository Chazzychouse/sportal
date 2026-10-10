import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Classification } from "@sportal/domain/Classification"
import { Game, GameId } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Clock, DateTime, Duration, Effect, Layer } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import { HubClient } from "../hub/HubClient.ts"
import * as LiveStream from "../hub/LiveStream.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import type { Screen } from "../screen/Screen.ts"
import { Shell } from "../shell/Shell.ts"
import * as TestWeb from "../TestWeb.ts"
import * as AutopilotState from "./AutopilotState.ts"
import { AutopilotInput } from "./AutopilotState.ts"

const home = GameId.make("home")
const other = GameId.make("other")
const homeGame = Game.of(snapshot({ id: home, status: "live" }))
const otherGame = Game.of(snapshot({ id: other, status: "live" }))

/** A slate of the two games, both on FOX: home in plain live play, `other` classified as given. */
function slate(otherClassification = TestWeb.classified({ _tag: "Live" })) {
  return TestWeb.slateMessage([
    { game: homeGame, availability: TestWeb.onFox(), classification: TestWeb.classified({ _tag: "Live" }) },
    { game: otherGame, availability: TestWeb.onFox(), classification: otherClassification }
  ])
}

/** Home in the main tile and `other` beside it, once the live stream has brought `message`. */
const arranged = (message: unknown) =>
  Effect.gen(function* () {
    const source = yield* TestWeb.opened
    source.onmessage?.({ data: message })
    yield* TestWeb.until(LiveStream.live, (live) => live.slate.games.length > 0)
    yield* Atom.set(DisplayScreen.screen, { _tag: "Assign", tile: 0, game: home })
    yield* Atom.set(DisplayScreen.screen, { _tag: "Assign", tile: 1, game: other })
    return source
  })

function mainGame(screen: Screen) {
  const tile = screen.tiles[0]
  return tile === undefined || tile._tag === "Empty" ? undefined : tile.game
}

describe("AutopilotState", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it.effect("should promote a red zone on another tile as soon as it is turned on", () =>
    Effect.gen(function* () {
      yield* arranged(slate(TestWeb.classified(TestWeb.redZone)))

      yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())

      const screen = yield* Atom.get(DisplayScreen.screen)
      assert.strictEqual(mainGame(screen), other)
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should promote a red zone a slate brings while it is on", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const screen = yield* Effect.gen(function* () {
        const source = yield* arranged(slate())
        yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())
        yield* Atom.mount(AutopilotState.pilot)

        source.onmessage?.({ data: slate(TestWeb.classified(TestWeb.redZone)) })
        return yield* TestWeb.until(DisplayScreen.screen, (screen) => mainGame(screen) === other)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(mainGame(screen), other)
    })
  )

  it.effect("should promote home again at the end of the dwell with no new slate", () =>
    Effect.gen(function* () {
      const start = DateTime.makeUnsafe("2026-10-10T20:00:00Z")
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(DateTime.toDate(start))
      yield* TestClock.setTime(DateTime.toEpochMillis(start))
      const clock = yield* Clock.Clock
      const registry = TestWeb.registryOf(
        Layer.mergeAll(
          Shell.layerTest({ record: () => Effect.void }),
          HubClient.layerTest(() => Effect.void),
          Layer.succeed(Clock.Clock, clock)
        )
      )

      const screen = yield* Effect.gen(function* () {
        const source = yield* arranged(slate(TestWeb.classified(TestWeb.redZone)))
        yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())
        yield* Atom.mount(AutopilotState.pilot)
        yield* passing(Duration.seconds(10))
        source.onmessage?.({ data: slate() })
        yield* passing(Duration.seconds(20))
        return yield* TestWeb.until(DisplayScreen.screen, (screen) => mainGame(screen) === home)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(mainGame(screen), home)
    })
  )

  it.effect("should shrink the layout once a finished game's hold runs out, with no new slate", () =>
    Effect.gen(function* () {
      const start = DateTime.makeUnsafe("2026-10-10T20:00:00Z")
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(DateTime.toDate(start))
      yield* TestClock.setTime(DateTime.toEpochMillis(start))
      const clock = yield* Clock.Clock
      const registry = TestWeb.registryOf(
        Layer.mergeAll(
          Shell.layerTest({ record: () => Effect.void }),
          HubClient.layerTest(() => Effect.void),
          Layer.succeed(Clock.Clock, clock)
        )
      )

      const screen = yield* Effect.gen(function* () {
        yield* arranged(slate(TestWeb.classified({ _tag: "Final" })))
        yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())
        yield* Atom.mount(AutopilotState.pilot)
        yield* passing(Duration.minutes(2))
        return yield* TestWeb.until(DisplayScreen.screen, (screen) => screen.layout === "Single")
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(screen.layout, "Single")
    })
  )

  it.effect("should shrink the layout at a later hold's end after an earlier one changed nothing", () =>
    Effect.gen(function* () {
      const start = DateTime.makeUnsafe("2026-10-10T20:00:00Z")
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(DateTime.toDate(start))
      yield* TestClock.setTime(DateTime.toEpochMillis(start))
      const clock = yield* Clock.Clock
      const registry = TestWeb.registryOf(
        Layer.mergeAll(
          Shell.layerTest({ record: () => Effect.void }),
          HubClient.layerTest(() => Effect.void),
          Layer.succeed(Clock.Clock, clock)
        )
      )
      const third = GameId.make("third")
      const fourth = GameId.make("fourth")
      const finalSince = (time: string) =>
        new Classification({
          ...TestWeb.classified({ _tag: "Final" }),
          since: DateTime.makeUnsafe(time)
        })
      const message = TestWeb.slateMessage([
        {
          game: homeGame,
          availability: TestWeb.onFox(),
          classification: TestWeb.classified({ _tag: "Live" })
        },
        {
          game: otherGame,
          availability: TestWeb.onFox(),
          classification: finalSince("2026-10-10T20:00:00Z")
        },
        {
          game: Game.of(snapshot({ id: third, status: "live" })),
          availability: TestWeb.onFox(),
          classification: finalSince("2026-10-10T20:01:00Z")
        },
        {
          game: Game.of(snapshot({ id: fourth, status: "live" })),
          availability: TestWeb.onFox(),
          classification: TestWeb.classified({ _tag: "Live" })
        }
      ])

      const screen = yield* Effect.gen(function* () {
        yield* arranged(message)
        yield* Atom.set(DisplayScreen.screen, { _tag: "Assign", tile: 2, game: third })
        yield* Atom.set(DisplayScreen.screen, { _tag: "Assign", tile: 3, game: fourth })
        yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())
        yield* Atom.mount(AutopilotState.pilot)
        yield* passing(Duration.minutes(2))
        yield* passing(Duration.minutes(1))
        return yield* TestWeb.until(DisplayScreen.screen, (screen) => screen.layout === "Pair")
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(screen.layout, "Pair")
    })
  )

  it.effect("should keep nothing in this browser for a tick that changes nothing", () =>
    Effect.gen(function* () {
      yield* arranged(slate())
      yield* Atom.get(AutopilotState.autopilot)
      const writes = vi.spyOn(localStorage, "setItem")

      yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Ticked())

      assert.strictEqual(writes.mock.calls.length, 0)
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should read the autopilot back on after a reload", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* arranged(slate())
        yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())
      }).pipe(Effect.provide(AtomRegistry.layer))

      const pilot = yield* Atom.get(AutopilotState.autopilot).pipe(Effect.provide(AtomRegistry.layer))

      assert.isTrue(pilot.on)
    })
  )
})

/** `duration` passing on both the Effect clock and the browser's. */
function passing(duration: Duration.Duration) {
  return Effect.gen(function* () {
    vi.setSystemTime(Date.now() + Duration.toMillis(duration))
    yield* TestClock.adjust(duration)
  })
}
