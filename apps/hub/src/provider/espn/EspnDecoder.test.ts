import { assert, describe, it } from "@effect/vitest"
import { LeagueId } from "@sportal/domain/League"
import { Record } from "effect"
import * as EspnDecoder from "./EspnDecoder.ts"

describe("EspnDecoder.byLeague", () => {
  it("should have a decoder for every league", () => {
    const leagues = Record.keys(EspnDecoder.byLeague)

    assert.deepStrictEqual(leagues, [...LeagueId.literals])
  })
})
