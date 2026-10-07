import { assert, describe, it } from "@effect/vitest"
import { DateTime, Equal } from "effect"
import { GameId } from "./Game.ts"
import { GameEvent, GameEventKind } from "./GameEvent.ts"
import { TeamId } from "./Team.ts"

const game = GameId.make("1")
const team = TeamId.make("HOME")
const at = DateTime.makeUnsafe("2026-10-03T16:00:00Z")

describe("GameEvent", () => {
  it("is equal to another with the same game, instant, and kind", () => {
    const stamp = (when: DateTime.Utc) =>
      new GameEvent({ game, at: when, what: GameEventKind.ScoreChanged({ team, points: 7 }) })
    assert.isTrue(Equal.equals(stamp(at), stamp(DateTime.makeUnsafe("2026-10-03T16:00:00Z"))))
    assert.isFalse(Equal.equals(stamp(at), stamp(DateTime.add(at, { seconds: 1 }))))
  })
})
