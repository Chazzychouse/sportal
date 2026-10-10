import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { DateTime, Duration, Option, Record, Result } from "effect"
import type { LayoutName, Screen, ScreenCommand } from "../screen/Screen.ts"
import * as TestWeb from "../TestWeb.ts"
import { fit, nextFit } from "./Fit.ts"

const [a, b, c, d, e, f] = ["a", "b", "c", "d", "e", "f"].map((id) => GameId.make(id)) as [
  GameId,
  GameId,
  GameId,
  GameId,
  GameId,
  GameId
]

const live: Moment = { _tag: "Live" }
const final: Moment = { _tag: "Final" }
const upcoming: Moment = { _tag: "Upcoming" }

const start = DateTime.makeUnsafe("2026-10-10T20:00:00Z")

function at(seconds: number) {
  return DateTime.addDuration(start, Duration.seconds(seconds))
}

/** Every hold of a game over at the start has run out. */
const later = at(180)

/** `games` on tiles in order, in `layout`. */
function screenOf(games: ReadonlyArray<GameId | undefined>, layout: LayoutName = "Quad"): Screen {
  return Result.getOrThrow(TestWeb.withTiles(games).apply({ _tag: "SetLayout", layout }, TestWeb.onFox))
}

function classified(entries: ReadonlyArray<readonly [GameId, Moment]>) {
  return Record.fromEntries(entries.map(([game, moment]) => [game, TestWeb.classified(moment)] as const))
}

/** `screen` after `commands`, as the Display applies them. */
function after(screen: Screen, commands: ReadonlyArray<ScreenCommand>): Screen {
  return commands.reduce(
    (current, command) => Result.getOrThrow(current.apply(command, TestWeb.onFox)),
    screen
  )
}

function onScreen(screen: Screen) {
  return screen.onScreen().map((tile) => (tile._tag === "Empty" ? undefined : tile.game))
}

describe("fit", () => {
  it("should shrink to a Single when only the main tile's game is in progress", () => {
    const screen = screenOf([a, b, c, d])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, final],
        [c, final],
        [d, final]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "SetLayout", layout: "Single" }])
  })

  it("should shrink to a Pair when two games are in progress", () => {
    const screen = screenOf([a, b, c, d])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, live],
        [c, final],
        [d, final]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "SetLayout", layout: "Pair" }])
  })

  it("should keep a game that is over on screen until its hold runs out", () => {
    const screen = screenOf([a, b, c, d])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, final],
        [c, final],
        [d, final]
      ]),
      at(60)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should not count a game that has not started", () => {
    const screen = screenOf([a, b, c, d])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, upcoming],
        [c, upcoming],
        [d, upcoming]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "SetLayout", layout: "Single" }])
  })

  it("should count a game with no classification", () => {
    const screen = screenOf([a, b, c, d])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [c, final],
        [d, final]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "SetLayout", layout: "Pair" }])
  })

  it("should grow back to the ceiling as games start", () => {
    const screen = screenOf([a, b, c, d], "Single")

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, live],
        [c, live],
        [d, live]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "SetLayout", layout: "Quad" }])
  })

  it("should never grow past the ceiling", () => {
    const screen = screenOf([a, b, c, d, e], "Pair")

    const commands = fit(
      screen,
      "Pair",
      classified([
        [a, live],
        [b, live],
        [c, live],
        [d, live],
        [e, live]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should go back to the ceiling when no game is worth showing", () => {
    const screen = screenOf([a, b], "Single")

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, final],
        [b, final]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "SetLayout", layout: "Quad" }])
  })

  it("should shrink a MainFive through its own ladder to a MainThree", () => {
    const screen = screenOf([a, b, c, d, e, f], "MainFive")

    const commands = fit(
      screen,
      "MainFive",
      classified([
        [a, live],
        [b, live],
        [c, live],
        [d, final],
        [e, final],
        [f, final]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "SetLayout", layout: "MainThree" }])
  })

  it("should leave a game that is over in the main tile", () => {
    const screen = screenOf([a, b, c, d])

    const fitted = after(
      screen,
      fit(
        screen,
        "Quad",
        classified([
          [a, final],
          [b, live],
          [c, final],
          [d, final]
        ]),
        later
      )
    )

    assert.deepStrictEqual(onScreen(fitted), [a, b])
  })

  it("should move a game in progress into a kept slot before it shrinks", () => {
    const screen = screenOf([a, b, c, d])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, final],
        [c, final],
        [d, live]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [
      { _tag: "Swap", a: 1, b: 3 },
      { _tag: "SetLayout", layout: "Pair" }
    ])
  })

  it("should fill a slot holding a game that is over with a benched game in progress", () => {
    const screen = screenOf([a, b, c, d, e])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, live],
        [c, final],
        [d, live],
        [e, live]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [{ _tag: "Swap", a: 2, b: 4 }])
  })

  it("should not reshuffle when more games are in progress than the ceiling has slots", () => {
    const screen = screenOf([a, b, c, d, e, f])

    const commands = fit(
      screen,
      "Quad",
      classified([
        [a, live],
        [b, live],
        [c, live],
        [d, live],
        [e, live],
        [f, live]
      ]),
      later
    )

    assert.deepStrictEqual(commands, [])
  })
})

describe("nextFit", () => {
  it("should give the end of the hold of a game that is over", () => {
    const screen = screenOf([a, b])

    const next = nextFit(
      screen,
      classified([
        [a, live],
        [b, final]
      ]),
      at(30)
    )

    assert.deepStrictEqual(next, Option.some(at(120)))
  })

  it("should give nothing once every hold has run out", () => {
    const screen = screenOf([a, b])

    const next = nextFit(
      screen,
      classified([
        [a, live],
        [b, final]
      ]),
      later
    )

    assert.deepStrictEqual(next, Option.none())
  })
})
