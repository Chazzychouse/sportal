import { assert, describe, it } from "@effect/vitest"
import { DateTime, Equal } from "effect"
import { GameId } from "./Game.ts"
import { GameEvent, GameEventKind } from "./GameEvent.ts"
import { TeamId } from "./Team.ts"

const game = GameId.make("1")
const team = TeamId.make("HOME")
const at = DateTime.makeUnsafe("2026-10-03T16:00:00Z")

describe("GameEvent", () => {
  it("should be equal to another with the same game, instant, and kind", () => {
    const same = stamp(DateTime.makeUnsafe("2026-10-03T16:00:00Z"))

    assert.isTrue(Equal.equals(stamp(at), same))
  })

  it("should not be equal to another at a different instant", () => {
    const later = stamp(DateTime.add(at, { seconds: 1 }))

    assert.isFalse(Equal.equals(stamp(at), later))
  })
})

function stamp(when: DateTime.Utc) {
  return new GameEvent({ game, at: when, what: GameEventKind.ScoreChanged({ team, points: 7 }) })
}
