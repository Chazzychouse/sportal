import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Option } from "effect"
import { Topic, tcOf, topicOf } from "./Topic.ts"

describe("Topic.tcOf", () => {
  it.each([
    ["nfl", "event-football-nfl"],
    ["fbs", "event-football-college-football"]
  ] as const)("should name the %s scoreboard's topic", (league, expected) => {
    const tc = tcOf(Topic.Scoreboard({ league }))

    assert.strictEqual(tc, expected)
  })

  it.each([
    ["nfl", "401872971", "gp-football-nfl-401872971"],
    ["fbs", "401862787", "gp-football-college-football-401862787"]
  ] as const)(
    "should name %s game %s's package topic after its league's scoreboard topic",
    (league, game, expected) => {
      const tc = tcOf(Topic.Game({ league, game: GameId.make(game) }))

      assert.strictEqual(tc, expected)
    }
  )
})

describe("Topic.topicOf", () => {
  it("should read a scoreboard topic as its league's scoreboard", () => {
    const topic = topicOf("event-football-nfl")

    assert.deepStrictEqual(topic, Option.some(Topic.Scoreboard({ league: "nfl" })))
  })

  it("should read a package topic as its game", () => {
    const topic = topicOf("gp-football-college-football-401862787")

    assert.deepStrictEqual(topic, Option.some(Topic.Game({ league: "fbs", game: GameId.make("401862787") })))
  })

  it.each([
    ["a package topic without a game", "gp-football-nfl-"],
    ["another sport's scoreboard topic", "event-basketball-nba"]
  ])("should read no topic from %s", (_name, tc) => {
    const topic = topicOf(tc)

    assert.isTrue(Option.isNone(topic))
  })
})
