import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Option } from "effect"
import * as FastCastMessage from "./FastCastMessage.ts"

// How each document follows its frames is tested through EspnDecode, which reads what the documents say.
describe("FastCastMessage", () => {
  it("names each league's scoreboard topic", () => {
    assert.strictEqual(FastCastMessage.topic("nfl"), "event-football-nfl")
    assert.strictEqual(FastCastMessage.topic("fbs"), "event-football-college-football")
  })

  it("names each game's package topic after its league's scoreboard topic", () => {
    assert.strictEqual(FastCastMessage.topic("nfl", GameId.make("401872971")), "gp-football-nfl-401872971")
    assert.strictEqual(
      FastCastMessage.topic("fbs", GameId.make("401862787")),
      "gp-football-college-football-401862787"
    )
  })

  it("owns each topic by its league's scoreboard or one game, and no other", () => {
    assert.deepStrictEqual(
      FastCastMessage.owner("event-football-nfl"),
      Option.some(FastCastMessage.Owner.Scoreboard({ league: "nfl" }))
    )
    assert.deepStrictEqual(
      FastCastMessage.owner("gp-football-college-football-401862787"),
      Option.some(FastCastMessage.Owner.Game({ league: "fbs", game: GameId.make("401862787") }))
    )
    assert.isTrue(Option.isNone(FastCastMessage.owner("gp-football-nfl-")))
    assert.isTrue(Option.isNone(FastCastMessage.owner("event-basketball-nba")))
  })
})
