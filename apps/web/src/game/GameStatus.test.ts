import { assert, describe, it } from "@effect/vitest"
import type { GameSnapshot } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { GameStatus, localTime } from "./GameStatus.tsx"

describe("GameStatus", () => {
  it("should show a live game's status text as the provider gives it", () => {
    const game = snapshot({ status: "live", period: 2, clock: 451, statusText: "7:31 - 2nd" })

    const status = shownStatus(game)

    assert.strictEqual(status, "7:31 - 2nd")
  })

  it("should read a scheduled game as its local start time", () => {
    const game = snapshot({ status: "scheduled" })

    const status = shownStatus(game)

    assert.strictEqual(status, localTime(game.startsAt))
  })
})

/** The text `GameStatus` shows for `game`. */
function shownStatus(game: GameSnapshot): string {
  return renderToStaticMarkup(createElement(GameStatus, { game })).replace(/<[^>]*>/g, "")
}
