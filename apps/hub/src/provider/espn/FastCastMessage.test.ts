import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Option } from "effect"
import * as FastCastMessage from "./FastCastMessage.ts"

// How each document follows its frames is tested through EspnDecode, which reads what the documents say.
describe("FastCastMessage.topic", () => {
  it.each([
    ["nfl", "event-football-nfl"],
    ["fbs", "event-football-college-football"]
  ] as const)("should name the %s scoreboard's topic", (league, expected) => {
    const topic = FastCastMessage.topic(league)

    assert.strictEqual(topic, expected)
  })

  it.each([
    ["nfl", "401872971", "gp-football-nfl-401872971"],
    ["fbs", "401862787", "gp-football-college-football-401862787"]
  ] as const)(
    "should name %s game %s's package topic after its league's scoreboard topic",
    (league, game, expected) => {
      const topic = FastCastMessage.topic(league, GameId.make(game))

      assert.strictEqual(topic, expected)
    }
  )
})

describe("FastCastMessage.owner", () => {
  it("should own a scoreboard topic by its league's scoreboard", () => {
    const owner = FastCastMessage.owner("event-football-nfl")

    assert.deepStrictEqual(owner, Option.some(FastCastMessage.Owner.Scoreboard({ league: "nfl" })))
  })

  it("should own a package topic by its game", () => {
    const owner = FastCastMessage.owner("gp-football-college-football-401862787")

    assert.deepStrictEqual(
      owner,
      Option.some(FastCastMessage.Owner.Game({ league: "fbs", game: GameId.make("401862787") }))
    )
  })

  it.each([
    ["a package topic without a game", "gp-football-nfl-"],
    ["another sport's scoreboard topic", "event-basketball-nba"]
  ])("should give no owner for %s", (_name, topic) => {
    const owner = FastCastMessage.owner(topic)

    assert.isTrue(Option.isNone(owner))
  })
})
