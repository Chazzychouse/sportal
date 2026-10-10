import { assert, describe, it } from "@effect/vitest"
import { Classification } from "@sportal/domain/Classification"
import type { Moment } from "@sportal/domain/Moment"
import { liveSnapshot, team } from "@sportal/domain/TestGame"
import { DateTime } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { localTime } from "./GameStatus.tsx"
import { MomentBadge } from "./MomentBadge.tsx"

describe("MomentBadge", () => {
  it("should mark a break in the red zone BRK · RZ", () => {
    const markup = badgeOf({
      _tag: "Break",
      reason: "timeout",
      expectedEnd,
      during: { _tag: "ScoringThreat", team: team("HOME").id, yardsToGo: 8 }
    })

    assert.include(markup.replace(/<[^>]*>/g, ""), "BRK · RZ")
  })

  it("should title a break with its reason and when it is likely back", () => {
    const markup = badgeOf({ _tag: "Break", reason: "possessionChange", expectedEnd })

    assert.include(markup, `change of possession, back about ${localTime(expectedEnd)}`)
  })
})

const expectedEnd = DateTime.makeUnsafe("2026-10-10T20:02:00Z")

/** The markup `MomentBadge` renders for a live game in `moment`. */
function badgeOf(moment: Moment): string {
  const classification = Classification.of(
    { snapshot: liveSnapshot(), odds: undefined, winProbabilities: [] },
    moment,
    DateTime.makeUnsafe("2026-10-10T20:00:00Z")
  )
  return renderToStaticMarkup(createElement(MomentBadge, { classification }))
}
