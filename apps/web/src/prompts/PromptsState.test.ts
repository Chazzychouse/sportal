import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Game, GameId } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect, Option } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { vi } from "vitest"
import * as AutopilotState from "../autopilot/AutopilotState.ts"
import { AutopilotInput } from "../autopilot/AutopilotState.ts"
import * as LiveStream from "../hub/LiveStream.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import type { Screen } from "../screen/Screen.ts"
import * as TestWeb from "../TestWeb.ts"
import * as PromptsState from "./PromptsState.ts"
import { PromptInput } from "./PromptsState.ts"

const home = GameId.make("home")
const other = GameId.make("other")
const third = GameId.make("third")

/** Home and other in plain live play, and third on no tile in `thirdMoment`'s classification, all on FOX. */
function slate(thirdClassification = TestWeb.classified(TestWeb.redZone)) {
  return TestWeb.slateMessage([
    {
      game: Game.of(snapshot({ id: home, status: "live" })),
      availability: TestWeb.onFox(),
      classification: TestWeb.classified({ _tag: "Live" })
    },
    {
      game: Game.of(snapshot({ id: other, status: "live" })),
      availability: TestWeb.onFox(),
      classification: TestWeb.classified({ _tag: "Live" })
    },
    {
      game: Game.of(snapshot({ id: third, status: "live" })),
      availability: TestWeb.onFox(),
      classification: thirdClassification
    }
  ])
}

/** Home in the main tile and other beside it in a Quad, once the live stream has brought `message`. */
const arranged = (message: unknown) =>
  Effect.gen(function* () {
    const source = yield* TestWeb.opened
    source.onmessage?.({ data: message })
    yield* TestWeb.until(LiveStream.live, (live) => live.slate.games.length > 0)
    yield* Atom.set(DisplayScreen.screen, { _tag: "Assign", tile: 0, game: home })
    yield* Atom.set(DisplayScreen.screen, { _tag: "Assign", tile: 1, game: other })
  })

function mainGame(screen: Screen) {
  const tile = screen.tiles[0]
  return tile === undefined || tile._tag === "Empty" ? undefined : tile.game
}

describe("PromptsState", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should put the prompted game in the main tile with the sound when accepted", () =>
    Effect.gen(function* () {
      yield* arranged(slate())

      yield* Atom.set(PromptsState.prompts, PromptInput.Accepted())

      const screen = yield* Atom.get(DisplayScreen.screen)
      assert.strictEqual(mainGame(screen), third)
      assert.isTrue(screen.hears(third))
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should change nothing when accepted with no prompt", () =>
    Effect.gen(function* () {
      yield* arranged(slate(TestWeb.classified({ _tag: "Live" })))

      yield* Atom.set(PromptsState.prompts, PromptInput.Accepted())

      const screen = yield* Atom.get(DisplayScreen.screen)
      assert.strictEqual(mainGame(screen), home)
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should make the main tile yours to an autopilot that is on when accepted", () =>
    Effect.gen(function* () {
      yield* arranged(slate())
      yield* Atom.set(AutopilotState.autopilot, AutopilotInput.Toggled())

      yield* Atom.set(PromptsState.prompts, PromptInput.Accepted())

      const pilot = yield* Atom.get(AutopilotState.autopilot)
      assert.isTrue(Option.isSome(pilot.suspended.main))
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should show no prompt once it is dismissed", () =>
    Effect.gen(function* () {
      yield* arranged(slate())

      yield* Atom.set(PromptsState.prompts, PromptInput.Dismissed())

      const prompt = yield* Atom.get(PromptsState.prompt)
      assert.isTrue(Option.isNone(prompt))
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should show no prompt once turned off", () =>
    Effect.gen(function* () {
      yield* arranged(slate())

      yield* Atom.set(PromptsState.prompts, PromptInput.Toggled())

      const prompt = yield* Atom.get(PromptsState.prompt)
      assert.isTrue(Option.isNone(prompt))
    }).pipe(Effect.provide(AtomRegistry.layer))
  )
})
