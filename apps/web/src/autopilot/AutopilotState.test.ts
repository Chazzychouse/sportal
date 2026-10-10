import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Game, GameId } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { vi } from "vitest"
import * as LiveStream from "../hub/LiveStream.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import type { Screen } from "../screen/Screen.ts"
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

  it.effect("should keep the autopilot in this browser", () =>
    Effect.gen(function* () {
      yield* arranged(slate())
      yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())

      const kept = localStorage.getItem("sportal/autopilot")

      assert.include(kept ?? "", '"on":true')
    }).pipe(Effect.provide(AtomRegistry.layer))
  )
})
