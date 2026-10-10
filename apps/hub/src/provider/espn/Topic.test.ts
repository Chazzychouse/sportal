import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Option } from "effect"
import { Topic } from "./Topic.ts"

describe("Topic#tc", () => {
  it.each([
    ["nfl", "401872971", "gp-football-nfl-401872971"],
    ["fbs", "401858254", "gp-football-college-football-401858254"]
  ] as const)("should name %s game %s's package topic", (league, game, expected) => {
    const topic = new Topic({ league, game: GameId.make(game) })

    const tc = topic.tc()

    assert.strictEqual(tc, expected)
  })
})

describe("Topic.fromTc", () => {
  it("should read a package topic as its game", () => {
    const topic = Topic.fromTc("gp-football-college-football-401858254")

    assert.deepStrictEqual(topic, Option.some(new Topic({ league: "fbs", game: GameId.make("401858254") })))
  })

  it.each([
    ["a package topic without a game", "gp-football-nfl-"],
    ["a scoreboard topic", "event-football-nfl"],
    ["another sport's package topic", "gp-basketball-nba-401"]
  ])("should read no topic from %s", (_name, tc) => {
    const topic = Topic.fromTc(tc)

    assert.isTrue(Option.isNone(topic))
  })
})
