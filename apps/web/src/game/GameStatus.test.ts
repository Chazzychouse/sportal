import { assert, describe, it } from "@effect/vitest"
import type { GameSnapshot } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { GameStatus, localTime } from "./GameStatus.tsx"

describe("GameStatus", () => {
  it.each([
    [{ status: "live", period: 2, clock: "7:31" }, "Q2 7:31"],
    [{ status: "live", period: 5, clock: "10:00" }, "OT 10:00"],
    [{ status: "live", period: 6, clock: "10:00" }, "2OT 10:00"],
    [{ status: "live", period: 7, clock: "10:00" }, "3OT 10:00"],
    [{ status: "halftime", period: 2, clock: "0:00" }, "Half"],
    [{ status: "delayed", period: 2, clock: "5:00" }, "Delayed"],
    [{ status: "final", period: 4, clock: "0:00" }, "Final"],
    [{ status: "final", period: 5, clock: "0:00" }, "Final/OT"],
    [{ status: "postponed" }, "Postponed"],
    [{ status: "canceled" }, "Canceled"]
  ] as const)("should read %j as %s", (overrides, text) => {
    const game = snapshot(overrides)

    const status = shownStatus(game)

    assert.strictEqual(status, text)
  })

  it("should read a scheduled game as its local kickoff time", () => {
    const game = snapshot({ status: "scheduled" })

    const status = shownStatus(game)

    assert.strictEqual(status, localTime(game.kickoff))
  })
})

/** The text `GameStatus` shows for `game`. */
function shownStatus(game: GameSnapshot): string {
  return renderToStaticMarkup(createElement(GameStatus, { game })).replace(/<[^>]*>/g, "")
}
