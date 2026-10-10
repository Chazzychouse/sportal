import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Game, GameId } from "@sportal/domain/Game"
import { Slate } from "@sportal/domain/Slate"
import { liveSnapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Duration, Option, Record } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { vi } from "vitest"
import { Screen } from "../screen/Screen.ts"
import * as TestWeb from "../TestWeb.ts"
import { Autopilot } from "./Autopilot.ts"
import { AutopilotToggle } from "./AutopilotToggle.tsx"

const now = DateTime.makeUnsafe("2026-10-10T20:00:00Z")
const dal = GameId.make("dal")
const slate = new Slate({
  games: [
    Game.of(
      liveSnapshot({ id: dal, home: { team: team("DAL"), score: 0 }, away: { team: team("PHI"), score: 0 } })
    )
  ]
})

function titleOf(autopilot: Autopilot, classifications = {}, screen: Screen = Screen.initial) {
  const markup = renderToStaticMarkup(
    createElement(AutopilotToggle, { autopilot, slate, classifications, screen, onToggle: () => {} })
  )
  return /title="([^"]*)"/.exec(markup)?.[1]
}

function classify(classification: ReturnType<typeof TestWeb.classified>) {
  return Record.fromEntries([[dal, classification] as const])
}

describe("AutopilotToggle", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(DateTime.toDate(now))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("should say it is off", () => {
    const title = titleOf(Autopilot.off)

    assert.strictEqual(title, "Autopilot off · A")
  })

  it("should name the game it follows and its rank", () => {
    const on = Autopilot.off.toggle(Screen.initial)

    const title = titleOf(on, classify(TestWeb.classified(TestWeb.redZone)), TestWeb.withTiles(["dal"]))

    assert.strictEqual(title, "Autopilot on: following PHI @ DAL — red zone · A")
  })

  it("should say nothing is live", () => {
    const on = Autopilot.off.toggle(Screen.initial)

    const title = titleOf(on)

    assert.strictEqual(title, "Autopilot on: following, nothing live · A")
  })

  it("should say it fitted the layout", () => {
    const on = new Autopilot({ ...Autopilot.off, on: true, ceiling: Option.some("Quad") })
    const paired = new Screen({ ...TestWeb.withTiles(["dal"]), layout: "Pair" })

    const title = titleOf(on, classify(TestWeb.classified({ _tag: "Live" })), paired)

    assert.strictEqual(title, "Autopilot on: following PHI @ DAL — live, fitted to 2 tiles · A")
  })

  it("should say for how long the main tile is yours", () => {
    const yours = new Autopilot({
      ...Autopilot.off,
      on: true,
      suspended: {
        main: Option.some(DateTime.addDuration(now, Duration.seconds(161))),
        audio: Option.none(),
        layout: Option.none()
      }
    })

    const title = titleOf(yours)

    assert.strictEqual(title, "Autopilot on: main tile yours for 2:41 · A")
  })

  it("should say for how long the sound is yours", () => {
    const yours = new Autopilot({
      ...Autopilot.off,
      on: true,
      suspended: {
        main: Option.none(),
        audio: Option.some(DateTime.addDuration(now, Duration.seconds(75))),
        layout: Option.none()
      }
    })

    const title = titleOf(yours)

    assert.strictEqual(title, "Autopilot on: sound yours for 1:15 · A")
  })

  it("should say for how long the layout is yours", () => {
    const yours = new Autopilot({
      ...Autopilot.off,
      on: true,
      suspended: {
        main: Option.none(),
        audio: Option.none(),
        layout: Option.some(DateTime.addDuration(now, Duration.seconds(161)))
      }
    })

    const title = titleOf(yours)

    assert.strictEqual(title, "Autopilot on: layout yours for 2:41 · A")
  })
})
