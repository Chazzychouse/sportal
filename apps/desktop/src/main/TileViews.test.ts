import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { type Mock, vi } from "vitest"

const created: Array<{ setBounds: Mock; webContents: ReturnType<typeof fakeContents> }> = []

vi.mock("electron", () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn() }) },
  WebContentsView: class {
    readonly setBounds = vi.fn()
    readonly webContents = fakeContents()
    constructor() {
      created.push(this)
    }
  }
}))

const { ProviderSession } = await import("./ProviderSession.ts")
const { TileViews } = await import("./TileViews.ts")

const placement = {
  tile: 0,
  url: "https://tv.youtube.com/watch/one",
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
      yield* tiles.sync([placement, { ...placement, tile: 1 }])
      yield* Scope.close(scope, Exit.void)
      expect(created).toHaveLength(2)
      for (const view of created) {
        expect(window.contentView.removeChildView).toHaveBeenCalledWith(view)
        expect(view.webContents.close).toHaveBeenCalled()
      }
    })
  )
})

/** Tile views over a fake window, on the real provider session with Electron mocked. */
function attached() {
  created.length = 0
  const window = fakeWindow()
  const layer = TileViews.layer(window).pipe(Layer.provide(ProviderSession.layer))
  return Layer.build(layer).pipe(
    Effect.map((context) => ({ window, tiles: Context.get(context, TileViews) }))
  )
}

function fakeContents() {
  return {
    loadURL: vi.fn(() => Promise.resolve()),
    setAudioMuted: vi.fn(),
    close: vi.fn(),
    isDestroyed: () => false,
    on: vi.fn(),
    setWindowOpenHandler: vi.fn()
  }
}

function fakeWindow() {
  return {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
  }
}
