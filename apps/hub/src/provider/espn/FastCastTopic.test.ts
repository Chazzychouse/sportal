import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Option } from "effect"
import { Owner, ownerOf, topicOf } from "./FastCastTopic.ts"

describe("FastCastTopic.topicOf", () => {
  it.each([
    ["nfl", "event-football-nfl"],
    ["fbs", "event-football-college-football"]
  ] as const)("should name the %s scoreboard's topic", (league, expected) => {
    const topic = topicOf(league)

    assert.strictEqual(topic, expected)
  })

  it.each([
    ["nfl", "401872971", "gp-football-nfl-401872971"],
    ["fbs", "401862787", "gp-football-college-football-401862787"]
  ] as const)(
    "should name %s game %s's package topic after its league's scoreboard topic",
    (league, game, expected) => {
      const topic = topicOf(league, GameId.make(game))

      assert.strictEqual(topic, expected)
    }
  )
})

describe("FastCastTopic.ownerOf", () => {
  it("should own a scoreboard topic by its league's scoreboard", () => {
    const owner = ownerOf("event-football-nfl")

    assert.deepStrictEqual(owner, Option.some(Owner.Scoreboard({ league: "nfl" })))
  })

  it("should own a package topic by its game", () => {
    const owner = ownerOf("gp-football-college-football-401862787")

    assert.deepStrictEqual(owner, Option.some(Owner.Game({ league: "fbs", game: GameId.make("401862787") })))
  })

  it.each([
    ["a package topic without a game", "gp-football-nfl-"],
    ["another sport's scoreboard topic", "event-basketball-nba"]
  ])("should give no owner for %s", (_name, topic) => {
    const owner = ownerOf(topic)

    assert.isTrue(Option.isNone(owner))
  })
})
