import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { DateTime, Duration, Option, Record, Result } from "effect"
import type { Screen, ScreenCommand } from "../screen/Screen.ts"
import * as TestWeb from "../TestWeb.ts"
import { Autopilot, AutopilotStatus } from "./Autopilot.ts"

const home = GameId.make("home")
const other = GameId.make("other")
const third = GameId.make("third")
const fourth = GameId.make("fourth")
const benched = GameId.make("benched")

const redZone = TestWeb.redZone
const crunch: Moment = { _tag: "CrunchTime", margin: 3, secondsLeft: 100 }
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

/** A Quad holding `games` in order, past the fourth benched, the sound on the main tile. */
function screenOf(games: ReadonlyArray<GameId>): Screen {
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

function gamesIn(screen: Screen) {
  return screen.tiles.map((tile) => (tile._tag === "Empty" ? undefined : tile.game))
}

const quad = screenOf([home, other, third, fourth])
const on = Autopilot.off.toggle(quad)

/** The autopilot away on `other` since the start, in `moment`, and the Screen after it went. */
function awayOnOther(moment: Moment = redZone) {
  const [pilot, commands] = on.step(
    quad,
    classified([
      [home, live],
      [other, moment]
    ]),
    start
  )
  return { pilot, screen: after(quad, commands) }
}

describe("Autopilot.step", () => {
  it("should fit the layout before it promotes, and promote on the fitted Screen", () => {
    const [, commands] = on.step(
      quad,
      classified([
        [home, live],
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
    const pilot = on.manual({ _tag: "SetLayout", layout: "Quad" }, quad, start)

    const [, commands] = pilot.step(
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

  it("should send nothing while off", () => {
    const [, commands] = Autopilot.off.step(
      quad,
      classified([
        [home, live],
        [other, redZone]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should give back the same autopilot when a step changes nothing", () => {
    const [pilot] = on.step(
      quad,
      classified([
        [home, live],
        [other, live]
      ]),
      start
    )

    assert.strictEqual(pilot, on)
  })

  it("should send nothing while the Screen is soloed", () => {
    const soloed = after(quad, [{ _tag: "Solo", tile: 1 }])

    const [, commands] = on.step(
      soloed,
      classified([
        [home, live],
        [other, redZone]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should promote a red zone on another tile while home is live", () => {
    const [, commands] = on.step(
      quad,
      classified([
        [home, live],
        [other, redZone]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })

  it("should stay home while home is in the red zone itself", () => {
    const [, commands] = on.step(
      quad,
      classified([
        [home, redZone, 10],
        [other, redZone, 90]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should stay home while home is live and no other game is in a red zone or crunch time", () => {
    const [, commands] = on.step(
      quad,
      classified([
        [home, live],
        [other, live]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should promote a benched game in the red zone", () => {
    const screen = screenOf([home, other, third, fourth, benched])

    const [, commands] = Autopilot.off.toggle(screen).step(
      screen,
      classified([
        [home, live],
        [benched, redZone]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 4 }])
  })

  it("should leave home on a break for a game in plain live play", () => {
    const [, commands] = on.step(
      quad,
      classified([
        [home, timeout],
        [other, live]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })

  it("should pick the higher score of two red zones", () => {
    const [, commands] = on.step(
      quad,
      classified([
        [home, live],
        [other, redZone, 40],
        [third, redZone, 80]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 2 }])
  })

  it("should pick a red zone over crunch time, whatever their scores", () => {
    const [, commands] = on.step(
      quad,
      classified([
        [home, live],
        [other, crunch, 90],
        [third, redZone, 10]
      ]),
      start
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 2 }])
  })

  it("should hold the away game through its dwell though its red zone is over", () => {
    const { pilot, screen } = awayOnOther()

    const [, commands] = pilot.step(
      screen,
      classified([
        [home, live],
        [other, live]
      ]),
      at(10)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should go home within the dwell when the away game goes to a break", () => {
    const { pilot, screen } = awayOnOther()

    const [, commands] = pilot.step(
      screen,
      classified([
        [home, live],
        [other, timeout]
      ]),
      at(10)
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })

  it("should go home once the dwell is out and the red zone is over", () => {
    const { pilot, screen } = awayOnOther()

    const [, commands] = pilot.step(
      screen,
      classified([
        [home, live],
        [other, live]
      ]),
      at(31)
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })

  it("should put every tile back where it was when it goes home", () => {
    const { pilot, screen } = awayOnOther()

    const [, commands] = pilot.step(
      screen,
      classified([
        [home, live],
        [other, live]
      ]),
      at(31)
    )

    assert.deepStrictEqual(gamesIn(after(screen, commands)), gamesIn(quad))
  })

  it("should put the sound back on home's sound game when it goes home", () => {
    const heard = after(quad, [{ _tag: "FocusAudio", tile: 2 }])
    const [pilot, went] = Autopilot.off.toggle(heard).step(
      heard,
      classified([
        [home, live],
        [other, redZone]
      ]),
      start
    )
    const away = after(heard, went)

    const [, commands] = pilot.step(
      away,
      classified([
        [home, live],
        [other, live]
      ]),
      at(31)
    )

    assert.deepStrictEqual(commands, [
      { _tag: "Promote", tile: 1 },
      { _tag: "FocusAudio", tile: 2 }
    ])
  })

  it("should not hand a red zone off to another red zone", () => {
    const { pilot, screen } = awayOnOther()

    const [, commands] = pilot.step(
      screen,
      classified([
        [home, live],
        [other, redZone, 50],
        [third, redZone, 99]
      ]),
      at(40)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should not replace a red zone with crunch time", () => {
    const { pilot, screen } = awayOnOther()

    const [, commands] = pilot.step(
      screen,
      classified([
        [home, live],
        [other, redZone],
        [third, crunch]
      ]),
      at(40)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should not replace an away game within its dwell, even for a red zone", () => {
    const { pilot, screen } = awayOnOther(crunch)

    const [, commands] = pilot.step(
      screen,
      classified([
        [home, live],
        [other, crunch],
        [third, redZone]
      ]),
      at(10)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should hand crunch time off to a red zone through home once the dwell is out", () => {
    const { pilot, screen } = awayOnOther(crunch)

    const [, commands] = pilot.step(
      screen,
      classified([
        [home, live],
        [other, crunch],
        [third, redZone]
      ]),
      at(31)
    )

    assert.deepStrictEqual(commands, [
      { _tag: "Promote", tile: 1 },
      { _tag: "Promote", tile: 2 }
    ])
  })

  it("should hold an away game that loses its classification through its dwell", () => {
    const { pilot, screen } = awayOnOther()

    const [, commands] = pilot.step(screen, classified([[home, live]]), at(10))

    assert.deepStrictEqual(commands, [])
  })

  it("should go home once the dwell is out when home enters a red zone and the away game is in crunch time", () => {
    const { pilot, screen } = awayOnOther(crunch)

    const [, commands] = pilot.step(
      screen,
      classified([
        [home, redZone],
        [other, crunch]
      ]),
      at(31)
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })

  it("should keep a red zone away when home enters a red zone too", () => {
    const { pilot, screen } = awayOnOther()

    const [, commands] = pilot.step(
      screen,
      classified([
        [home, redZone],
        [other, redZone]
      ]),
      at(31)
    )

    assert.deepStrictEqual(commands, [])
  })

  it("should put every tile back where it was when it goes home after handing off to another away game", () => {
    const { pilot, screen } = awayOnOther(crunch)
    const [handedOff, toThird] = pilot.step(
      screen,
      classified([
        [home, live],
        [other, crunch],
        [third, redZone]
      ]),
      at(31)
    )
    const onThird = after(screen, toThird)

    const [, commands] = handedOff.step(
      onThird,
      classified([
        [home, live],
        [other, live],
        [third, live]
      ]),
      at(62)
    )

    assert.deepStrictEqual(gamesIn(after(onThird, commands)), gamesIn(quad))
  })

  it("should keep the sound where you put it when it hands off to another away game", () => {
    const heard = after(quad, [{ _tag: "FocusAudio", tile: 3 }])
    const [pilot, went] = on.manual({ _tag: "FocusAudio", tile: 3 }, heard, start).step(
      heard,
      classified([
        [home, live],
        [other, crunch]
      ]),
      at(1)
    )
    const away = after(heard, went)

    const [, commands] = pilot.step(
      away,
      classified([
        [home, live],
        [other, crunch],
        [third, redZone]
      ]),
      at(32)
    )

    assert.deepStrictEqual(after(away, commands).audioFocus, Option.some(fourth))
  })
})

describe("Autopilot.manual", () => {
  const promoted = after(quad, [{ _tag: "Promote", tile: 2 }])
  const yours = on.manual({ _tag: "Promote", tile: 2 }, promoted, start)

  it("should make the game you promote home", () => {
    const main = yours.home.main

    assert.deepStrictEqual(main, Option.some(third))
  })

  it("should move only the sound while the main tile is yours", () => {
    const [, commands] = yours.step(
      promoted,
      classified([
        [third, live],
        [other, redZone]
      ]),
      at(10)
    )

    assert.deepStrictEqual(commands, [{ _tag: "FocusAudio", tile: 1 }])
  })

  it("should follow with the main tile again once your suspension is out", () => {
    const [, commands] = yours.step(
      promoted,
      classified([
        [third, live],
        [other, redZone]
      ]),
      at(181)
    )

    assert.deepStrictEqual(commands, [{ _tag: "Promote", tile: 1 }])
  })

  it("should keep the sound where you put it when it promotes", () => {
    const heard = after(quad, [{ _tag: "FocusAudio", tile: 2 }])
    const pilot = on.manual({ _tag: "FocusAudio", tile: 2 }, heard, start)

    const [, commands] = pilot.step(
      heard,
      classified([
        [home, live],
        [other, redZone],
        [third, live]
      ]),
      at(10)
    )

    assert.deepStrictEqual(commands, [
      { _tag: "Promote", tile: 1 },
      { _tag: "FocusAudio", tile: 2 }
    ])
  })

  it("should keep home while away when your command does not suspend", () => {
    const { pilot, screen } = awayOnOther()
    const laidOut = after(screen, [{ _tag: "SetLayout", layout: "Pair" }])

    const next = pilot.manual({ _tag: "SetLayout", layout: "Pair" }, laidOut, at(5))

    assert.deepStrictEqual(next.home.main, Option.some(home))
  })

  it("should end a revert with the sound where you put it while away", () => {
    const { pilot, screen } = awayOnOther()
    const heard = after(screen, [{ _tag: "FocusAudio", tile: 2 }])
    const yoursToo = pilot.manual({ _tag: "FocusAudio", tile: 2 }, heard, at(5))

    const [, commands] = yoursToo.step(
      heard,
      classified([
        [home, live],
        [other, live]
      ]),
      at(31)
    )

    assert.deepStrictEqual(commands, [
      { _tag: "Promote", tile: 1 },
      { _tag: "FocusAudio", tile: 2 }
    ])
  })

  it("should put the sound back on home's sound game when the main tile is no longer yours and nothing is worth chasing", () => {
    const [soundAway, toOther] = yours.step(
      promoted,
      classified([
        [third, live],
        [other, redZone]
      ]),
      at(10)
    )
    const heard = after(promoted, toOther)

    const [, commands] = soundAway.step(
      heard,
      classified([
        [third, live],
        [other, live]
      ]),
      at(181)
    )

    assert.deepStrictEqual(commands, [{ _tag: "FocusAudio", tile: 0 }])
  })

  it("should make both the main tile and the sound yours when you solo", () => {
    const soloed = after(quad, [{ _tag: "Solo", tile: 1 }])

    const pilot = on.manual({ _tag: "Solo", tile: 1 }, soloed, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.some(at(180)),
      audio: Option.some(at(180)),
      layout: Option.none()
    })
  })

  it("should make the main tile yours when you swap tile 0", () => {
    const swapped = after(quad, [{ _tag: "Swap", a: 0, b: 2 }])

    const pilot = on.manual({ _tag: "Swap", a: 0, b: 2 }, swapped, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.some(at(180)),
      audio: Option.none(),
      layout: Option.none()
    })
  })

  it("should make only the sound yours when you focus the sound", () => {
    const focused = after(quad, [{ _tag: "FocusAudio", tile: 1 }])

    const pilot = on.manual({ _tag: "FocusAudio", tile: 1 }, focused, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.none(),
      audio: Option.some(at(180)),
      layout: Option.none()
    })
  })

  it("should make the layout yours when you swap two tiles other than tile 0", () => {
    const swapped = after(quad, [{ _tag: "Swap", a: 1, b: 2 }])

    const pilot = on.manual({ _tag: "Swap", a: 1, b: 2 }, swapped, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.none(),
      audio: Option.none(),
      layout: Option.some(at(180))
    })
  })

  it("should make the layout yours when you assign a tile other than tile 0", () => {
    const assigned = after(quad, [{ _tag: "Assign", tile: 2, game: benched }])

    const pilot = on.manual({ _tag: "Assign", tile: 2, game: benched }, assigned, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.none(),
      audio: Option.none(),
      layout: Option.some(at(180))
    })
  })

  it("should make the layout you set home's", () => {
    const paired = after(quad, [{ _tag: "SetLayout", layout: "Pair" }])

    const pilot = on.manual({ _tag: "SetLayout", layout: "Pair" }, paired, start)

    assert.deepStrictEqual(pilot.home.layout, Option.some("Pair"))
  })

  it("should make the layout yours when you set it", () => {
    const paired = after(quad, [{ _tag: "SetLayout", layout: "Pair" }])

    const pilot = on.manual({ _tag: "SetLayout", layout: "Pair" }, paired, start)

    assert.deepStrictEqual(pilot.suspended, {
      main: Option.none(),
      audio: Option.none(),
      layout: Option.some(at(180))
    })
  })
})

describe("Autopilot.toggle", () => {
  it("should take home from the Screen when turned on", () => {
    const pilot = Autopilot.off.toggle(quad)

    assert.deepStrictEqual(pilot.home, {
      main: Option.some(home),
      audio: Option.some(home),
      layout: Option.some("Quad")
    })
  })

  it("should forget the away game when turned off", () => {
    const { pilot, screen } = awayOnOther()

    const off = pilot.toggle(screen)

    assert.isTrue(Option.isNone(off.away.main))
  })
})

describe("Autopilot.nextDeadline", () => {
  it("should give the end of the hold of a game over on a tile", () => {
    const deadline = on.nextDeadline(at(1), quad, classified([[third, final]]))

    assert.deepStrictEqual(deadline, Option.some(at(120)))
  })

  it("should give the end of the away game's dwell", () => {
    const { pilot } = awayOnOther()

    const deadline = pilot.nextDeadline(at(1), quad, {})

    assert.deepStrictEqual(deadline, Option.some(at(30)))
  })

  it("should give the end of your suspension", () => {
    const pilot = on.manual({ _tag: "Promote", tile: 2 }, after(quad, [{ _tag: "Promote", tile: 2 }]), start)

    const deadline = pilot.nextDeadline(at(1), quad, {})

    assert.deepStrictEqual(deadline, Option.some(at(180)))
  })

  it("should give the earlier of an away game's dwell end and your suspension's end", () => {
    const { pilot, screen } = awayOnOther()
    const focused = after(screen, [{ _tag: "FocusAudio", tile: 2 }])
    const yours = pilot.manual({ _tag: "FocusAudio", tile: 2 }, focused, start)

    const deadline = yours.nextDeadline(at(1), quad, {})

    assert.deepStrictEqual(deadline, Option.some(at(30)))
  })

  it("should give no deadline while it has nothing away and nothing yours", () => {
    const deadline = on.nextDeadline(start, quad, {})

    assert.deepStrictEqual(deadline, Option.none())
  })
})

describe("Autopilot.status", () => {
  it("should say the main tile is yours until your suspension ends", () => {
    const pilot = on.manual({ _tag: "Promote", tile: 2 }, after(quad, [{ _tag: "Promote", tile: 2 }]), start)

    const status = pilot.status(at(1), quad)

    assert.deepStrictEqual(status, AutopilotStatus.Yours({ part: "main", until: at(180) }))
  })

  it("should say the layout is yours until your suspension ends", () => {
    const paired = after(quad, [{ _tag: "SetLayout", layout: "Pair" }])
    const pilot = on.manual({ _tag: "SetLayout", layout: "Pair" }, paired, start)

    const status = pilot.status(at(1), paired)

    assert.deepStrictEqual(status, AutopilotStatus.Yours({ part: "layout", until: at(180) }))
  })

  it("should say it fitted the layout while the Screen's layout is not home's", () => {
    const paired = after(quad, [{ _tag: "SetLayout", layout: "Pair" }])

    const status = on.status(start, paired)

    assert.deepStrictEqual(status, AutopilotStatus.Fitted({ slots: 2 }))
  })
})
