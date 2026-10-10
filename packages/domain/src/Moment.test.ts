import { assert, describe, it } from "@effect/vitest"
import { Moment } from "./Moment.ts"
import { team } from "./TestGame.ts"

describe("Moment.precedence", () => {
  it("should put a scoring threat before crunch time, a big play, live play, and a break, in that order", () => {
    const moments: ReadonlyArray<Moment> = [
      { _tag: "Break", reason: "timeout" },
      { _tag: "Live" },
      { _tag: "CrunchTime", margin: 3, secondsLeft: 100 },
      { _tag: "ScoringThreat", team: team("HOME").id, yardsToGo: 8 }
    ]

    const ordered = moments.toSorted(Moment.precedence).map(({ _tag }) => _tag)

    assert.deepStrictEqual(ordered, ["ScoringThreat", "CrunchTime", "Live", "Break"])
  })
})
