import { assert, describe, it } from "@effect/vitest"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { Game, GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { PlayId } from "@sportal/domain/Play"
import { Slate } from "@sportal/domain/Slate"
import { snapshot } from "@sportal/domain/TestGame"
import { DateTime, Option, Record, Result } from "effect"
import * as TestWeb from "../TestWeb.ts"
import { Prompts } from "./Prompts.ts"

const home = GameId.make("home")
const other = GameId.make("other")
const third = GameId.make("third")
const fourth = GameId.make("fourth")
const fifth = GameId.make("fifth")

const live: Moment = { _tag: "Live" }
const crunch: Moment = { _tag: "CrunchTime", margin: 3, secondsLeft: 100 }
const bigPlay: Moment = { _tag: "BigPlay", play: PlayId.make("play"), kind: "longGain" }
const later = DateTime.makeUnsafe("2026-10-10T20:05:00Z")

/** The live state of these games, each live on the slate in order, classified in its moment with its score (50 unless given), on FOX unless given. */
function liveOf(
  entries: ReadonlyArray<readonly [GameId, Moment, number?, (() => ReadonlyArray<ChannelAvailability>)?]>
) {
  return {
    slate: new Slate({ games: entries.map(([game]) => Game.of(snapshot({ id: game, status: "live" }))) }),
    availability: Record.fromEntries(
      entries.map(([game, , , availability]) => [game, (availability ?? TestWeb.onFox)()] as const)
    ),
    classifications: Record.fromEntries(
      entries.map(([game, moment, score]) => [game, TestWeb.classified(moment, score)] as const)
    )
  }
}

const pair = TestWeb.fill([home, other])
const full = TestWeb.fill([home, other, third, fourth])

describe("Prompts.prompt", () => {
  it("should prompt a red-zone game on no tile into the first empty slot", () => {
    const state = liveOf([
      [home, live],
      [other, live],
      [third, TestWeb.redZone]
    ])

    const prompt = Prompts.initial.prompt(pair, state)

    assert.deepStrictEqual(
      Option.map(prompt, ({ game, rank, target, replaces }) => ({ game, rank, target, replaces })),
      Option.some({ game: third, rank: "redZone" as const, target: 2, replaces: Option.none() })
    )
  })

  it("should prompt a crunch-time game", () => {
    const state = liveOf([
      [home, live],
      [other, live],
      [third, crunch]
    ])

    const prompt = Prompts.initial.prompt(pair, state)

    assert.deepStrictEqual(
      Option.map(prompt, ({ rank }) => rank),
      Option.some("crunchTime" as const)
    )
  })

  it("should not prompt a big play", () => {
    const state = liveOf([
      [home, live],
      [other, live],
      [third, bigPlay]
    ])

    const prompt = Prompts.initial.prompt(pair, state)

    assert.isTrue(Option.isNone(prompt))
  })

  it("should not prompt a game already on screen", () => {
    const state = liveOf([
      [home, TestWeb.redZone],
      [other, live]
    ])

    const prompt = Prompts.initial.prompt(pair, state)

    assert.isTrue(Option.isNone(prompt))
  })

  it("should not prompt a benched game", () => {
    const benched = Result.getOrThrow(
      TestWeb.fill([home, other, undefined, undefined]).apply(
        { _tag: "SetLayout", layout: "Single" },
        TestWeb.onFox
      )
    )
    const state = liveOf([
      [home, live],
      [other, TestWeb.redZone]
    ])

    const prompt = Prompts.initial.prompt(benched, state)

    assert.isTrue(Option.isNone(prompt))
  })

  it("should not prompt a game no source can stream", () => {
    const state = liveOf([
      [home, live],
      [other, live],
      [third, TestWeb.redZone, 50, TestWeb.nowhere]
    ])

    const prompt = Prompts.initial.prompt(pair, state)

    assert.isTrue(Option.isNone(prompt))
  })

  it("should not prompt a red zone over a red zone on a full screen", () => {
    const state = liveOf([
      [home, TestWeb.redZone],
      [other, TestWeb.redZone],
      [third, TestWeb.redZone],
      [fourth, TestWeb.redZone],
      [fifth, TestWeb.redZone, 90]
    ])

    const prompt = Prompts.initial.prompt(full, state)

    assert.isTrue(Option.isNone(prompt))
  })

  it("should prompt over the weakest game on a full screen and name it", () => {
    const state = liveOf([
      [home, live],
      [other, TestWeb.timeout],
      [third, live],
      [fourth, live],
      [fifth, TestWeb.redZone]
    ])

    const prompt = Prompts.initial.prompt(full, state)

    assert.deepStrictEqual(
      Option.map(prompt, ({ target, replaces }) => ({ target, replaces })),
      Option.some({ target: 1, replaces: Option.some({ game: other, rank: "break" as const }) })
    )
  })

  it("should prompt the better of two candidates by rank", () => {
    const sixth = GameId.make("sixth")
    const state = liveOf([
      [home, live],
      [other, live],
      [fifth, crunch, 90],
      [sixth, TestWeb.redZone, 10]
    ])

    const prompt = Prompts.initial.prompt(pair, state)

    assert.deepStrictEqual(
      Option.map(prompt, ({ game }) => game),
      Option.some(sixth)
    )
  })

  it("should prompt the higher score of two candidates in one rank", () => {
    const sixth = GameId.make("sixth")
    const state = liveOf([
      [home, live],
      [other, live],
      [fifth, TestWeb.redZone, 40],
      [sixth, TestWeb.redZone, 80]
    ])

    const prompt = Prompts.initial.prompt(pair, state)

    assert.deepStrictEqual(
      Option.map(prompt, ({ game }) => game),
      Option.some(sixth)
    )
  })

  it("should not prompt while off", () => {
    const state = liveOf([
      [home, live],
      [other, live],
      [third, TestWeb.redZone]
    ])

    const prompt = Prompts.initial.toggle().prompt(pair, state)

    assert.isTrue(Option.isNone(prompt))
  })

  it("should not prompt while the Screen is soloed", () => {
    const state = liveOf([
      [home, live],
      [other, live],
      [third, TestWeb.redZone]
    ])

    const prompt = Prompts.initial.prompt(TestWeb.soloed([home, other], 0), state)

    assert.isTrue(Option.isNone(prompt))
  })
})

describe("Prompts.dismiss", () => {
  const state = liveOf([
    [home, live],
    [other, live],
    [third, TestWeb.redZone]
  ])

  it("should keep a dismissed game quiet for its moment", () => {
    const prompts = Option.match(Prompts.initial.prompt(pair, state), {
      onNone: () => Prompts.initial,
      onSome: (prompt) => Prompts.initial.dismiss(prompt, state.classifications)
    })

    const prompt = prompts.prompt(pair, state)

    assert.isTrue(Option.isNone(prompt))
  })

  it("should prompt a dismissed game again in a new moment", () => {
    const first = Option.getOrThrow(Prompts.initial.prompt(pair, state))
    const prompts = Prompts.initial.dismiss(first, state.classifications)
    const again = {
      ...state,
      classifications: { ...state.classifications, [third]: TestWeb.classified(TestWeb.redZone, 50, later) }
    }

    const prompt = prompts.prompt(pair, again)

    assert.deepStrictEqual(
      Option.map(prompt, ({ game }) => game),
      Option.some(third)
    )
  })

  it("should drop a dismissal whose game's moment has changed", () => {
    const fifthState = liveOf([
      [home, live],
      [other, live],
      [fifth, TestWeb.redZone]
    ])
    const first = Option.match(Prompts.initial.prompt(pair, state), {
      onNone: () => Prompts.initial,
      onSome: (prompt) => Prompts.initial.dismiss(prompt, state.classifications)
    })
    const moved: typeof fifthState.classifications = {
      ...fifthState.classifications,
      [third]: TestWeb.classified(live, 50, later)
    }

    const second = Option.match(first.prompt(pair, fifthState), {
      onNone: () => first,
      onSome: (prompt) => first.dismiss(prompt, moved)
    })

    assert.deepStrictEqual(Object.keys(second.dismissed), [fifth])
  })
})
