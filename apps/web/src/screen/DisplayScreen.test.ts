import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { Game, GameId } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect, Option, Schema, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { vi } from "vitest"
import * as LiveStream from "../hub/LiveStream.ts"
import * as TestWeb from "../TestWeb.ts"
import * as DisplayScreen from "./DisplayScreen.ts"
import { Screen } from "./Screen.ts"

describe("DisplayScreen.screen", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
    vi.stubGlobal("localStorage", new MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should assign a game as the slate's availability says", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.opened
      source.onmessage?.({ data: TestWeb.slateMessage([{ game, availability: [onEspn] }]) })
      yield* untilLive((live) => live.slate.games.length > 0)

      yield* Atom.set(DisplayScreen.screen, { _tag: "Assign", tile: 0, game: id })

      const screen = yield* Atom.get(DisplayScreen.screen)
      assert.deepStrictEqual(screen.tiles[0], { _tag: "StreamTile", game: id, channel: espn })
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should publish a refused command's rejection and keep the Screen", () =>
    Effect.gen(function* () {
      yield* TestWeb.opened
      const before = yield* Atom.get(DisplayScreen.screen)

      yield* Atom.set(DisplayScreen.screen, { _tag: "Clear", tile: 9 })

      const after = yield* Atom.get(DisplayScreen.screen)
      const rejected = yield* Atom.get(DisplayScreen.rejected)
      assert.strictEqual(after, before)
      assert.deepStrictEqual(
        Option.map(rejected, ({ reason }) => reason),
        Option.some("no-such-tile")
      )
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should refresh a tile when a slate brings its game a stream", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.opened
      source.onmessage?.({ data: TestWeb.slateMessage([{ game, availability: [] }]) })
      yield* untilLive((live) => live.slate.games.length > 0)
      yield* Atom.set(DisplayScreen.screen, { _tag: "Assign", tile: 0, game: id })

      source.onmessage?.({ data: TestWeb.slateMessage([{ game, availability: [onEspn] }]) })
      const screen = yield* untilScreen((screen) => screen.tiles[0]?._tag === "StreamTile")

      assert.deepStrictEqual(screen.tiles[0], { _tag: "StreamTile", game: id, channel: espn })
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should start from the Screen this browser kept", () =>
    Effect.gen(function* () {
      const kept = new Screen({ ...Screen.initial, layout: "Pair" })
      const encoded = yield* Schema.encodeEffect(Screen)(kept)
      localStorage.setItem("sportal/screen", JSON.stringify(encoded))
      yield* TestWeb.opened

      const screen = yield* Atom.get(DisplayScreen.screen)

      assert.strictEqual(screen.layout, "Pair")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should start from the initial Screen when what was kept does not read", () =>
    Effect.gen(function* () {
      localStorage.setItem("sportal/screen", "{not a screen")
      yield* TestWeb.opened

      const screen = yield* Atom.get(DisplayScreen.screen)

      assert.deepStrictEqual(screen, Screen.initial)
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should keep each change in this browser", () =>
    Effect.gen(function* () {
      yield* TestWeb.opened

      yield* Atom.set(DisplayScreen.screen, { _tag: "SetLayout", layout: "Single" })
      yield* untilScreen((screen) => screen.layout === "Single")

      const kept = localStorage.getItem("sportal/screen") ?? ""
      assert.include(kept, '"layout":"Single"')
    }).pipe(Effect.provide(AtomRegistry.layer))
  )
})

const id = GameId.make("401")
const game = new Game({ snapshot: snapshot({ id }), plays: [] })
const espn = {
  name: "ESPN",
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/espn" }
}
const onEspn: ChannelAvailability = { _tag: "Carried", channel: espn }

function untilLive(predicate: (live: Atom.Type<typeof LiveStream.live>) => boolean) {
  return Atom.toStream(LiveStream.live).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption)
  )
}

function untilScreen(predicate: (screen: Screen) => boolean) {
  return Atom.toStream(DisplayScreen.screen).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption)
  )
}

/** A `Storage` in memory, as a browser's `localStorage` is. */
class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>()
  get length() {
    return this.items.size
  }
  clear() {
    this.items.clear()
  }
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
  setItem(key: string, value: string) {
    this.items.set(key, value)
  }
}
