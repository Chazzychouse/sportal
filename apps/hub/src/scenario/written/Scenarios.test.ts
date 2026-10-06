import { assert, describe, it } from "@effect/vitest"
import { Duration } from "effect"
import type { Scenario } from "../Scenario.ts"
import { allStoppedButOne } from "./AllStoppedButOne.ts"
import { kickoffWindow } from "./KickoffWindow.ts"
import { scenarios } from "./Scenarios.ts"
import { threeRedZonesAtOnce } from "./ThreeRedZonesAtOnce.ts"
import { twoMinuteDrillTie } from "./TwoMinuteDrillTie.ts"

const at = (scenario: Scenario, seconds: number) =>
  scenario.slateAt(scenario.origin, Duration.seconds(seconds))
const game = (scenario: Scenario, id: string, seconds: number) =>
  at(scenario, seconds).find((candidate) => candidate.id === id)

describe("scenarios", () => {
  it("lists every scenario under its own name", () => {
    assert.deepStrictEqual(
      [...scenarios.keys()],
      [
        "two-minute-drill-tie",
        "three-red-zones-at-once",
        "all-stopped-but-one",
        "blowout-and-upset-brewing",
        "kickoff-window"
      ]
    )
    for (const [name, scenario] of scenarios) assert.strictEqual(scenario.name, name)
  })

  it("starts every scenario with at least three games", () => {
    for (const scenario of scenarios.values()) assert.isAtLeast(at(scenario, 0).length, 3)
  })

  it("drives the tied game into the red zone at 2:00 and wins it with a field goal", () => {
    assert.isFalse(game(twoMinuteDrillTie, "tie-uga-ala", 90)?.situation?.inRedZone())
    assert.isTrue(game(twoMinuteDrillTie, "tie-uga-ala", 120)?.situation?.inRedZone())
    assert.strictEqual(game(twoMinuteDrillTie, "tie-uga-ala", 180)?.home.score, 27)
    assert.strictEqual(game(twoMinuteDrillTie, "tie-uga-ala", 240)?.status, "final")
  })

  it("has three games in the red zone at once at 1:00", () => {
    assert.strictEqual(at(threeRedZonesAtOnce, 60).filter((g) => g.situation?.inRedZone()).length, 3)
  })

  it("keeps every game but one still for the first two minutes", () => {
    const moving = at(allStoppedButOne, 0).filter((before) => {
      const after = game(allStoppedButOne, before.id, 120)
      return after?.clock !== before.clock || after?.status !== before.status
    })
    assert.deepStrictEqual(
      moving.map((g) => g.id),
      ["still-aub-ark"]
    )
  })

  it("kicks games off one after another, one of them in the NFL", () => {
    assert.strictEqual(game(kickoffWindow, "ko-mia-unc", 60)?.status, "scheduled")
    assert.strictEqual(game(kickoffWindow, "ko-mia-unc", 120)?.status, "live")
    assert.strictEqual(game(kickoffWindow, "ko-kc-buf", 0)?.league, "nfl")
  })
})
