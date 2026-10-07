import { assert, describe, it } from "@effect/vitest"
import { liveSnapshot, snapshot } from "@sportal/domain/TestGame"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Score, scoreline } from "./Score.tsx"

describe("scoreline", () => {
  it("should read the away side first, the abbreviations around the scores", () => {
    const game = liveSnapshot({
      away: { ...snapshot().away, score: 21 },
      home: { ...snapshot().home, score: 14 }
    })

    const line = scoreline(game)

    assert.strictEqual(line, "AWAY 21–14 HOME")
  })

  it("should show no score before kickoff", () => {
    const line = scoreline(snapshot())

    assert.strictEqual(line, "AWAY @ HOME")
  })
})

describe("Score", () => {
  it("should draw the board size as the large scoreboard form, with the rank in a cell of its own", () => {
    const game = rankedAwayScoring()

    const html = renderToStaticMarkup(createElement(Score, { game, side: "away", size: "board" }))

    assert.include(html, "text-4xl")
    assert.include(html, "text-3xl")
    assert.include(html, "#3")
  })

  it("should draw the default size as the compact row form", () => {
    const game = rankedAwayScoring()

    const html = renderToStaticMarkup(createElement(Score, { game, side: "away" }))

    assert.notInclude(html, "text-4xl")
  })
})

/** A live game whose away side, ranked third, has 21. */
function rankedAwayScoring() {
  return liveSnapshot({ away: { ...snapshot().away, score: 21, ranking: 3 } })
}
