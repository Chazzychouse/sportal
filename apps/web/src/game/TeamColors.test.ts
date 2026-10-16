import { assert, describe, it } from "@effect/vitest"
import { Team } from "@sportal/domain/Team"
import { snapshot, team } from "@sportal/domain/TestGame"
import * as TeamColors from "./TeamColors.ts"

describe("TeamColors.teamHalf", () => {
  it("should paint a half from the team's color to a darker one, the away half leaning the other way", () => {
    const chiefs = colored("E31837")

    const half = TeamColors.teamHalf(chiefs, "away")

    assert.strictEqual(half, "linear-gradient(160deg, #e31837, color-mix(in oklab, #e31837 55%, black))")
  })

  it("should paint a team too dark to see in its alternate color", () => {
    const bears = colored("0B162A", "C83803")

    const half = TeamColors.teamHalf(bears, "home")

    assert.strictEqual(half, "linear-gradient(200deg, #c83803, color-mix(in oklab, #c83803 55%, black))")
  })

  it("should lighten a team too dark to see that has no alternate color", () => {
    const navy = colored("0B162A")

    const half = TeamColors.teamHalf(navy, "home")

    assert.strictEqual(half, "linear-gradient(200deg, #545c6a, color-mix(in oklab, #545c6a 55%, black))")
  })

  it("should lighten a team whose alternate color is too dark as well", () => {
    const night = colored("0B162A", "000000")

    const half = TeamColors.teamHalf(night, "home")

    assert.strictEqual(half, "linear-gradient(200deg, #545c6a, color-mix(in oklab, #545c6a 55%, black))")
  })

  it("should paint a team with no color in graphite", () => {
    const plain = team("ZZZ", "nfl")

    const half = TeamColors.teamHalf(plain, "home")

    assert.strictEqual(half, "linear-gradient(200deg, #3a3d44, color-mix(in oklab, #3a3d44 55%, black))")
  })

  it("should paint a team whose color does not read as six hex digits in graphite", () => {
    const odd = colored("red")

    const half = TeamColors.teamHalf(odd, "home")

    assert.strictEqual(half, "linear-gradient(200deg, #3a3d44, color-mix(in oklab, #3a3d44 55%, black))")
  })
})

describe("TeamColors.teamEdge", () => {
  it("should split the edge between the away team's color above and the home team's below", () => {
    const game = snapshot({
      away: { team: colored("E31837"), score: 0 },
      home: { team: colored("00338D"), score: 0 }
    })

    const edge = TeamColors.teamEdge(game)

    assert.strictEqual(edge, "linear-gradient(#e31837 50%, #00338d 50%)")
  })
})

function colored(color: string, alternateColor?: string): Team {
  const plain = team("TM", "nfl")
  return alternateColor === undefined
    ? new Team({ ...plain, color })
    : new Team({ ...plain, color, alternateColor })
}
