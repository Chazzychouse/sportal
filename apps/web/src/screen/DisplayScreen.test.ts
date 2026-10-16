import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import type { GameList } from "@sportal/api/GamesQuery"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { GameId } from "@sportal/domain/Game"
import { highlight, snapshot } from "@sportal/domain/TestGame"
import { Array as Arr, Effect, Option, Result } from "effect"
import { Atom } from "effect/reactivity"
import { vi } from "vitest"
import * as Games from "../hub/Games.ts"
import * as TestWeb from "../TestWeb.ts"
import * as DisplayScreen from "./DisplayScreen.ts"
import { Screen, Tile } from "./Screen.ts"

describe("DisplayScreen.screen", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should assign a game as today's list says it is available", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const screen = yield* Effect.gen(function* () {
        yield* Atom.mount(Games.today)
        yield* TestWeb.answer(hub, "games", hub.lists, listOf([onEspn]))
        yield* TestWeb.until(Games.today, ({ value }) => Option.isSome(value))

        yield* Atom.set(DisplayScreen.screen, { _tag: "Assign", tile: 0, game: id })
        return yield* Atom.get(DisplayScreen.screen)
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(screen.tiles[0], { _tag: "StreamTile", game: id, channel: espn })
    })
  )

  it.effect("should publish a refused command's rejection and keep the Screen", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      const [before, after, rejected] = yield* Effect.gen(function* () {
        const before = yield* Atom.get(DisplayScreen.screen)

        yield* Atom.set(DisplayScreen.screen, { _tag: "Clear", tile: 9 })
        const after = yield* Atom.get(DisplayScreen.screen)
        const rejected = yield* Atom.get(DisplayScreen.rejected)
        return [before, after, rejected] as const
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(after, before)
      assert.deepStrictEqual(
        Option.map(rejected, ({ reason }) => reason),
        Option.some("no-such-tile")
      )
    })
  )

  it.effect("should refresh a tile when today's list brings its game a stream", () =>
    Effect.gen(function* () {
      const { registry, hub } = yield* TestWeb.withShell()

      const screen = yield* Effect.gen(function* () {
        yield* Atom.mount(Games.today)
        yield* TestWeb.answer(hub, "games", hub.lists, listOf([]))
        yield* TestWeb.until(Games.today, ({ value }) => Option.isSome(value))
        yield* Atom.set(DisplayScreen.screen, { _tag: "Assign", tile: 0, game: id })

        yield* TestWeb.answer(hub, "games", hub.lists, listOf([onEspn]))
        return yield* TestWeb.until(DisplayScreen.screen, (screen) =>
          Option.exists(Arr.get(screen.tiles, 0), Tile.guards.StreamTile)
        )
      }).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(screen.tiles[0], { _tag: "StreamTile", game: id, channel: espn })
    })
  )

  it.effect("should start from the Screen this browser kept", () =>
    Effect.gen(function* () {
      const kept = new Screen({ ...Screen.initial, layout: "Pair" })
      yield* TestWeb.keep(kept)
      const { registry } = yield* TestWeb.withShell()

      const screen = yield* Atom.get(DisplayScreen.screen).pipe(Effect.scoped, Effect.provide(registry))

      assert.strictEqual(screen.layout, "Pair")
    })
  )

  it.effect("should start with an empty tile where the kept Screen had a clip", () =>
    Effect.gen(function* () {
      const kept = Result.getOrThrow(
        Screen.initial.apply({ _tag: "AssignClip", tile: 0, highlight: highlight() }, TestWeb.nowhere)
      )
      yield* TestWeb.keep(kept)
      const { registry } = yield* TestWeb.withShell()

      const screen = yield* Atom.get(DisplayScreen.screen).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(screen.tiles[0], { _tag: "Empty" })
    })
  )

  it.effect("should start from the initial Screen when what was kept does not read", () =>
    Effect.gen(function* () {
      localStorage.setItem("sportal/screen", "{not a screen")
      const { registry } = yield* TestWeb.withShell()

      const screen = yield* Atom.get(DisplayScreen.screen).pipe(Effect.scoped, Effect.provide(registry))

      assert.deepStrictEqual(screen, Screen.initial)
    })
  )

  it.effect("should keep each change in this browser", () =>
    Effect.gen(function* () {
      const { registry } = yield* TestWeb.withShell()

      yield* Effect.gen(function* () {
        yield* Atom.set(DisplayScreen.screen, { _tag: "SetLayout", layout: "Single" })
        yield* TestWeb.until(DisplayScreen.screen, (screen) => screen.layout === "Single")
      }).pipe(Effect.scoped, Effect.provide(registry))

      const kept = localStorage.getItem("sportal/screen") ?? ""
      assert.include(kept, '"layout":"Single"')
    })
  )
})

const id = GameId.make("401")
const game = snapshot({ id })
const espn = {
  name: "ESPN",
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/espn" }
}
const onEspn: ChannelAvailability = { _tag: "Carried", channel: espn }

/** Today's list of the one game, with `availability`. */
function listOf(availability: ReadonlyArray<ChannelAvailability>): GameList {
  return { date: TestWeb.todayList.date, games: [{ snapshot: game, availability }] }
}
