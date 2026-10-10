import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { DateTime, Duration, Option, Record, Result } from "effect"
import type { Screen, ScreenCommand } from "../screen/Screen.ts"
import * as TestWeb from "../TestWeb.ts"
import { Autopilot, AutopilotStatus } from "./Autopilot.ts"
import { Decision, MainDecision, StayReason } from "./Decision.ts"

const home = GameId.make("home")
const other = GameId.make("other")
const third = GameId.make("third")
const fourth = GameId.make("fourth")

const redZone = TestWeb.redZone
const live: Moment = { _tag: "Live" }
const final: Moment = { _tag: "Final" }
const timeout: Moment = {
  _tag: "Break",
  reason: "timeout",
  expectedEnd: DateTime.makeUnsafe("2026-10-10T20:01:00Z")
}

const start = DateTime.makeUnsafe("2026-10-10T20:00:00Z")

function at(seconds: number) {
  return DateTime.addDuration(start, Duration.seconds(seconds))
}

/** `games` on tiles in order, in a Quad, the sound on the main tile. */
function screenOf(games: ReadonlyArray<GameId | undefined>): Screen {
  return Result.getOrThrow(TestWeb.withTiles(games).apply({ _tag: "FocusAudio", tile: 0 }, TestWeb.onFox))
}

/** Each game's classification: in its moment, with its score (50 unless given). */
function classified(entries: ReadonlyArray<readonly [GameId, Moment, number?]>) {
  return Record.fromEntries(
    entries.map(([game, moment, score]) => [game, TestWeb.classified(moment, score)] as const)
  )
}

/** `screen` after `commands`, as the Display applies them. */
function after(screen: Screen, commands: ReadonlyArray<ScreenCommand>): Screen {
  return commands.reduce(
    (current, command) => Result.getOrThrow(current.apply(command, TestWeb.onFox)),
    screen
  )
}

const quad = screenOf([home, other, third, fourth])
const on = Autopilot.off.toggle(quad)

/** The autopilot after a first step at the start, with home in plain live play holding the main tile. */
const holding = on.step(
  quad,
  classified([
    [home, live],
    [other, live],
    [third, live],
    [fourth, live]
  ]),
  start
).next

