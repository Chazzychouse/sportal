import { describe, expect, it } from "@effect/vitest"
import { TileKey } from "@sportal/api/TileKey"
import { GameId } from "@sportal/domain/Game"
import { Context, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"
import { type Mock, vi } from "vitest"
import * as TestDesktop from "./TestDesktop.ts"

const created: Array<{
  setBounds: Mock
  setVisible: Mock
  webContents: ReturnType<typeof TestDesktop.fakeContents>
}> = []

vi.mock("electron", () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn() }) },
  WebContentsView: class {
    readonly setBounds = vi.fn()
    readonly setVisible = vi.fn()
    readonly webContents = TestDesktop.fakeContents()
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
const { BrowserWindow } = await import("electron")

describe("TileViews.sync", () => {
  it.effect("should create a view for a placement, load its address, and set its bounds and mute", () =>
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

  it.effect("should not reload a view whose placement is unchanged", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])

      yield* tiles.sync([placement])

      expect(created).toHaveLength(1)
      expect(created[0]?.webContents.loadURL).toHaveBeenCalledTimes(1)
    }).pipe(Effect.scoped)
  )

  it.effect("should reload a view whose address changed", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])

      yield* tiles.sync([{ ...placement, url: "https://tv.youtube.com/watch/two" }])

      expect(created).toHaveLength(1)
      expect(created[0]?.webContents.loadURL).toHaveBeenLastCalledWith("https://tv.youtube.com/watch/two")
    }).pipe(Effect.scoped)
  )

  it.effect("should remove and close the view of a tile absent from the next sync", () =>
    Effect.gen(function* () {
      const { window, tiles } = yield* attached()
      yield* tiles.sync([placement])

      yield* tiles.sync([])

      const [view] = created
      expect(window.contentView.removeChildView).toHaveBeenCalledWith(view)
      expect(view?.webContents.close).toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("should move a game's view without reloading it when the game changes tiles", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      const other = secondGame()
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

  it.effect("should create no view for a refused address", () =>
    Effect.gen(function* () {
      const { window, tiles } = yield* attached()

      yield* tiles.sync([{ ...placement, url: "https://evil.example/" }])

      expect(created).toHaveLength(0)
      expect(window.contentView.addChildView).not.toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("should remove an existing view when its tile's address is refused", () =>
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

  it.effect("should remove and close every view when the shell shuts down", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const { window, tiles } = yield* attached().pipe(Scope.provide(scope))
      yield* tiles.sync([placement, { ...placement, key: two }])

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
  it.effect("should move a view part of the way to its new bounds over the duration", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.sync([{ ...placement, bounds: target }], transition)

      yield* TestClock.adjust("80 millis")

      expect(created[0]?.setBounds).toHaveBeenLastCalledWith({ x: 60, y: 20, width: 640, height: 360 })
    }).pipe(Effect.scoped)
  )

  it.effect("should land a view exactly on its new bounds once the duration is over", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.sync([{ ...placement, bounds: target }], transition)
      yield* TestClock.adjust("80 millis")

      yield* TestClock.adjust("100 millis")

      expect(created[0]?.setBounds).toHaveBeenLastCalledWith(target)
    }).pipe(Effect.scoped)
  )

  it.effect("should start a new transition from where the views are", () =>
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

  it.effect("should set bounds at once without a transition, ending one under way", () =>
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

  it.effect("should place a view new in a transition at its target, hidden", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])

      yield* tiles.sync([placement, arriving()], transition)

      expect(created[1]?.setBounds).toHaveBeenLastCalledWith(target)
      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(false)
    }).pipe(Effect.scoped)
  )

  it.effect("should show a view new in a transition once the transition ends", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      yield* tiles.sync([placement, arriving()], transition)

      yield* TestClock.adjust("200 millis")

      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(true)
    }).pipe(Effect.scoped)
  )
})

describe("TileViews.hide", () => {
  it.effect("should hide exactly the named games", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement, secondGame()])

      yield* tiles.hide([two])

      expect(created[0]?.setVisible).toHaveBeenLastCalledWith(true)
      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(false)
    }).pipe(Effect.scoped)
  )

  it.effect("should keep hidden games hidden through a sync", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement, secondGame()])
      yield* tiles.hide([two])

      yield* tiles.sync([placement, secondGame()])

      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(false)
    }).pipe(Effect.scoped)
  )

  it.effect("should show hidden games again once none are named", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement, secondGame()])
      yield* tiles.hide([two])
      yield* tiles.sync([placement, secondGame()])

      yield* tiles.hide([])

      expect(created[1]?.setVisible).toHaveBeenLastCalledWith(true)
    }).pipe(Effect.scoped)
  )
})

