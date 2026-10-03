import { describe, expect, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Context, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { type Mock, vi } from "vitest"

const created: Array<{ setBounds: Mock; setVisible: Mock; webContents: ReturnType<typeof fakeContents> }> = []

vi.mock("electron", () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn() }) },
  WebContentsView: class {
    readonly setBounds = vi.fn()
    readonly setVisible = vi.fn()
    readonly webContents = fakeContents()
    constructor() {
      created.push(this)
    }
  }
}))

const { ProviderSession } = await import("./ProviderSession.ts")
const { TileViews } = await import("./TileViews.ts")

const one = GameId.make("one")
const two = GameId.make("two")
const placement = {
  game: one,
  url: "https://tv.youtube.com/watch/one",
  role: "stream" as const,
  bounds: { x: 10, y: 20, width: 640, height: 360 },
  muted: true
}

describe("TileViews.sync", () => {
  it.effect("creates a view for a placement, loads its address, and sets its bounds and mute", () =>
    Effect.gen(function* () {
      const { window, tiles } = yield* attached()
      yield* tiles.sync([placement])
      expect(created).toHaveLength(1)
      const [view] = created
      expect(window.contentView.addChildView).toHaveBeenCalledWith(view)
      expect(view?.webContents.loadURL).toHaveBeenCalledWith(placement.url)
      expect(view?.setBounds).toHaveBeenCalledWith(placement.bounds)
      expect(view?.webContents.setAudioMuted).toHaveBeenCalledWith(true)
    }).pipe(Effect.scoped)
  )

  it.effect("does not reload a view whose placement is unchanged", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.sync([placement])
      expect(created).toHaveLength(1)
      expect(created[0]?.webContents.loadURL).toHaveBeenCalledTimes(1)
    }).pipe(Effect.scoped)
  )

  it.effect("reloads a view whose address changed", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.sync([{ ...placement, url: "https://tv.youtube.com/watch/two" }])
      expect(created).toHaveLength(1)
      expect(created[0]?.webContents.loadURL).toHaveBeenLastCalledWith("https://tv.youtube.com/watch/two")
    }).pipe(Effect.scoped)
  )

  it.effect("removes and closes the view of a tile absent from the next sync", () =>
    Effect.gen(function* () {
      const { window, tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.sync([])
      const [view] = created
      expect(window.contentView.removeChildView).toHaveBeenCalledWith(view)
      expect(view?.webContents.close).toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("moves a game's view without reloading it when the game changes tiles", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      const other = { ...placement, game: two, url: "https://tv.youtube.com/watch/two" }
      yield* tiles.sync([placement, other])
      const moved = { x: 700, y: 20, width: 640, height: 360 }
      yield* tiles.sync([
        { ...other, bounds: placement.bounds },
        { ...placement, bounds: moved }
      ])
      expect(created).toHaveLength(2)
      expect(created[0]?.webContents.loadURL).toHaveBeenCalledTimes(1)
      expect(created[1]?.webContents.loadURL).toHaveBeenCalledTimes(1)
      expect(created[0]?.setBounds).toHaveBeenLastCalledWith(moved)
    }).pipe(Effect.scoped)
  )

  it.effect("creates no view for a refused address", () =>
    Effect.gen(function* () {
      const { window, tiles } = yield* attached()
      yield* tiles.sync([{ ...placement, url: "https://evil.example/" }])
      expect(created).toHaveLength(0)
      expect(window.contentView.addChildView).not.toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("removes an existing view when its tile's address is refused", () =>
    Effect.gen(function* () {
      const { window, tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.sync([{ ...placement, url: "https://evil.example/" }])
      const [view] = created
      expect(created).toHaveLength(1)
      expect(window.contentView.removeChildView).toHaveBeenCalledWith(view)
      expect(view?.webContents.close).toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("removes and closes every view when the shell shuts down", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const { window, tiles } = yield* attached().pipe(Scope.provide(scope))
      yield* tiles.sync([placement, { ...placement, game: two }])
      yield* Scope.close(scope, Exit.void)
      expect(created).toHaveLength(2)
      for (const view of created) {
        expect(window.contentView.removeChildView).toHaveBeenCalledWith(view)
        expect(view.webContents.close).toHaveBeenCalled()
      }
    })
  )
})

describe("TileViews.channelPicks", () => {
  const guide = { ...placement, url: "https://tv.youtube.com/live", role: "guide" as const }
  const espn = "https://tv.youtube.com/watch/espn?vp=0gEEEgIwAQ%3D%3D"
  const fox = "https://tv.youtube.com/watch/fox?vp=0gEEEgIwAQ%3D%3D"

  it.effect("reports the channel a guide view lands on", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([guide])
      const picks = yield* collect(tiles.channelPicks, 1)
      created[0]?.webContents.emit("did-navigate-in-page", {}, espn, true)
      expect(yield* Fiber.join(picks)).toEqual([{ game: one, url: espn }])
    }).pipe(Effect.scoped)
  )

  it.effect("ignores the guide itself, subframes, and a repeat of the address just reported", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([guide])
      const picks = yield* collect(tiles.channelPicks, 2)
      const contents = created[0]?.webContents
      contents?.emit("did-navigate", {}, "https://tv.youtube.com/live")
      contents?.emit("did-navigate-in-page", {}, espn, false)
      contents?.emit("did-navigate-in-page", {}, espn, true)
      contents?.emit("did-navigate", {}, espn)
      contents?.emit("did-navigate-in-page", {}, fox, true)
      expect(yield* Fiber.join(picks)).toEqual([
        { game: one, url: espn },
        { game: one, url: fox }
      ])
    }).pipe(Effect.scoped)
  )

  it.effect("reports a channel again once the guide has been back on a non-channel address", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([guide])
      const picks = yield* collect(tiles.channelPicks, 2)
      const contents = created[0]?.webContents
      contents?.emit("did-navigate-in-page", {}, espn, true)
      contents?.emit("did-navigate-in-page", {}, "https://tv.youtube.com/live", true)
      contents?.emit("did-navigate-in-page", {}, espn, true)
      expect(yield* Fiber.join(picks)).toEqual([
        { game: one, url: espn },
        { game: one, url: espn }
      ])
    }).pipe(Effect.scoped)
  )

  it.effect("reports an address once when it arrives as did-navigate and then did-navigate-in-page", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([guide])
      const picks = yield* collect(tiles.channelPicks, 2)
      const contents = created[0]?.webContents
      contents?.emit("did-navigate", {}, espn)
      contents?.emit("did-navigate-in-page", {}, espn, true)
      contents?.emit("did-navigate-in-page", {}, fox, true)
      expect(yield* Fiber.join(picks)).toEqual([
        { game: one, url: espn },
        { game: one, url: fox }
      ])
    }).pipe(Effect.scoped)
  )

  it.effect("reports the same channel again once the Hub places a new address in the tile", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([guide])
      const picks = yield* collect(tiles.channelPicks, 2)
      const contents = created[0]?.webContents
      contents?.emit("did-navigate-in-page", {}, espn, true)
      yield* tiles.sync([{ ...guide, url: "https://tv.youtube.com/live?again" }])
      contents?.emit("did-navigate-in-page", {}, espn, true)
      expect(yield* Fiber.join(picks)).toEqual([
        { game: one, url: espn },
        { game: one, url: espn }
      ])
    }).pipe(Effect.scoped)
  )

  it.effect("does not report for a view removed in a sync", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([guide])
      yield* tiles.sync([])
      const picks = yield* collect(tiles.channelPicks, 1)
      created[0]?.webContents.emit("did-navigate-in-page", {}, espn, true)
      yield* tiles.sync([{ ...guide, game: two }])
      created[1]?.webContents.emit("did-navigate-in-page", {}, fox, true)
      expect(yield* Fiber.join(picks)).toEqual([{ game: two, url: fox }])
    }).pipe(Effect.scoped)
  )

  it.effect("never reports for a stream view", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement, { ...guide, game: two }])
      const picks = yield* collect(tiles.channelPicks, 1)
      created[0]?.webContents.emit("did-navigate-in-page", {}, espn, true)
      created[1]?.webContents.emit("did-navigate-in-page", {}, fox, true)
      expect(yield* Fiber.join(picks)).toEqual([{ game: two, url: fox }])
    }).pipe(Effect.scoped)
  )
})