describe("Autopilot.step, the main tile", () => {
  it("should send nothing while off", () => {
    const { commands } = Autopilot.off.step(quad, classified([[home, timeout]]), start)

    assert.deepStrictEqual(commands, [])
  })

  it("should send nothing while the Screen is soloed", () => {
    const soloed = after(quad, [{ _tag: "Solo", tile: 1 }])

    const { commands } = on.step(soloed, classified([[home, timeout]]), start)

    assert.deepStrictEqual(commands, [])
  })

  it("should give back the same autopilot when a step changes nothing", () => {
    const { next } = holding.step(
      quad,
      classified([
        [home, live],
        [other, live],
        [third, live],
        [fourth, live]
      ]),
      at(1)
    )

    assert.strictEqual(next, holding)
  })

  it("should promote the best live game when the main tile's game is on a break", () => {
    const { commands } = on.step(
      quad,
      classified([
        [home, timeout],
        [other, live, 50],
        [third, live, 70],
        [fourth, live, 10]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 2 }])
  })

  it("should promote the best live game into an empty main tile", () => {
    const screen = after(TestWeb.withTiles([undefined, other, third, fourth]), [
      { _tag: "FocusAudio", tile: 2 }
    ])

    const { commands } = on.step(
      screen,
      classified([
        [other, live, 50],
        [third, live, 60],
        [fourth, live, 10]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 2 }])
  })

  it("should promote a benched game", () => {
    const screen = screenOf([home, other, third, fourth, GameId.make("benched")])

    const { commands } = Autopilot.off.toggle(screen).step(
      screen,
      classified([
        [home, timeout],
        [other, final],
        [third, final],
        [fourth, final]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 4 }])
  })

  it("should promote a higher rank once the main tile's game has held it for the dwell", () => {
    const { commands } = holding.step(
      quad,
      classified([
        [home, live],
        [other, redZone],
        [third, live],
        [fourth, live]
      ]),
      at(30)
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })

  it("should wait out the dwell before a higher rank takes the main tile", () => {
    const { commands } = holding.step(
      quad,
      classified([
        [home, live],
        [other, redZone],
        [third, live],
        [fourth, live]
      ]),
      at(10)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should not switch within a rank for a higher score", () => {
    const { commands } = holding.step(
      quad,
      classified([
        [home, live, 40],
        [other, live, 90],
        [third, live],
        [fourth, live]
      ]),
      at(60)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should move nothing when no game is live", () => {
    const { commands } = on.step(
      quad,
      classified([
        [home, timeout],
        [other, timeout],
        [third, final],
        [fourth, { _tag: "Upcoming" }]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should leave the main tile alone while it is yours", () => {
    const yours = holding.manual({ _tag: "Promote", tile: 0 }, start)

    const { commands } = yours.step(
      quad,
      classified([
        [home, timeout],
        [other, redZone],
        [third, live],
        [fourth, live]
      ]),
      at(60)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should rank again once your suspension runs out", () => {
    const promoted = after(quad, [{ _tag: "Promote", tile: 2 }])
    const moments = classified([
      [home, live],
      [other, redZone],
      [third, live],
      [fourth, live]
    ])
    const yours = on.manual({ _tag: "Promote", tile: 2 }, start).step(promoted, moments, at(1)).next

    const { commands } = yours.step(promoted, moments, at(181))

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })
})

describe("Autopilot.step, the sound", () => {
  it("should put the sound on the main tile's game", () => {
    const heardElsewhere = after(quad, [{ _tag: "FocusAudio", tile: 2 }])

    const { commands } = holding.step(
      heardElsewhere,
      classified([
        [home, live],
        [other, live],
        [third, live],
        [fourth, live]
      ]),
      at(1)
    )

    assert.deepStrictEqual(commands, [{ _tag: "FocusAudio", tile: 0 }])
  })

  it("should put the sound back where you put it after a promote while the sound is yours", () => {
    const heard = after(quad, [{ _tag: "FocusAudio", tile: 3 }])
    const yours = holding.manual({ _tag: "FocusAudio", tile: 3 }, start)

    const { commands } = yours.step(
      heard,
      classified([
        [home, timeout],
        [other, live],
        [third, live],
        [fourth, live]
      ]),
      at(1)
    )

    assert.deepStrictEqual(commands, [
      { _tag: "Promote", tile: 1 },
      { _tag: "FocusAudio", tile: 3 }
    ])
  })
})

describe("Autopilot.step, the layout", () => {
  it("should fit the layout before it promotes, and promote on the fitted Screen", () => {
    const { commands } = on.step(
      quad,
      classified([
        [home, timeout],
        [other, redZone],
        [third, final],
        [fourth, final]
      ]),
      at(180)
    )

    assert.deepStrictEqual(commands, [
      { _tag: "SetLayout", layout: "Pair" },
      { _tag: "Promote", tile: 1 }
    ])
  })

  it("should not fit the layout while it is yours", () => {
    const yours = on.manual({ _tag: "SetLayout", layout: "Quad" }, start)

    const { commands } = yours.step(
      quad,
      classified([
        [home, live],
        [other, final],
        [third, final],
        [fourth, final]
      ]),
      at(150)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should not fit the layout for an autopilot kept before it had a ceiling", () => {
    const kept = new Autopilot({ ...on, ceiling: Option.none() })

    const { commands } = kept.step(
      quad,
      classified([
        [home, live],
        [other, final],
        [third, final],
        [fourth, final]
      ]),
      at(180)
    )

    assert.deepStrictEqual(commands, [])
  })
})

describe("Autopilot.step, the decision", () => {
  it("should say it is off", () => {
    const { decision } = Autopilot.off.step(quad, {}, start)

    assert.deepStrictEqual(decision, Decision.Off())
  })

  it("should say it is frozen while the Screen is soloed", () => {
    const soloed = after(quad, [{ _tag: "Solo", tile: 1 }])

    const { decision } = on.step(soloed, {}, start)

    assert.deepStrictEqual(decision, Decision.Frozen())
  })

  it("should say it promoted a game because the main tile's game stopped", () => {
    const { decision } = on.step(
      quad,
      classified([
        [home, timeout],
        [other, live],
        [third, live],
        [fourth, live]
      ]),
      start
    )

    assert.deepStrictEqual(
      Decision.$is("Stepped")(decision) ? decision.main : undefined,
      MainDecision.Promoted({ game: other, over: Option.some(home), why: "stopped" })
    )
  })

  it("should say how long the dwell has left", () => {
    const { decision } = holding.step(
      quad,
      classified([
        [home, live],
        [other, redZone],
        [third, live],
        [fourth, live]
      ]),
      at(10)
    )

    assert.deepStrictEqual(
      Decision.$is("Stepped")(decision) ? decision.main : undefined,
      MainDecision.Stayed({ game: Option.some(home), why: StayReason.Dwell({ left: Duration.seconds(20) }) })
    )
  })
})

describe("Autopilot.manual", () => {
  it("should make the main tile yours when you promote", () => {
    const pilot = on.manual({ _tag: "Promote", tile: 2 }, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.some(at(180)),
      audio: Option.none(),
      layout: Option.none()
    })
  })

  it("should make the main tile and the sound yours when you solo", () => {
    const pilot = on.manual({ _tag: "Solo", tile: 1 }, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.some(at(180)),
      audio: Option.some(at(180)),
      layout: Option.none()
    })
  })

  it("should make the main tile yours when you swap tile 0", () => {
    const pilot = on.manual({ _tag: "Swap", a: 0, b: 2 }, start)

    assert.deepStrictEqual(pilot.suspended.main, Option.some(at(180)))
  })

  it("should make the layout yours when you swap two tiles other than tile 0", () => {
    const pilot = on.manual({ _tag: "Swap", a: 1, b: 2 }, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.none(),
      audio: Option.none(),
      layout: Option.some(at(180))
    })
  })

  it("should make the layout yours when you clear a tile other than tile 0", () => {
    const pilot = on.manual({ _tag: "Clear", tile: 2 }, start)

    assert.deepStrictEqual(pilot.suspended.layout, Option.some(at(180)))
  })

  it("should make the layout yours when you assign a tile other than tile 0", () => {
    const pilot = on.manual({ _tag: "Assign", tile: 2, game: GameId.make("benched") }, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.none(),
      audio: Option.none(),
      layout: Option.some(at(180))
    })
  })

  it("should make only the sound yours when you focus the sound", () => {
    const pilot = on.manual({ _tag: "FocusAudio", tile: 2 }, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.none(),
      audio: Option.some(at(180)),
      layout: Option.none()
    })
  })

  it("should make the layout you set the ceiling", () => {
    const pilot = on.manual({ _tag: "SetLayout", layout: "Pair" }, start)

    assert.deepStrictEqual(pilot.ceiling, Option.some("Pair"))
  })

  it("should make the layout yours when you set it", () => {
    const pilot = on.manual({ _tag: "SetLayout", layout: "Pair" }, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.none(),
      audio: Option.none(),
      layout: Option.some(at(180))
    })
  })

  it("should make nothing yours when you move a divider", () => {
    const pilot = on.manual({ _tag: "SetSplit", split: { x: 0.4, y: 0.5 } }, start)

    assert.deepStrictEqual(pilot.suspended, Autopilot.off.suspended)
  })
})

describe("Autopilot.toggle", () => {
  it("should take the ceiling from the Screen when turned on", () => {
    const pilot = Autopilot.off.toggle(quad)

    assert.deepStrictEqual(pilot.ceiling, Option.some("Quad"))
  })

  it("should forget everything when turned off", () => {
    const off = holding.toggle(quad)

    assert.strictEqual(off, Autopilot.off)
  })
})

describe("Autopilot.nextDeadline", () => {
  it("should give the end of the main tile's dwell", () => {
    const deadline = holding.nextDeadline(at(1), quad, {})

    assert.deepStrictEqual(deadline, Option.some(at(30)))
  })

  it("should give the end of your suspension", () => {
    const pilot = on.manual({ _tag: "FocusAudio", tile: 2 }, start)

    const deadline = pilot.nextDeadline(at(1), quad, {})

    assert.deepStrictEqual(deadline, Option.some(at(180)))
  })

  it("should give the earlier of the main tile's dwell end and your suspension's end", () => {
    const pilot = holding.manual({ _tag: "FocusAudio", tile: 2 }, start)

    const deadline = pilot.nextDeadline(at(1), quad, {})

    assert.deepStrictEqual(deadline, Option.some(at(30)))
  })

  it("should give the end of the hold of a game over on a tile", () => {
    const deadline = on.nextDeadline(at(1), quad, classified([[third, final]]))

    assert.deepStrictEqual(deadline, Option.some(at(120)))
  })

  it("should give no deadline while off", () => {
    const deadline = Autopilot.off.nextDeadline(start, quad, classified([[third, final]]))

    assert.deepStrictEqual(deadline, Option.none())
  })

  it("should give no deadline while it holds no main game and nothing is yours", () => {
    const deadline = on.nextDeadline(start, quad, {})

    assert.deepStrictEqual(deadline, Option.none())
  })
})

describe("Autopilot.status", () => {
  it("should say the main tile is yours until your suspension ends", () => {
    const pilot = on.manual({ _tag: "Promote", tile: 2 }, start)

    const status = pilot.status(at(1), quad, {})

    assert.deepStrictEqual(status, AutopilotStatus.Yours({ part: "main", until: at(180) }))
  })

  it("should say the layout is yours until your suspension ends", () => {
    const paired = after(quad, [{ _tag: "SetLayout", layout: "Pair" }])
    const pilot = on.manual({ _tag: "SetLayout", layout: "Pair" }, start)

    const status = pilot.status(at(1), paired, {})

    assert.deepStrictEqual(status, AutopilotStatus.Yours({ part: "layout", until: at(180) }))
  })

  it("should say which game it follows and its rank", () => {
    const status = on.status(start, quad, classified([[home, redZone]]))

    assert.deepStrictEqual(
      status,
      AutopilotStatus.Following({ game: home, rank: "redZone", fitted: Option.none() })
    )
  })

  it("should say nothing is live when the main tile's game is not", () => {
    const status = on.status(start, quad, classified([[home, timeout]]))

    assert.deepStrictEqual(status, AutopilotStatus.NothingLive({ fitted: Option.none() }))
  })

  it("should say it fitted the layout while the Screen's layout is not the ceiling", () => {
    const paired = after(quad, [{ _tag: "SetLayout", layout: "Pair" }])

    const status = on.status(start, paired, classified([[home, live]]))

    assert.deepStrictEqual(
      status,
      AutopilotStatus.Following({ game: home, rank: "live", fitted: Option.some(2) })
    )
  })
})
