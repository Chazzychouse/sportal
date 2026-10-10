import { assert, describe, it } from "@effect/vitest"
import type { Classification } from "@sportal/domain/Classification"
import { GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { PlayId } from "@sportal/domain/Play"
import { DateTime, Result } from "effect"
import * as TestWeb from "../TestWeb.ts"
import { Autopilot } from "./Autopilot.ts"

const home = GameId.make("home")
const other = GameId.make("other")
const third = GameId.make("third")
const fourth = GameId.make("fourth")

const quad = Result.getOrThrow(
  TestWeb.withTiles([home, other, third, fourth]).apply({ _tag: "FocusAudio", tile: 0 }, TestWeb.onFox)
)
const on = Autopilot.off.toggle(quad)

const live = TestWeb.classified({ _tag: "Live" })
const redZone = TestWeb.classified(TestWeb.redZone)
const crunch = TestWeb.classified({ _tag: "CrunchTime", margin: 3, secondsLeft: 100 })
const final = TestWeb.classified({ _tag: "Final" })
const touchdownBreak = TestWeb.classified({
  _tag: "Break",
  reason: "afterScore",
  expectedEnd: DateTime.makeUnsafe("2026-10-10T20:03:00Z"),
  after: { play: PlayId.make("9"), kind: "touchdown" }
} satisfies Moment)
const timeout = TestWeb.classified(TestWeb.timeout)

/** Each of the four games' classifications, in tile order. */
function games(a: Classification, b: Classification, c: Classification, d: Classification) {
  return [
    [home, a],
    [other, b],
    [third, c],
    [fourth, d]
  ] as const
}

describe("the autopilot over a game day", () => {
  it("should hand a touchdown's break off to a game in live play", () => {
    const frames = TestWeb.timeline(quad, on, [
      { at: 0, classifications: games(live, live, live, live) },
      { at: 40, classifications: games(touchdownBreak, live, live, live) }
    ])

    assert.deepStrictEqual(
      frames.map(({ main }) => main),
      [home, other]
    )
  })

  it("should hold a red zone through its dwell before a higher rank takes over", () => {
    const frames = TestWeb.timeline(quad, on, [
      { at: 0, classifications: games(live, live, live, live) },
      { at: 31, classifications: games(live, crunch, live, live) },
      { at: 45, classifications: games(live, crunch, redZone, live) },
      { at: 61, classifications: games(live, crunch, redZone, live) }
    ])

    assert.deepStrictEqual(
      frames.map(({ main }) => main),
      [home, other, other, third]
    )
  })

  it("should take crunch time over live play but not over a red zone", () => {
    const frames = TestWeb.timeline(quad, on, [
      { at: 0, classifications: games(redZone, crunch, live, live) },
      { at: 40, classifications: games(redZone, crunch, live, live) },
      { at: 41, classifications: games(live, crunch, live, live) }
    ])

    assert.deepStrictEqual(
      frames.map(({ main }) => main),
      [home, home, other]
    )
  })

  it("should leave your promote for three minutes, then rank again", () => {
    const frames = TestWeb.timeline(quad, on, [
      { at: 0, classifications: games(live, live, redZone, live), command: { _tag: "Promote", tile: 1 } },
      { at: 60, classifications: games(live, live, redZone, live) },
      { at: 181, classifications: games(live, live, redZone, live) }
    ])

    assert.deepStrictEqual(
      frames.map(({ main }) => main),
      [other, other, third]
    )
  })

  it("should leave the main tile as it is when nothing is live", () => {
    const frames = TestWeb.timeline(quad, on, [
      { at: 0, classifications: games(live, live, live, live) },
      { at: 10, classifications: games(timeout, timeout, final, final) }
    ])

    assert.deepStrictEqual(
      frames.map(({ main }) => main),
      [home, home]
    )
  })

  it("should shrink the layout when a finished game's hold runs out", () => {
    const frames = TestWeb.timeline(quad, on, [
      { at: 0, classifications: games(live, live, final, final) },
      { at: 121, classifications: games(live, live, final, final) }
    ])

    assert.deepStrictEqual(
      frames.map(({ layout }) => layout),
      ["Quad", "Pair"]
    )
  })
})
