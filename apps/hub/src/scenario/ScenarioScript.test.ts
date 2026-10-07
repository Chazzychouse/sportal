import { assert, describe, it } from "@effect/vitest"
import { TeamId } from "@sportal/domain/Team"
import { DateTime } from "effect"
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

const afterTouchdown = ScenarioScript.build("after touchdown", [
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
          ball: { team: "away", yardLine: 20, down: 1, distance: 10 }
        }
      ],
      ["0:30", { clock: "14:30", score: [0, 6], ball: null, play: { kind: "pass", yards: 20 } }],
      ["1:00", { clock: "14:30", score: [0, 7], ball: null, play: { kind: "extraPoint", yards: 0 } }]
    ]
  }
])

describe("ScenarioScript.build after the ball goes dead", () => {
  const extraPoint = afterTouchdown.steps.find((step) => step.at === 60_000)?.plays[0]?.play

  it("gives a play with no ball before it the team whose score rose", () => {
    assert.strictEqual(extraPoint?.kind, "extraPoint")
    assert.strictEqual(extraPoint?.team, "fbs:ALA")
    assert.isTrue(extraPoint?.scoring)
    assert.deepStrictEqual(extraPoint?.end, { team: ala })
  })

  it("gives it no spots", () => {
    assert.isUndefined(extraPoint?.start.yardsToEndzone)
    assert.isUndefined(extraPoint?.start.down)
    assert.isUndefined(extraPoint?.start.distance)
  })
})

const twoGames = ScenarioScript.build("two games", [
  {
    id: "1",
    home: "UGA",
    away: "ALA",
    network: "CBS",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 4,
          clock: "2:10",
          score: [24, 24],
          ball: { team: "home", yardLine: 75, down: 1, distance: 10 }
        }
      ],
      ["1:00", { clock: "0:41", ball: { team: "home", yardLine: 17, down: 1, distance: 10 } }],
      // Out of order on purpose: changes apply in time order whatever order they are written in.
      ["0:30", { clock: "1:30" }],
      ["2:00", { clock: "0:03", score: [27, 24], ball: null, lastPlay: "Field goal is good" }]
    ]
  },
  {
    id: "2",
    home: "TEX",
    away: "OU",
    kickoff: "1:30",
    timeline: [["1:30", { status: "live", period: 1, clock: "15:00" }]]
  }
])

describe("ScenarioScript.build, as slates", () => {
  it("makes one step per distinct offset, in time order", () => {
    assert.deepStrictEqual(
      twoGames.steps.map((step) => step.at),
      [0, 30_000, 60_000, 90_000, 120_000]
    )
  })

  it("merges each change onto the game as it was before it", () => {
    const tie = game("1", 60)
    assert.strictEqual(tie?.clock, "0:41")
    assert.strictEqual(tie?.home.score, 24)
    assert.strictEqual(tie?.period, 4)
    assert.strictEqual(tie?.situation?.possession, "fbs:UGA")
    assert.strictEqual(tie?.situation?.down, 1)
  })

  it("marks the red zone from the yard line", () => {
    assert.isFalse(game("1", 0)?.situation?.inRedZone())
    assert.isTrue(game("1", 60)?.situation?.inRedZone())
  })

  it("takes the ball away between plays but keeps the timeouts and the last play", () => {
    const situation = game("1", 120)?.situation
    assert.isUndefined(situation?.possession)
    assert.isFalse(situation?.inRedZone())
    assert.strictEqual(situation?.homeTimeouts, 3)
    assert.strictEqual(situation?.lastPlay, "Field goal is good")
  })

  it("keeps a game scheduled at its kickoff until its first change", () => {
    assert.strictEqual(game("2", 60)?.status, "scheduled")
    assert.strictEqual(game("2", 90)?.status, "live")
    assert.strictEqual(
      DateTime.toEpochMillis(game("2", 0)?.kickoff ?? twoGames.origin),
      DateTime.toEpochMillis(twoGames.origin) + 90_000
    )
  })

  it("lists the networks it is given", () => {
    assert.deepStrictEqual(
      game("1", 0)?.broadcasts.map((broadcast) => broadcast.network),
      ["CBS"]
    )
    assert.deepStrictEqual(game("2", 0)?.broadcasts, [])
  })
})

/** Game `id` in the slate of `twoGames`'s latest step by `seconds`. */
function game(id: string, seconds: number) {
  return twoGames.steps
    .findLast((step) => step.at <= seconds * 1000)
    ?.slate.find((candidate) => candidate.id === id)
}
