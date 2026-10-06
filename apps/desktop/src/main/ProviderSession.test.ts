import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Logger } from "effect"
import { afterEach, vi } from "vitest"

const ui = "http://127.0.0.1:4401"
const providerSession = { setPermissionRequestHandler: vi.fn() }
const windows: Array<{
  options: { width: number; height: number; parent?: unknown; webPreferences: Record<string, unknown> }
  webContents: ReturnType<typeof fakeContents>
  destroyed: boolean
  focus: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}> = []

vi.mock("electron", () => ({
  session: { fromPartition: vi.fn(() => providerSession) },
  WebContentsView: vi.fn(),
  BrowserWindow: class {
    readonly webContents = fakeContents()
    destroyed = false
    readonly focus = vi.fn()
    readonly close = vi.fn(() => {
      this.destroyed = true
    })
    readonly options: {
      width: number
      height: number
      parent?: unknown
      webPreferences: Record<string, unknown>
    }
    constructor(options: {
      width: number
      height: number
      parent?: unknown
      webPreferences: Record<string, unknown>
    }) {
      this.options = options
      windows.push(this)
    }
    isDestroyed() {
      return this.destroyed
    }
  }
}))

const { ProviderSession } = await import("./ProviderSession.ts")

describe("ProviderSession.openSignIn", () => {
  it.effect("opens a window on the shared provider session at YouTube TV, without a preload", () =>
    Effect.gen(function* () {
      const providers = yield* built()
      yield* providers.openSignIn(shell)
      expect(windows).toHaveLength(1)
      const [signIn] = windows
      expect(signIn?.options.webPreferences).toEqual({
        session: providerSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      })
      expect(signIn?.options.width).toBe(1000)
      expect(signIn?.options.height).toBe(800)
      expect(signIn?.webContents.loadURL).toHaveBeenCalledWith("https://tv.youtube.com/")
    }).pipe(Effect.scoped)
  )

  it.effect("makes the window a child of the shell window, so it closes with it", () =>
    Effect.gen(function* () {
      const providers = yield* built()
      yield* providers.openSignIn(shell)
      expect(windows[0]?.options.parent).toBe(shell)
    }).pipe(Effect.scoped)
  )

  it.effect("confines the window to the provider's addresses", () =>
    Effect.gen(function* () {
      const providers = yield* built()
      yield* providers.openSignIn(shell)
      const refused = navigation("https://evil.example/", true)
      windows[0]?.webContents.emit("will-navigate", refused)
      expect(refused.preventDefault).toHaveBeenCalled()
      const allowed = navigation("https://accounts.google.com/signin", true)
      windows[0]?.webContents.emit("will-navigate", allowed)
      expect(allowed.preventDefault).not.toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("focuses the open window instead of opening a second", () =>
    Effect.gen(function* () {
      const providers = yield* built()
      yield* providers.openSignIn(shell)
      yield* providers.openSignIn(shell)
      expect(windows).toHaveLength(1)
      expect(windows[0]?.focus).toHaveBeenCalledTimes(1)
    }).pipe(Effect.scoped)
  )

  it.effect("opens a new window once the user has closed the last", () =>
    Effect.gen(function* () {
      const providers = yield* built()
      yield* providers.openSignIn(shell)
      if (windows[0]) windows[0].destroyed = true
      yield* providers.openSignIn(shell)
      expect(windows).toHaveLength(2)
    }).pipe(Effect.scoped)
  )

  it.effect("closes an open window when the layer is released", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const providers = yield* built()
          yield* providers.openSignIn(shell)
          expect(windows[0]?.close).not.toHaveBeenCalled()
        })
      )
      expect(windows[0]?.close).toHaveBeenCalled()
    })
  )

  it.effect("logs a failed load by its code, never its message", () =>
    Effect.gen(function* () {
      const logs: Array<string> = []
      const providers = yield* built(logs)
      loadFailure = Object.assign(new Error("ERR_FAILED loading 'https://tv.youtube.com/?t=1'"), {
        code: "ERR_FAILED"
      })
      yield* providers.openSignIn(shell)
      yield* Effect.yieldNow
      expect(logs).toEqual(["ProviderSession: the sign-in window did not load: ERR_FAILED"])
    }).pipe(Effect.scoped)
  )

  afterEach(() => {
    loadFailure = undefined
  })
})

