import { assert, describe, it } from "@effect/vitest"
import { Game, GameId } from "@sportal/domain/Game"
import { Slate } from "@sportal/domain/Slate"
import { liveSnapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Duration, Option, Record } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
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

function titleOf(autopilot: Autopilot, classifications = {}) {
  const markup = renderToStaticMarkup(
    createElement(AutopilotToggle, { autopilot, slate, classifications, now, onToggle: () => {} })
  )
  return /title="([^"]*)"/.exec(markup)?.[1]
}

describe("AutopilotToggle", () => {
  it("should say it is off", () => {
    const title = titleOf(Autopilot.off)

    assert.strictEqual(title, "Autopilot off · A")
  })

  it("should name the game it is away on and why", () => {
    const away = new Autopilot({
      ...Autopilot.off,
      on: true,
      away: { main: Option.some({ game: dal, since: now }), audio: Option.none() }
    })

    const title = titleOf(away, Record.fromEntries([[dal, TestWeb.classified(TestWeb.redZone)] as const]))

    assert.strictEqual(title, "Autopilot on: away on PHI @ DAL — red zone · A")
  })

  it("should say for how long the main tile is yours", () => {
    const yours = new Autopilot({
      ...Autopilot.off,
      on: true,
      suspended: { main: Option.some(DateTime.addDuration(now, Duration.seconds(161))), audio: Option.none() }
    })

    const title = titleOf(yours)

    assert.strictEqual(title, "Autopilot on: main tile yours for 2:41 · A")
  })
})