describe("TileViews.hotkeys", () => {
  it.effect("should leave a key Sportal does not bind to the stream view's page", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])

      const prevented = press("KeyZ")

      expect(prevented).not.toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("should leave a hotkey's release to the stream view's page", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])

      const prevented = press("Digit2", "keyUp")

      expect(prevented).not.toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("should keep a hotkey from the stream view's page", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])

      const prevented = press("Digit2")

      expect(prevented).toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("should forward only the hotkey pressed in a stream view", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      const hotkeys = yield* TestDesktop.collect(tiles.hotkeys, 1)

      press("KeyZ")
      press("Digit2", "keyUp")
      press("Digit2")
      const forwarded = yield* Fiber.join(hotkeys)

      expect(forwarded).toEqual([{ _tag: "FocusAudio", slot: 1 }])
    }).pipe(Effect.scoped)
  )
})

describe("TileViews mouse filter", () => {
  it.effect.each(["mouseMove", "mouseEnter", "mouseDown", "mouseUp", "mouseWheel", "contextMenu"])(
    "should keep a %s from a stream view's page",
    (type) =>
      Effect.gen(function* () {
        const { tiles } = yield* attached()
        yield* tiles.sync([placement])

        const prevented = mouse(0, type)

        expect(prevented).toHaveBeenCalled()
      }).pipe(Effect.scoped)
  )

  it.effect("should let the mouse reach an interactive stream view", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([{ ...placement, interactive: true }])

      const prevented = mouse(0, "mouseMove")

      expect(prevented).not.toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("should filter the mouse again once a stream view is not interactive", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([{ ...placement, interactive: true }])
      mouse(0, "mouseMove")

      yield* tiles.sync([placement])
      const prevented = mouse(0, "mouseMove")

      expect(prevented).toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("should not focus a view that is not interactive", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()

      yield* tiles.sync([placement])

      expect(viewAt(0).webContents.focus).not.toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("should focus a view once, when it becomes interactive", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])

      yield* tiles.sync([{ ...placement, interactive: true }])
      yield* tiles.sync([{ ...placement, interactive: true, muted: false }])

      expect(created[0]?.webContents.focus).toHaveBeenCalledTimes(1)
    }).pipe(Effect.scoped)
  )

  it.effect("should report a left press on a filtered stream view as its game", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([placement])
      const presses = yield* TestDesktop.collect(tiles.tilePresses, 1)

      mouse(0, "mouseDown", "right")
      mouse(0, "mouseUp", "left")
      mouse(0, "mouseDown", "left")
      const reported = yield* Fiber.join(presses)

      expect(reported).toEqual([one])
    }).pipe(Effect.scoped)
  )

  it.effect("should report neither a press on an interactive view nor one on a view removed in a sync", () =>
    Effect.gen(function* () {
      const { tiles } = yield* attached()
      yield* tiles.sync([{ ...placement, interactive: true }])
      const presses = yield* TestDesktop.collect(tiles.tilePresses, 1)

      mouse(0, "mouseDown", "left")
      yield* tiles.sync([placement])
      yield* tiles.sync([{ ...placement, key: two }])
      mouse(0, "mouseDown", "left")
      mouse(1, "mouseDown", "left")
      const reported = yield* Fiber.join(presses)

      expect(reported).toEqual([two])
    }).pipe(Effect.scoped)
  )
})

const one = TileKey.game(GameId.make("one"))
const two = TileKey.game(GameId.make("two"))
const placement = {
  key: one,
  url: "https://tv.youtube.com/watch/one",
  bounds: { x: 10, y: 20, width: 640, height: 360 },
  muted: true,
  interactive: false
}
const transition = { durationMs: 160, easing: [0, 0, 1, 1] as const }
const target = { x: 110, y: 20, width: 640, height: 360 }

/** Tile views over a mocked shell window, on the real provider session with Electron mocked. */
function attached() {
  created.length = 0
  const window = new BrowserWindow({})
  const layer = TileViews.layer.pipe(
    Layer.provide(ProviderSession.layer),
    Layer.provide(TestDesktop.shellOf(window))
  )
  return Layer.build(layer).pipe(
    Effect.map((context) => ({ window, tiles: Context.get(context, TileViews) }))
  )
}

/** The second game's placement, on its own address, where `placement` is. */
function secondGame() {
  return { ...placement, key: two, url: "https://tv.youtube.com/watch/two" }
}

/** The second game's placement at `target`: a view a transition brings in. */
function arriving() {
  return { ...secondGame(), bounds: target }
}

/** Presses `code` in the first view, as Electron reports it; answers the spy for keeping it from the page. */
function press(code: string, type = "keyDown") {
  const event = { preventDefault: vi.fn() }
  viewAt(0).webContents.emit("before-input-event", event, {
    type,
    code,
    shift: false,
    control: false,
    meta: false
  })
  return event.preventDefault
}

/** A mouse event on a view, as Electron reports it; answers the spy for keeping it from the page. */
function mouse(view: number, type: string, button?: string) {
  const event = { preventDefault: vi.fn() }
  viewAt(view).webContents.emit("before-mouse-event", event, { type, button, x: 5, y: 5 })
  return event.preventDefault
}

/** The view created `index`th; a test that asks for one never created fails here. */
function viewAt(index: number) {
  const view = created[index]
  if (view === undefined) throw new Error(`no view ${index} was created`)
  return view
}
