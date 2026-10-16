import { assert, describe, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { GameSnapshot } from "./Game.ts"
import { BallSpot, Situation } from "./Situation.ts"
import * as TestGame from "./TestGame.ts"
import { baseballSituation, team } from "./TestGame.ts"

describe("FootballSituation#inRedZone", () => {
  it("should be in the red zone at the 20", () => {
    const atTwenty = TestGame.situation({ yardLine: 20 })

    assert.isTrue(atTwenty.inRedZone())
  })

  it("should be in the red zone inside the 20", () => {
    const atThree = TestGame.situation({ yardLine: 3 })

    assert.isTrue(atThree.inRedZone())
  })

  it("should not be in the red zone at the 21", () => {
    const atTwentyOne = TestGame.situation({ yardLine: 21 })

    assert.isFalse(atTwentyOne.inRedZone())
  })

  it("should not be in the red zone with no yard line", () => {
    const noYardLine = TestGame.situation({ yardLine: undefined })

    assert.isFalse(noYardLine.inRedZone())
  })

  it("should decode a snapshot stored with isRedZone, its red zone its yard line's", () => {
    const stored = Schema.encodeSync(GameSnapshot)(
      TestGame.liveSnapshot({ situation: TestGame.situation({ yardLine: 35 }) })
    )

    const decoded = Schema.decodeUnknownSync(GameSnapshot)({
      ...stored,
      situation: { ...stored.situation, isRedZone: true }
    })

    assert.isTrue(decoded.situation !== undefined && Situation.guards.Football(decoded.situation))
    assert.isFalse(
      decoded.situation !== undefined &&
        Situation.guards.Football(decoded.situation) &&
        decoded.situation.inRedZone()
    )
  })
})

describe("FootballSituation#goalToGo", () => {
  it("should be goal to go when the distance reaches the yard line", () => {
    const atGoal = TestGame.situation({ yardLine: 4, distance: 4 })

    assert.isTrue(atGoal.goalToGo())
  })

  it("should not be goal to go when the distance falls short of the yard line", () => {
    const shortOfGoal = TestGame.situation({ yardLine: 12, distance: 10 })

    assert.isFalse(shortOfGoal.goalToGo())
  })
})

describe("BallSpot.of", () => {
  const game = { home: { team: team("H") }, away: { team: team("A") } }

  it.each([
    ["home", 75, 25, "away"],
    ["away", 75, 75, "home"],
    ["home", 1, 99, "away"],
    ["away", 1, 1, "home"],
    ["home", 99, 1, "away"]
  ] as const)(
    "should put %s with %d to go at %d yards from the home goal, going %s",
    (side, toGo, yards, toward) => {
      const spot = BallSpot.of(game, { team: game[side].team.id, yardsToEndzone: toGo })

      assert.deepStrictEqual(spot, Option.some(new BallSpot({ yards, toward })))
    }
  )

  it("should be none without a team", () => {
    assert.isTrue(Option.isNone(BallSpot.of(game, { yardsToEndzone: 40 })))
  })

  it("should be none without a yard line", () => {
    assert.isTrue(Option.isNone(BallSpot.of(game, { team: game.home.team.id })))
  })

  it("should be none for a team in neither side", () => {
    assert.isTrue(Option.isNone(BallSpot.of(game, { team: team("X").id, yardsToEndzone: 40 })))
  })

  it.each([
    ["home", 105],
    ["home", -3],
    ["away", 105],
    ["away", -3]
  ] as const)("should be none for %s at %d yards to the goal, off the field", (side, yardsToEndzone) => {
    assert.isTrue(Option.isNone(BallSpot.of(game, { team: game[side].team.id, yardsToEndzone })))
  })
})

describe("FootballSituation#ball", () => {
  const game = { home: { team: team("H") }, away: { team: team("A") } }

  it("should be the spot of the team with the ball at its yard line", () => {
    const football = TestGame.situation({ possession: game.home.team.id, yardLine: 75 })

    assert.deepStrictEqual(football.ball(game), Option.some(new BallSpot({ yards: 25, toward: "away" })))
  })

  it("should be none without a team with the ball", () => {
    const football = TestGame.situation({ possession: undefined })

    assert.isTrue(Option.isNone(football.ball(game)))
  })
})

describe("Situation.order", () => {
  it("should put the bottom of an inning after its top", () => {
    const top = baseballSituation({ half: "top", outs: 2 })
    const bottom = baseballSituation({ half: "bottom", outs: 0 })

    const order = Situation.order(bottom, top)

    assert.strictEqual(order, 1)
  })

  it("should put more outs later in the same half", () => {
    const one = baseballSituation({ outs: 1 })
    const two = baseballSituation({ outs: 2 })

    const order = Situation.order(two, one)

    assert.strictEqual(order, 1)
  })

  it("should tie two football situations", () => {
    const a = TestGame.situation({ down: 1 })
    const b = TestGame.situation({ down: 3 })

    const order = Situation.order(a, b)

    assert.strictEqual(order, 0)
  })
})
