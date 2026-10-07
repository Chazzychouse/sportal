import { assert, describe, it } from "@effect/vitest"
import { ExtraPoint, PlayId, Rush } from "@sportal/domain/Play"
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
          play: { _tag: "Rush", touchdown: false, yards: 4 }
        }
      ],
      [
        "1:00",
        {
          clock: "14:00",
          ball: { team: "away", yardLine: 80, down: 1, distance: 10 },
          play: { _tag: "Punt", return: "none", yards: 51 }
        }
      ],
      [
        "1:30",
        {
          clock: "13:20",
          score: [0, 7],
          ball: null,
          play: { _tag: "Completion", touchdown: true, yards: 80, text: "Touchdown pass" }
        }
      ]
    ]
  }
])

const playAt = (at: number) => drive.steps.find((step) => step.at === at)?.plays[0]?.play

describe("ScenarioScript.build", () => {
  it("should write a play from the ball before the change to the ball after it", () => {
    const rush = playAt(30_000)

    assert.deepStrictEqual(
      rush,
      new Rush({
        id: PlayId.make("1-1"),
        sequence: 1,
        period: 1,
        clock: "14:30",
        text: "Rush for 4 yards",
        scoring: false,
        homeScore: 0,
        awayScore: 0,
        start: { yardsToEndzone: 75, down: 1, distance: 10, team: uga },
        end: { yardsToEndzone: 71, down: 2, distance: 6, team: uga },
        team: uga,
        yards: 4,
        touchdown: false
      })
    )
  })

  it("should use the play's text as the last play when the change gives none", () => {
    const step = drive.steps.find(({ at }) => at === 30_000)

    assert.strictEqual(step?.slate[0]?.situation?.lastPlay, "Rush for 4 yards")
  })

  it("should write a play that changes possession with different teams at its start and its end", () => {
    const punt = playAt(60_000)

    assert.deepStrictEqual([punt?.sequence, punt?.start.team, punt?.end.team], [2, uga, ala])
  })

  it("should write a scoring play with the new scores, and only its team at its end when the ball goes dead", () => {
    const touchdown = playAt(90_000)

    assert.deepStrictEqual(
      [touchdown?._tag, touchdown?.scoring, touchdown?.homeScore, touchdown?.awayScore, touchdown?.end],
      ["Completion", true, 0, 7, { team: ala }]
    )
  })

  it("should write a play's own text when the change gives one", () => {
    const touchdown = playAt(90_000)

    assert.strictEqual(touchdown?.text, "Touchdown pass")
  })

  it("should write each play with its game and league", () => {
    const step = drive.steps.find(({ at }) => at === 30_000)

    assert.deepStrictEqual(
      step?.plays.map(({ game, league }) => [game, league]),
      [["1", "fbs"]]
    )
  })

  it("should write no plays for a step with no play", () => {
    assert.deepStrictEqual(drive.steps[0]?.plays, [])
  })

  it("should make one step per offset of a play", () => {
    assert.deepStrictEqual(
      drive.steps.map(({ at }) => at),
      [0, 30_000, 60_000, 90_000]
    )
  })

  it.each([
    { play: { _tag: "Rush", touchdown: false }, sentence: "Rush for 4 yards" },
    { play: { _tag: "Rush", touchdown: true }, sentence: "Rush for 4 yards" },
    { play: { _tag: "Completion", touchdown: false }, sentence: "Pass complete for 4 yards" },
    { play: { _tag: "Completion", touchdown: true }, sentence: "Pass complete for 4 yards" },
    { play: { _tag: "Incompletion" }, sentence: "Pass incomplete" },
    { play: { _tag: "Interception", return: "none" }, sentence: "Pass intercepted" },
    { play: { _tag: "Interception", return: "returned" }, sentence: "Pass intercepted and returned" },
    {
      play: { _tag: "Interception", return: "touchdown" },
      sentence: "Pass intercepted and returned for a touchdown"
    },
    { play: { _tag: "Sack", fumbleLost: false }, sentence: "Sacked for a loss of 4 yards" },
    {
      play: { _tag: "Sack", fumbleLost: true },
      sentence: "Sacked for a loss of 4 yards, fumble recovered by the defense"
    },
    { play: { _tag: "Fumble", recovery: "unknown" }, sentence: "Fumble" },
    { play: { _tag: "Fumble", recovery: "own" }, sentence: "Fumble, recovered by the offense" },
    { play: { _tag: "Fumble", recovery: "opponent" }, sentence: "Fumble, recovered by the defense" },
    { play: { _tag: "Fumble", recovery: "touchdown" }, sentence: "Fumble returned for a touchdown" },
    { play: { _tag: "TwoPointTry", by: "pass" }, sentence: "Two-point conversion, passed" },
    { play: { _tag: "TwoPointTry", by: "rush" }, sentence: "Two-point conversion, run" },
    { play: { _tag: "Kickoff", returnTouchdown: false }, sentence: "Kickoff for 4 yards" },
    { play: { _tag: "Kickoff", returnTouchdown: true }, sentence: "Kickoff returned for a touchdown" },
    { play: { _tag: "Punt", return: "none" }, sentence: "Punt for 4 yards" },
    { play: { _tag: "Punt", return: "returned" }, sentence: "Punt for 4 yards, returned" },
    { play: { _tag: "Punt", return: "touchdown" }, sentence: "Punt for 4 yards, returned for a touchdown" },
    { play: { _tag: "FieldGoal", result: "good" }, sentence: "Field goal from 4 yards" },
    { play: { _tag: "FieldGoal", result: "missed" }, sentence: "Field goal from 4 yards, missed" },
    { play: { _tag: "FieldGoal", result: "blocked" }, sentence: "Field goal blocked" },
    { play: { _tag: "ExtraPoint", good: true }, sentence: "Extra point is good" },
    { play: { _tag: "ExtraPoint", good: false }, sentence: "Extra point is no good" },
    { play: { _tag: "Safety" }, sentence: "Safety" },
    { play: { _tag: "Penalty" }, sentence: "Penalty for 4 yards" }
  ] as const)("should give each case and outcome a sentence: $sentence", ({ play, sentence }) => {
    const script = ScenarioScript.build("sentence", [
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
          ["0:30", { clock: "14:30", play: { ...play, yards: 4 } }]
        ]
      }
    ])

    const written = script.steps.at(-1)?.plays[0]?.play

    assert.strictEqual(written?.text, sentence)
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
      [
        "0:30",
        {
          clock: "14:30",
          score: [0, 6],
          ball: null,
          play: { _tag: "Completion", touchdown: true, yards: 20 }
        }
      ],
      [
        "1:00",
        { clock: "14:30", score: [0, 7], ball: null, play: { _tag: "ExtraPoint", good: true, yards: 0 } }
      ]
    ]
  }
])

