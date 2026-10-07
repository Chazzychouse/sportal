import { assert, describe, it } from "@effect/vitest"
import { LeagueId } from "@sportal/domain/League"
import { DateTime, Effect } from "effect"
import { LiveSlate } from "../../LiveSlate.ts"
import * as EspnDecode from "../../provider/espn/EspnDecode.ts"
import * as EspnScript from "../../provider/espn/EspnScript.ts"
import { slateFollowing } from "../../TestFeed.ts"
import type { ScenarioScript } from "../ScenarioScript.ts"
import { allStoppedButOne } from "./AllStoppedButOne.ts"
import { kickoffWindow } from "./KickoffWindow.ts"
import { scripts } from "./Scripts.ts"
import { threeRedZonesAtOnce } from "./ThreeRedZonesAtOnce.ts"
import { twoMinuteDrillTie } from "./TwoMinuteDrillTie.ts"

describe("scripts", () => {
  it("lists every script under its own name", () => {
    assert.deepStrictEqual(
      [...scripts.keys()],
      [
        "two-minute-drill-tie",
        "three-red-zones-at-once",
        "all-stopped-but-one",
        "blowout-and-upset-brewing",
        "kickoff-window"
      ]
    )
    for (const [name, script] of scripts) assert.strictEqual(script.name, name)
  })

  it.effect("starts every script with at least three games", () =>
    Effect.forEach(scripts.values(), (script) =>
      Effect.map(at(script, 0), (slate) => assert.isAtLeast(slate.length, 3))
    )
  )

  it.effect("drives the tied game into the red zone at 2:00 and wins it with a field goal", () =>
    Effect.gen(function* () {
      assert.isFalse((yield* game(twoMinuteDrillTie, "tie-uga-ala", 90))?.situation?.inRedZone())
      assert.isTrue((yield* game(twoMinuteDrillTie, "tie-uga-ala", 120))?.situation?.inRedZone())
      assert.strictEqual((yield* game(twoMinuteDrillTie, "tie-uga-ala", 180))?.home.score, 27)
      assert.strictEqual((yield* game(twoMinuteDrillTie, "tie-uga-ala", 240))?.status, "final")
    })
  )

  it("runs a play at every change that moves the ball for the same team, turns it over, or scores", () => {
    for (const script of scripts.values())
      script.steps.forEach((step, index) => {
        const previous = script.steps[index - 1]
        for (const game of step.slate) {
          const earlier = previous?.slate.find((candidate) => candidate.id === game.id)
          const before = earlier?.situation
          const after = game.situation
          const ran = step.plays.some((run) => run.game === game.id)
          const moved =
            before?.possession !== undefined &&
            after?.possession !== undefined &&
            (before.possession !== after.possession || before.yardLine !== after.yardLine)
          const scored =
            earlier !== undefined &&
            (earlier.home.score !== game.home.score || earlier.away.score !== game.away.score)
          if (moved || scored) assert.isTrue(ran, `${script.name} ${game.id} at ${step.at} has no play`)
        }
      })
  })

  it.effect("has three games in the red zone at once at 1:00", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* at(threeRedZonesAtOnce, 60)).filter((g) => g.situation?.inRedZone()).length,
        3
      )
    })
  )

  it.effect("keeps every game but one still for the first two minutes", () =>
    Effect.gen(function* () {
      const after = yield* at(allStoppedButOne, 120)
      const moving = (yield* at(allStoppedButOne, 0)).filter((before) => {
        const later = after.find((candidate) => candidate.id === before.id)
        return later?.clock !== before.clock || later?.status !== before.status
      })
      assert.deepStrictEqual(
        moving.map((g) => g.id),
        ["still-aub-ark"]
      )
    })
  )

  it.effect("kicks games off one after another, one of them in the NFL", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* game(kickoffWindow, "ko-mia-unc", 60))?.status, "scheduled")
      assert.strictEqual((yield* game(kickoffWindow, "ko-mia-unc", 120))?.status, "live")
      assert.strictEqual((yield* game(kickoffWindow, "ko-kc-buf", 0))?.league, "nfl")
    })
  )
})

/** The slate `seconds` into `script`: its ESPN frames up to then, current through ESPN's decode. */
function at(script: ScenarioScript, seconds: number) {
  const until = DateTime.add(script.origin, { seconds })
  return LiveSlate.use((slate) => slate.latest).pipe(
    Effect.map((current) => current.games(LeagueId.literals)),
    Effect.provide(
      slateFollowing(
        EspnScript.scenarioOf(script).frames.filter((frame) =>
          DateTime.isLessThanOrEqualTo(frame.receivedAt, until)
        ),
        { decoder: EspnDecode.layer }
      )
    )
  )
}

function game(script: ScenarioScript, id: string, seconds: number) {
  return Effect.map(at(script, seconds), (slate) => slate.find((candidate) => candidate.id === id))
}
