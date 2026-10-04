import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration } from "effect"
import type { GameSnapshot } from "../Game.ts"
import type { Scenario } from "../Scenario.ts"
import { Watchability } from "../Watchability.ts"
import { allLullsButOne } from "./AllLullsButOne.ts"
import { blowoutAndUpsetBrewing } from "./BlowoutAndUpsetBrewing.ts"
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
        "all-lulls-but-one",
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
    assert.isFalse(game(twoMinuteDrillTie, "tie-uga-ala", 90)?.situation?.isRedZone)
    assert.isTrue(game(twoMinuteDrillTie, "tie-uga-ala", 120)?.situation?.isRedZone)
    assert.strictEqual(game(twoMinuteDrillTie, "tie-uga-ala", 180)?.home.score, 27)
    assert.strictEqual(game(twoMinuteDrillTie, "tie-uga-ala", 240)?.status, "final")
  })

  it("has three games in the red zone at once at 1:00", () => {
    assert.strictEqual(at(threeRedZonesAtOnce, 60).filter((g) => g.situation?.isRedZone).length, 3)
  })

  it("keeps every game but one still for the first two minutes", () => {
    const moving = at(allLullsButOne, 0).filter((before) => {
      const after = game(allLullsButOne, before.id, 120)
      return after?.clock !== before.clock || after?.status !== before.status
    })
    assert.deepStrictEqual(
      moving.map((g) => g.id),
      ["lull-aub-ark"]
    )
  })

  it("kicks games off one after another, one of them in the NFL", () => {
    assert.strictEqual(game(kickoffWindow, "ko-mia-unc", 60)?.status, "scheduled")
    assert.strictEqual(game(kickoffWindow, "ko-mia-unc", 120)?.status, "live")
    assert.strictEqual(game(kickoffWindow, "ko-kc-buf", 0)?.league, "nfl")
  })
})

/**
 * Each game's watchability at every 10 seconds of scenario time, folded as the Hub folds it each poll. Keys are game
 * ids; values are [second, watchability] pairs.
 */
function watched(scenario: Scenario, seconds: number) {
  const history = new Map<string, Array<readonly [number, Watchability]>>()
  let previous: { slate: ReadonlyArray<GameSnapshot>; watchability: ReadonlyArray<Watchability> } = {
    slate: [],
    watchability: []
  }
  for (let second = 0; second <= seconds; second += 10) {
    const now = DateTime.makeUnsafe(DateTime.toEpochMillis(scenario.origin) + second * 1000)
    const slate = scenario.slateAt(scenario.origin, Duration.seconds(second))
    const watchability = Watchability.fold(previous, slate, now)
    for (const next of watchability)
      history.set(next.game, [...(history.get(next.game) ?? []), [second, next] as const])
    previous = { slate, watchability }
  }
  return (id: string, second: number) => history.get(id)?.find(([at]) => at === second)?.[1]
}

describe("watchability through the scenarios", () => {
  it("two-minute-drill-tie: the tied game ranks first until it is final, with no lull before 3:00", () => {
    const at = watched(twoMinuteDrillTie, 240)
    for (let second = 0; second < 220; second += 10) {
      const tie = at("tie-uga-ala", second)
      for (const id of ["tie-osu-mich", "tie-tex-ou", "tie-lsu-miss"]) {
        const other = at(id, second)
        assert.isDefined(other, `${id} at ${second}s`)
        assert.isAbove(tie?.score ?? 0, other.score, `at ${second}s vs ${id}`)
      }
      if (second < 180) assert.isFalse(tie?.lull, `lull at ${second}s`)
    }
  })

  it("three-red-zones-at-once: at 1:00 the one-score fourth beats the tied third beats the blowout", () => {
    const at = watched(threeRedZonesAtOnce, 60)
    const psu = at("rz-psu-iowa", 60)
    const fsu = at("rz-fsu-clem", 60)
    const ore = at("rz-ore-wash", 60)
    assert.isDefined(fsu)
    assert.isDefined(ore)
    assert.isAbove(psu?.score ?? 0, fsu.score)
    assert.isAbove(fsu.score, ore.score)
  })

  it("all-lulls-but-one: for two minutes every game but AUB–ARK is in a lull, and AUB–ARK ranks first", () => {
    const at = watched(allLullsButOne, 120)
    for (let second = 0; second <= 120; second += 10) {
      assert.isFalse(at("lull-aub-ark", second)?.lull, `AUB–ARK at ${second}s`)
      for (const id of ["lull-tenn-uk", "lull-wisc-minn", "lull-unc-duke", "lull-hou-rice"]) {
        const other = at(id, second)
        assert.isDefined(other, `${id} at ${second}s`)
        assert.isTrue(other.lull, `${id} at ${second}s`)
        assert.isAbove(at("lull-aub-ark", second)?.score ?? 0, other.score)
      }
    }
  })

  it("blowout-and-upset-brewing: the upset outranks the blowout and says so", () => {
    const at = watched(blowoutAndUpsetBrewing, 330)
    for (let second = 0; second <= 330; second += 10) {
      const blowout = at("upset-osu-akr", second)
      assert.isDefined(blowout, `blowout at ${second}s`)
      assert.isAbove(at("upset-ala-van", second)?.score ?? 0, blowout.score)
    }
    assert.include(at("upset-ala-van", 0)?.reasons.join(" | ") ?? "", "upset brewing: VAN leads #3 ALA")
  })

  it("kickoff-window: a game scores 0 until it kicks off", () => {
    const at = watched(kickoffWindow, 130)
    assert.strictEqual(at("ko-mia-unc", 110)?.score, 0)
    assert.isAbove(at("ko-mia-unc", 130)?.score ?? 0, 0)
  })
})