describe("ProviderSession.allows", () => {
  it.each([
    "https://tv.youtube.com/watch",
    "https://www.youtube.com/",
    "https://accounts.youtube.com/",
    "https://accounts.google.com/signin"
  ])("allows %s", (url) => {
    expect(allowed(url)).toBe(true)
  })

  it.each([
    "http://tv.youtube.com/",
    "https://www.google.com/url?q=https://evil.example",
    "https://sites.google.com/",
    "https://evilyoutube.com/",
    "https://tv.youtube.com.evil.com/",
    "https://tv.youtube.com@evil.com/",
    "not a url"
  ])("refuses %s", (url) => {
    expect(allowed(url)).toBe(false)
  })

  it.each([
    "http://127.0.0.1:4401/scenario-stream/401856707",
    "http://127.0.0.1:4401/scenario-stream/tie-uga-ala"
  ])("allows the UI's own scenario stream %s", (url) => {
    expect(allowed(url)).toBe(true)
  })

  it.each([
    "http://127.0.0.1:4401/",
    "http://127.0.0.1:4401/remote",
    "http://127.0.0.1:4401/scenario-stream/../remote",
    "http://127.0.0.1:4401/scenario-stream",
    "http://127.0.0.1:4402/scenario-stream/1",
    "http://localhost:4401/scenario-stream/1",
    "https://evil.example/scenario-stream/1"
  ])("refuses %s, which is not the UI's scenario stream", (url) => {
    expect(allowed(url)).toBe(false)
  })
})

describe("ProviderSession permission requests", () => {
  it.each(["mediaKeySystem", "fullscreen", "screen-wake-lock"])("grants %s", (permission) => {
    expect(granted(permission)).toBe(true)
  })

  it.each(["media", "geolocation", "notifications", "clipboard-read", "openExternal", "unknown"])(
    "denies %s",
    (permission) => {
      expect(granted(permission)).toBe(false)
    }
  )
})

let loadFailure: Error | undefined

function allowed(url: string) {
  return Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const providers = yield* built()
        return providers.allows(url)
      })
    )
  )
}

/** Asks the provider session's permission handler, as Electron would, and returns what it answered. */
function granted(permission: string) {
  const answers: Array<boolean> = []
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        yield* built()
        const handler = providerSession.setPermissionRequestHandler.mock.lastCall?.[0]
        handler?.(undefined, permission, (answer: boolean) => answers.push(answer), {
          requestingUrl: "https://tv.youtube.com/"
        })
      })
    )
  )
  return answers[0]
}

const { BrowserWindow } = await import("electron")
const shell = new BrowserWindow()

function navigation(url: string, isMainFrame: boolean) {
  return { url, isMainFrame, preventDefault: vi.fn() }
}

/** A page's contents that records its listeners, so a test can `emit` what Electron would. */
function fakeContents() {
  const listeners = new Map<string, Array<(details: ReturnType<typeof navigation>) => void>>()
  let openHandler: () => unknown = () => undefined
  return {
    loadURL: vi.fn(() => (loadFailure ? Promise.reject(loadFailure) : Promise.resolve())),
    on: (event: string, listener: (details: ReturnType<typeof navigation>) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    setWindowOpenHandler: (handler: () => unknown) => {
      openHandler = handler
    },
    emit: (event: string, details: ReturnType<typeof navigation>) => {
      for (const listener of listeners.get(event) ?? []) listener(details)
    },
    openWindow: () => openHandler()
  }
}

function built(logs: Array<string> = []) {
  windows.length = 0
  const capture = Logger.make<unknown, void>(({ message }) => {
    logs.push(String(Array.isArray(message) ? message[0] : message))
  })
  return Layer.build(ProviderSession.layer(ui).pipe(Layer.provide(Logger.layer([capture])))).pipe(
    Effect.map((context) => Context.get(context, ProviderSession))
  )
}
