import { assert, describe, it } from "@effect/vitest"
import type { GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { DateTime, Effect } from "effect"
import { LiveSlate } from "../../LiveSlate.ts"
import * as EspnDecode from "../../provider/espn/EspnDecode.ts"
import * as EspnScript from "../../provider/espn/EspnScript.ts"
import { slateFollowing } from "../../TestLiveSlate.ts"
import type { ScenarioScript } from "../ScenarioScript.ts"
import { allStoppedButOne } from "./AllStoppedButOne.ts"
import { kickoffWindow } from "./KickoffWindow.ts"
import { scripts } from "./Scripts.ts"
import { threeRedZonesAtOnce } from "./ThreeRedZonesAtOnce.ts"
import { twoMinuteDrillTie } from "./TwoMinuteDrillTie.ts"

describe("scripts", () => {
  it("should list every script under its own name", () => {
    const names = [...scripts.keys()]

    assert.deepStrictEqual(names, [
      "two-minute-drill-tie",
      "three-red-zones-at-once",
      "all-stopped-but-one",
      "blowout-and-upset-brewing",
      "kickoff-window"
    ])
    for (const [name, script] of scripts) assert.strictEqual(script.name, name)
  })

  it.effect.each([...scripts.values()])("should start $name with at least three games", (script) =>
    Effect.gen(function* () {
      const slate = yield* at(script, 0)

      assert.isAtLeast(slate.length, 3)
    })
  )

  it.each([...scripts.values()])(
    "should run a play in $name at every change that moves the ball for the same team, turns it over, or scores",
    (script) => {
      const changes = script.steps.flatMap((step, index) => {
        const previous = script.steps[index - 1]
        return step.slate.flatMap((game) => (needsPlay(game, previous) ? [{ step, game }] : []))
      })

      assert.isNotEmpty(changes, `${script.name} has no change that moves the ball or scores`)
      for (const { step, game } of changes) {
        const ran = step.plays.some((run) => run.game === game.id)
        assert.isTrue(ran, `${script.name} ${game.id} at ${step.at} has no play`)
      }
    }
  )

  describe("two-minute-drill-tie", () => {
    it.effect("should keep the tied game out of the red zone at 1:30", () =>
      Effect.gen(function* () {
        const tied = yield* game(twoMinuteDrillTie, "tie-uga-ala", 90)

        assert.isFalse(tied?.situation?.inRedZone())
      })
    )

    it.effect("should drive the tied game into the red zone at 2:00", () =>
      Effect.gen(function* () {
        const tied = yield* game(twoMinuteDrillTie, "tie-uga-ala", 120)

        assert.isTrue(tied?.situation?.inRedZone())
      })
    )

    it.effect("should win the tied game with a field goal by 3:00", () =>
      Effect.gen(function* () {
        const tied = yield* game(twoMinuteDrillTie, "tie-uga-ala", 180)

        assert.strictEqual(tied?.home.score, 27)
      })
    )

    it.effect("should end the tied game by 4:00", () =>
      Effect.gen(function* () {
        const tied = yield* game(twoMinuteDrillTie, "tie-uga-ala", 240)

        assert.strictEqual(tied?.status, "final")
      })
    )
  })

  it.effect("should have three games in the red zone at once at 1:00", () =>
    Effect.gen(function* () {
      const slate = yield* at(threeRedZonesAtOnce, 60)

      const inRedZone = slate.filter((g) => g.situation?.inRedZone())

      assert.strictEqual(inRedZone.length, 3)
    })
  )

  it.effect("should keep every game but one still for the first two minutes", () =>
    Effect.gen(function* () {
      const before = yield* at(allStoppedButOne, 0)
      const after = yield* at(allStoppedButOne, 120)

      const moving = before.filter((earlier) => {
        const later = after.find((candidate) => candidate.id === earlier.id)
        return later?.clock !== earlier.clock || later?.status !== earlier.status
      })

      assert.deepStrictEqual(
        moving.map((g) => g.id),
        ["still-aub-ark"]
      )
    })
  )

  describe("kickoff-window", () => {
    it.effect("should have the first game still scheduled at 1:00", () =>
      Effect.gen(function* () {
        const first = yield* game(kickoffWindow, "ko-mia-unc", 60)

        assert.strictEqual(first?.status, "scheduled")
      })
    )

    it.effect("should kick the first game off by 2:00", () =>
      Effect.gen(function* () {
        const first = yield* game(kickoffWindow, "ko-mia-unc", 120)

        assert.strictEqual(first?.status, "live")
      })
    )

    it.effect("should have one of its games in the NFL", () =>
      Effect.gen(function* () {
        const nfl = yield* game(kickoffWindow, "ko-kc-buf", 0)

        assert.strictEqual(nfl?.league, "nfl")
      })
    )
  })
})

/** The slate `seconds` into `script`: its ESPN frames up to then, current through ESPN's decode. */
function at(script: ScenarioScript, seconds: number) {
  const until = DateTime.add(script.origin, { seconds })
  const frames = EspnScript.scenarioOf(script).frames.filter((frame) =>
    DateTime.isLessThanOrEqualTo(frame.receivedAt, until)
  )

  return LiveSlate.use((slate) => slate.latest).pipe(
    Effect.map((current) => current.games(LeagueId.literals)),
    Effect.provide(slateFollowing(frames, { decoder: EspnDecode.layer }))
  )
}

function game(script: ScenarioScript, id: string, seconds: number) {
  return Effect.map(at(script, seconds), (slate) => slate.find((candidate) => candidate.id === id))
}

/** Whether `game` moved the ball for the same team, turned it over, or scored since `previous`, so needs a play. */
function needsPlay(game: GameSnapshot, previous?: ScenarioScript["steps"][number]) {
  const earlier = previous?.slate.find((candidate) => candidate.id === game.id)
  const before = earlier?.situation
  const after = game.situation
  const moved =
    before?.possession !== undefined &&
    after?.possession !== undefined &&
    (before.possession !== after.possession || before.yardLine !== after.yardLine)
  const scored =
    earlier !== undefined &&
    (earlier.home.score !== game.home.score || earlier.away.score !== game.away.score)

  return moved || scored
}
