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
  },
  BrowserWindow: class {
    readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    isDestroyed() {
      return false
    }
  }
}))

const { ProviderSession } = await import("./ProviderSession.ts")
const { TileViews } = await import("./TileViews.ts")
const { ShellConfig } = await import("./ShellConfig.ts")
const { ShellWindow } = await import("./ShellWindow.ts")
const { BrowserWindow } = await import("electron")

const one = GameId.make("one")
const two = GameId.make("two")
const placement = {
  game: one,
  url: "https://tv.youtube.com/watch/one",
  bounds: { x: 10, y: 20, width: 640, height: 360 },
  muted: true,
  interactive: false
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
  it.effect("forwards hotkeys from stream views and keeps them from the page", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      const hotkeys = yield* collect(tiles.hotkeys, 1)
      const press = (code: string, type = "keyDown") => {
        const event = { preventDefault: vi.fn() }
        created[0]?.webContents.emit("before-input-event", event, {
          type,
          code,
          shift: false,
          control: false,
          meta: false
        })
        return event.preventDefault
      }
      expect(press("KeyA")).not.toHaveBeenCalled()
      expect(press("Digit2", "keyUp")).not.toHaveBeenCalled()
      expect(press("Digit2")).toHaveBeenCalled()
      expect(yield* Fiber.join(hotkeys)).toEqual([{ _tag: "FocusAudio", slot: 1 }])
    }).pipe(Effect.scoped)
  )
})

describe("TileViews mouse filter", () => {
  const mouse = (view: number, type: string, button?: string) => {
    const event = { preventDefault: vi.fn() }
    created[view]?.webContents.emit("before-mouse-event", event, { type, button, x: 5, y: 5 })
    return event.preventDefault
  }

  it.effect("keeps every mouse event from a stream view's page", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      for (const type of ["mouseMove", "mouseEnter", "mouseDown", "mouseUp", "mouseWheel", "contextMenu"])
        expect(mouse(0, type)).toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("lets the mouse reach an interactive stream view, and filters it again once it is not", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([{ ...placement, interactive: true }])
      expect(mouse(0, "mouseMove")).not.toHaveBeenCalled()
      yield* tiles.sync([placement])
      expect(mouse(0, "mouseMove")).toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("focuses a view when it becomes interactive, and only then", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      expect(created[0]?.webContents.focus).not.toHaveBeenCalled()
      yield* tiles.sync([{ ...placement, interactive: true }])
      yield* tiles.sync([{ ...placement, interactive: true, muted: false }])
      expect(created[0]?.webContents.focus).toHaveBeenCalledTimes(1)
    }).pipe(Effect.scoped)
  )

  it.effect("reports a left press on a filtered stream view as its game", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      const presses = yield* collect(tiles.tilePresses, 1)
      mouse(0, "mouseDown", "right")
      mouse(0, "mouseUp", "left")
      mouse(0, "mouseDown", "left")
      expect(yield* Fiber.join(presses)).toEqual([one])
    }).pipe(Effect.scoped)
  )

  it.effect("does not report a press on an interactive view, or on a view removed in a sync", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([{ ...placement, interactive: true }])
      const presses = yield* collect(tiles.tilePresses, 1)
      mouse(0, "mouseDown", "left")
      yield* tiles.sync([placement])
      yield* tiles.sync([{ ...placement, game: two }])
      mouse(0, "mouseDown", "left")
      mouse(1, "mouseDown", "left")
      expect(yield* Fiber.join(presses)).toEqual([two])
    }).pipe(Effect.scoped)
  )
})

/** Starts collecting the first `count` values of `stream`, subscribed before this returns. */
function collect<A>(stream: Stream.Stream<A>, count: number) {
  return Effect.gen(function* () {
    const fiber = yield* stream.pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    return fiber
  })
}

/** Tile views over a mocked shell window, on the real provider session with Electron mocked. */
function attached() {
  created.length = 0
  const window = new BrowserWindow({})
  const layer = TileViews.layer.pipe(
    Layer.provide(ProviderSession.layer),
    Layer.provide([
      Layer.succeed(ShellConfig, ShellConfig.of({ hubUrl: "http://127.0.0.1:4401" })),
      Layer.succeed(ShellWindow, window)
    ])
  )
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
    focus: vi.fn(),
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