describe("TileViews transitions", () => {
  const transition = { durationMs: 160, easing: [0, 0, 1, 1] as const }
  const target = { x: 110, y: 20, width: 640, height: 360 }

  it.effect("moves a view to its new bounds over the duration, landing exactly", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.sync([{ ...placement, bounds: target }], transition)
      yield* TestClock.adjust("80 millis")
      expect(created[0]?.setBounds).toHaveBeenLastCalledWith({ x: 60, y: 20, width: 640, height: 360 })
      yield* TestClock.adjust("100 millis")
      expect(created[0]?.setBounds).toHaveBeenLastCalledWith(target)
    }).pipe(Effect.scoped)
  )

  it.effect("starts a new transition from where the views are", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.sync([{ ...placement, bounds: target }], transition)
      yield* TestClock.adjust("80 millis")
      yield* tiles.sync([placement], transition)
      yield* TestClock.adjust("16 millis")
      expect(created[0]?.setBounds).toHaveBeenLastCalledWith({ x: 55, y: 20, width: 640, height: 360 })
    }).pipe(Effect.scoped)
  )

  it.effect("sets bounds at once without a transition, ending one under way", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.sync([{ ...placement, bounds: target }], transition)
      yield* TestClock.adjust("32 millis")
      yield* tiles.sync([placement])
      yield* TestClock.adjust("200 millis")
      expect(created[0]?.setBounds).toHaveBeenLastCalledWith(placement.bounds)
    }).pipe(Effect.scoped)
  )

  it.effect("shows a view new in a transition at its target once the transition ends", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      const arriving = { ...placement, game: two, url: "https://tv.youtube.com/watch/two", bounds: target }
      yield* tiles.sync([placement, arriving], transition)
      expect(created[1]?.setBounds).toHaveBeenLastCalledWith(target)
      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(false)
      yield* TestClock.adjust("200 millis")
      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(true)
    }).pipe(Effect.scoped)
  )
})

