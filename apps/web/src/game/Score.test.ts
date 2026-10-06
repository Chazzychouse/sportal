import { assert, describe, it } from "@effect/vitest"
import { liveSnapshot, snapshot } from "@sportal/domain/TestGame"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Score, scoreline } from "./Score.tsx"

describe("scoreline", () => {
  it("reads the away side first, the abbreviations around the scores", () => {
    const game = liveSnapshot({
      away: { ...snapshot().away, score: 21 },
      home: { ...snapshot().home, score: 14 }
    })
    assert.strictEqual(scoreline(game), "AWAY 21–14 HOME")
  })

  it("shows no score before kickoff", () => {
    assert.strictEqual(scoreline(snapshot()), "AWAY @ HOME")
  })
})

describe("Score", () => {
  const game = liveSnapshot({ away: { ...snapshot().away, score: 21, ranking: 3 } })

  it("the board size is the large scoreboard form, with the rank in a cell of its own", () => {
    const html = renderToStaticMarkup(createElement(Score, { game, side: "away", size: "board" }))
    assert.include(html, "text-4xl")
    assert.include(html, "text-3xl")
    assert.include(html, "#3")
  })

  it("the default size is the compact row form", () => {
    const html = renderToStaticMarkup(createElement(Score, { game, side: "away" }))
    assert.notInclude(html, "text-4xl")
  })
})
