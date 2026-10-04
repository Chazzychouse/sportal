import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Schema } from "effect"
import { Scenario } from "./Scenario.ts"

const drive = Scenario.build("drive", [
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

const game = (id: string, seconds: number, start = drive.origin) =>
  drive.slateAt(start, Duration.seconds(seconds)).find((candidate) => candidate.id === id)

describe("Scenario.build", () => {
  it("makes one frame per distinct offset, in time order", () => {
    assert.deepStrictEqual(
      drive.frames.map((frame) => frame.at),
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
    assert.isFalse(game("1", 0)?.situation?.isRedZone)
    assert.isTrue(game("1", 60)?.situation?.isRedZone)
  })

  it("takes the ball away between plays but keeps the timeouts and the last play", () => {
    const situation = game("1", 120)?.situation
    assert.isUndefined(situation?.possession)
    assert.isFalse(situation?.isRedZone)
    assert.strictEqual(situation?.homeTimeouts, 3)
    assert.strictEqual(situation?.lastPlay, "Field goal is good")
  })

  it("keeps a game scheduled at its kickoff until its first change", () => {
    assert.strictEqual(game("2", 60)?.status, "scheduled")
    assert.strictEqual(game("2", 90)?.status, "live")
    assert.strictEqual(
      DateTime.toEpochMillis(game("2", 0)?.kickoff ?? drive.origin),
      DateTime.toEpochMillis(drive.origin) + 90_000
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

describe("Scenario#slateAt", () => {
  it("moves every instant by the time between the scenario's origin and its start", () => {
    const start = DateTime.makeUnsafe("2026-11-01T18:00:00Z")
    assert.strictEqual(
      DateTime.toEpochMillis(game("2", 0, start)?.kickoff ?? start),
      DateTime.toEpochMillis(start) + 90_000
    )
  })

  it("holds the last frame once the scenario has ended", () => {
    assert.strictEqual(game("1", 60 * 60)?.clock, "0:03")
  })

  it.effect("survives a round trip through JSON", () =>
    Effect.gen(function* () {
      const json = Schema.fromJsonString(Scenario)
      const back = yield* Schema.decodeEffect(json)(yield* Schema.encodeEffect(json)(drive))
      assert.strictEqual(back.frames.length, 5)
      assert.strictEqual(back.slateAt(back.origin, Duration.seconds(60))[0]?.clock, "0:41")
    })
  )
})