describe("TileViews.hide", () => {
  it.effect("hides exactly the named games, and keeps them hidden through syncs", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      const other = { ...placement, game: two, url: "https://tv.youtube.com/watch/two" }
      yield* tiles.sync([placement, other])
      yield* tiles.hide([two])
      expect(created[0]?.setVisible).toHaveBeenLastCalledWith(true)
      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(false)
      yield* tiles.sync([placement, other])
      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(false)
      yield* tiles.hide([])
      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(true)
    }).pipe(Effect.scoped)
  )
})

describe("TileViews.hotkeys", () => {
  it.effect(
    "forwards hotkeys from stream views and keeps them from the page; guide views get every key",
    () =>
      Effect.gen(function* () {
        const { tiles } = yield* attached()
        const guide = { ...placement, game: two, role: "guide" as const, url: "https://tv.youtube.com/live" }
        yield* tiles.sync([placement, guide])
        const hotkeys = yield* collect(tiles.hotkeys, 1)
        const press = (view: number, code: string, type = "keyDown") => {
          const event = { preventDefault: vi.fn() }
          created[view]?.webContents.emit("before-input-event", event, {
            type,
            code,
            shift: false,
            control: false,
            meta: false
          })
          return event.preventDefault
        }
        expect(press(1, "Digit2")).not.toHaveBeenCalled()
        expect(press(0, "KeyA")).not.toHaveBeenCalled()
        expect(press(0, "Digit2", "keyUp")).not.toHaveBeenCalled()
        expect(press(0, "Digit2")).toHaveBeenCalled()
        expect(yield* Fiber.join(hotkeys)).toEqual([{ _tag: "FocusAudio", slot: 1 }])
      }).pipe(Effect.scoped)
  )
})

/** Starts collecting the first `count` picks, subscribed before this returns. */
function collect<A>(picks: Stream.Stream<A>, count: number) {
  return Effect.gen(function* () {
    const fiber = yield* picks.pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    return fiber
  })
}

/** Tile views over a fake window, on the real provider session with Electron mocked. */
function attached() {
  created.length = 0
  const window = fakeWindow()
  const layer = TileViews.layer(window).pipe(Layer.provide(ProviderSession.layer))
  return Layer.build(layer).pipe(
    Effect.map((context) => ({ window, tiles: Context.get(context, TileViews) }))
  )
}

/** A view's contents that records its event listeners, so a test can `emit` what Electron would. */
function fakeContents() {
  const listeners = new Map<string, Array<(...args: Array<unknown>) => void>>()
  return {
    loadURL: vi.fn(() => Promise.resolve()),
    setAudioMuted: vi.fn(),
    close: vi.fn(),
    isDestroyed: () => false,
    on: vi.fn((event: string, listener: (...args: Array<unknown>) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    setWindowOpenHandler: vi.fn(),
    emit: (event: string, ...args: Array<unknown>) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    }
  }
}

function fakeWindow() {
  return {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
  }
}