describe("ScenarioScript.build after the ball goes dead", () => {
  const extraPoint = afterTouchdown.steps.find((step) => step.at === 60_000)?.plays[0]?.play

  it("should give a play with no ball before it the team whose score rose", () => {
    assert.instanceOf(extraPoint, ExtraPoint)
    assert.strictEqual(extraPoint.team, ala)
  })

  it("should write it as scoring, its team at its end", () => {
    assert.deepStrictEqual([extraPoint?.scoring, extraPoint?.end], [true, { team: ala }])
  })

  it("should give it no spot but its team's at its start", () => {
    assert.deepStrictEqual(extraPoint?.start, { team: ala })
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
  it("should make one step per distinct offset, in time order", () => {
    assert.deepStrictEqual(
      twoGames.steps.map((step) => step.at),
      [0, 30_000, 60_000, 90_000, 120_000]
    )
  })

  it("should merge each change onto the game as it was before it", () => {
    const tie = game("1", 60)

    assert.deepStrictEqual(
      [tie?.clock, tie?.home.score, tie?.period, tie?.situation?.possession, tie?.situation?.down],
      ["0:41", 24, 4, "fbs:UGA", 1]
    )
  })

  it("should not mark the red zone outside the 20", () => {
    assert.isFalse(game("1", 0)?.situation?.inRedZone())
  })

  it("should mark the red zone from the yard line", () => {
    assert.isTrue(game("1", 60)?.situation?.inRedZone())
  })

  it("should take the ball away between plays but keep the timeouts and the last play", () => {
    const situation = game("1", 120)?.situation

    assert.deepStrictEqual(
      [situation?.possession, situation?.inRedZone(), situation?.homeTimeouts, situation?.lastPlay],
      [undefined, false, 3, "Field goal is good"]
    )
  })

  it("should keep a game scheduled until its first change", () => {
    assert.deepStrictEqual([game("2", 60)?.status, game("2", 90)?.status], ["scheduled", "live"])
  })

  it("should schedule a game at its kickoff", () => {
    const kickoff = game("2", 0)?.kickoff ?? twoGames.origin

    assert.strictEqual(DateTime.toEpochMillis(kickoff), DateTime.toEpochMillis(twoGames.origin) + 90_000)
  })

  it("should list the networks it is given", () => {
    assert.deepStrictEqual(
      game("1", 0)?.broadcasts.map((broadcast) => broadcast.network),
      ["CBS"]
    )
  })

  it("should list no networks when it is given none", () => {
    assert.deepStrictEqual(game("2", 0)?.broadcasts, [])
  })
})

/** Game `id` in the slate of `twoGames`'s latest step by `seconds`. */
function game(id: string, seconds: number) {
  return twoGames.steps
    .findLast((step) => step.at <= seconds * 1000)
    ?.slate.find((candidate) => candidate.id === id)
}
