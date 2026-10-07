import { assert, describe, it } from "@effect/vitest"
import { TeamId } from "@sportal/domain/Team"
import { ScenarioScript } from "./ScenarioScript.ts"

const uga = TeamId.make("fbs:UGA")
const ala = TeamId.make("fbs:ALA")

const drive = ScenarioScript.build("drive", [
  {
    id: "1",
    home: "UGA",
    away: "ALA",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 1,
          clock: "15:00",
          ball: { team: "home", yardLine: 75, down: 1, distance: 10 }
        }
      ],
      [
        "0:30",
        {
          clock: "14:30",
          ball: { team: "home", yardLine: 71, down: 2, distance: 6 },
          play: { kind: "rush", yards: 4 }
        }
      ],
      [
        "1:00",
        {
          clock: "14:00",
          ball: { team: "away", yardLine: 80, down: 1, distance: 10 },
          play: { kind: "punt", yards: 51 }
        }
      ],
      [
        "1:30",
        {
          clock: "13:20",
          score: [0, 7],
          ball: null,
          play: { kind: "pass", yards: 80, text: "Touchdown pass" }
        }
      ]
    ]
  }
])

const playAt = (at: number) => drive.steps.find((step) => step.at === at)?.plays[0]?.play

describe("ScenarioScript.build", () => {
  it("writes a play from the ball before the change to the ball after it", () => {
    const rush = playAt(30_000)
    assert.strictEqual(rush?.id, "1-1")
    assert.strictEqual(rush?.sequence, 1)
    assert.strictEqual(rush?.kind, "rush")
    assert.strictEqual(rush?.yards, 4)
    assert.strictEqual(rush?.team, "fbs:UGA")
    assert.deepStrictEqual(rush?.start, { team: uga, yardsToEndzone: 75, down: 1, distance: 10 })
    assert.deepStrictEqual(rush?.end, { team: uga, yardsToEndzone: 71, down: 2, distance: 6 })
    assert.strictEqual(rush?.text, "Rush for 4 yards")
    assert.strictEqual(rush?.period, 1)
    assert.strictEqual(rush?.clock, "14:30")
    assert.isFalse(rush?.scoring)
  })

  it("uses the play's text as the last play when the change gives none", () => {
    const step = drive.steps.find(({ at }) => at === 30_000)
    assert.strictEqual(step?.slate[0]?.situation?.lastPlay, "Rush for 4 yards")
  })

  it("writes a play that changes possession with different teams at its start and its end", () => {
    const punt = playAt(60_000)
    assert.strictEqual(punt?.sequence, 2)
    assert.strictEqual(punt?.start.team, "fbs:UGA")
    assert.strictEqual(punt?.end.team, "fbs:ALA")
    assert.notStrictEqual(punt?.start.team, punt?.end.team)
  })

  it("writes a scoring play with the new scores, and only its team at its end when the ball goes dead", () => {
    const touchdown = playAt(90_000)
    assert.isTrue(touchdown?.scoring)
    assert.strictEqual(touchdown?.homeScore, 0)
    assert.strictEqual(touchdown?.awayScore, 7)
    assert.strictEqual(touchdown?.text, "Touchdown pass")
    assert.deepStrictEqual(touchdown?.end, { team: ala })
  })

  it("writes each play with its game and league", () => {
    const step = drive.steps.find(({ at }) => at === 30_000)
    assert.deepStrictEqual(
      step?.plays.map(({ game, league }) => [game, league]),
      [["1", "fbs"]]
    )
  })

  it("writes no plays for a step with no play", () => {
    assert.deepStrictEqual(drive.steps[0]?.plays, [])
    assert.deepStrictEqual(
      drive.steps.map(({ at }) => at),
      [0, 30_000, 60_000, 90_000]
    )
  })
})
