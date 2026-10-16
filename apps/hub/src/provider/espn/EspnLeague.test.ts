import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Option } from "effect"
import { EspnLeague } from "./EspnLeague.ts"

describe("EspnLeague", () => {
  it("should poll every FBS game on the college scoreboard", () => {
    const fbs = EspnLeague.of("fbs").pipe(Option.getOrThrow)

    const url = fbs.scoreboardUrl(Option.none())

    assert.strictEqual(
      url,
      "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300"
    )
  })

  it("should ask the scoreboard for a day as ESPN spells it", () => {
    const nfl = EspnLeague.of("nfl").pipe(Option.getOrThrow)

    const url = nfl.scoreboardUrl(Option.some("2026-10-04"))

    assert.strictEqual(
      url,
      "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20261004"
    )
  })

  it("should read a game topic back to its league and game", () => {
    const read = EspnLeague.ofTopic("gp-football-nfl-401872971")

    assert.deepStrictEqual(
      Option.map(read, ({ league, game }) => [league.league, game]),
      Option.some(["nfl", GameId.make("401872971")])
    )
  })

  it("should not follow a league ESPN does not serve the Hub yet", () => {
    const mlb = EspnLeague.of("mlb")

    assert.isTrue(Option.isNone(mlb))
  })
})
