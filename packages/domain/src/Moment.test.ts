import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration } from "effect"
import { BreakReason, Moment } from "./Moment.ts"
import { PlayId } from "./Play.ts"
import { team } from "./TestGame.ts"

describe("Moment.precedence", () => {
  it("should put a big play before a break, a scoring threat, crunch time, and live play, in that order", () => {
    const moments: ReadonlyArray<Moment> = [
      { _tag: "Live" },
      { _tag: "CrunchTime", margin: 3, secondsLeft: 100 },
      { _tag: "ScoringThreat", team: team("HOME").id, yardsToGo: 8 },
      { _tag: "Break", reason: "timeout", expectedEnd: DateTime.makeUnsafe("2026-10-10T20:01:00Z") },
      { _tag: "BigPlay", play: PlayId.make("1"), kind: "sack" }
    ]

    const ordered = moments.toSorted(Moment.precedence).map(({ _tag }) => _tag)

    assert.deepStrictEqual(ordered, ["BigPlay", "Break", "ScoringThreat", "CrunchTime", "Live"])
  })
})

describe("BreakReason.typicalLength", () => {
  it("should give a college halftime longer than an NFL one", () => {
    const [college, nfl] = [
      BreakReason.typicalLength("halftime", "fbs"),
      BreakReason.typicalLength("halftime", "nfl")
    ]

    assert.isTrue(Duration.isGreaterThan(college, nfl))
  })

  it("should give a team timeout less time than a media break after a change of possession", () => {
    const [timeout, media] = [
      BreakReason.typicalLength("timeout", "nfl"),
      BreakReason.typicalLength("possessionChange", "nfl")
    ]

    assert.isTrue(Duration.isLessThan(timeout, media))
  })
})
