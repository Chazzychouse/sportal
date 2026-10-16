import { assert, describe, it } from "@effect/vitest"
import { League } from "./League.ts"

describe("League.of", () => {
  it("should give the NFL the sport of football", () => {
    const league = League.of("nfl")

    assert.strictEqual(league.sport, "football")
  })

  it("should give MLB the sport of baseball", () => {
    const league = League.of("mlb")

    assert.strictEqual(league.sport, "baseball")
  })

  it("should name FBS as people say it", () => {
    const league = League.of("fbs")

    assert.strictEqual(league.name, "College Football")
  })
})
