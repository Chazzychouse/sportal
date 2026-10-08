import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { afterEach, vi } from "vitest"
import { fakeContents, navigation } from "./TestWebContents.ts"

const providerSession = { setPermissionRequestHandler: vi.fn() }
const windows: Array<{
  options: { width: number; height: number; parent?: unknown; webPreferences: Record<string, unknown> }
  webContents: ReturnType<typeof fakeContents>
  destroyed: boolean
  focus: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}> = []
/** What the next sign-in window's load fails with; none loads. */
let loadFailure: Error | undefined

vi.mock("electron", () => ({
  session: { fromPartition: vi.fn(() => providerSession) },
  WebContentsView: vi.fn(),
  BrowserWindow: class {
    readonly webContents = fakeContents(() => (loadFailure ? Promise.reject(loadFailure) : Promise.resolve()))
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
const { shellOf } = await import("./TestShell.ts")
const { BrowserWindow } = await import("electron")
const shell = new BrowserWindow()

describe("ProviderSession.openSignIn", () => {
  afterEach(() => {
    loadFailure = undefined
  })

  it.effect("should open a window on the shared provider session at YouTube TV, without a preload", () =>
    Effect.gen(function* () {
      const providers = yield* built()

      yield* providers.openSignIn

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

  it.effect("should make the window a child of the shell window, so it closes with it", () =>
    Effect.gen(function* () {
      const providers = yield* built()

      yield* providers.openSignIn

      expect(windows[0]?.options.parent).toBe(shell)
    }).pipe(Effect.scoped)
  )

  it.effect("should refuse a navigation in the window off the provider's addresses", () =>
    Effect.gen(function* () {
      const providers = yield* built()
      yield* providers.openSignIn
      const refused = navigation("https://evil.example/", true)

      onlyWindow().webContents.emit("will-navigate", refused)

      expect(refused.preventDefault).toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("should let a navigation in the window to the provider's sign-in through", () =>
    Effect.gen(function* () {
      const providers = yield* built()
      yield* providers.openSignIn
      const allowed = navigation("https://accounts.google.com/signin", true)

      onlyWindow().webContents.emit("will-navigate", allowed)

      expect(allowed.preventDefault).not.toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("should focus the open window instead of opening a second", () =>
    Effect.gen(function* () {
      const providers = yield* built()
      yield* providers.openSignIn

      yield* providers.openSignIn

      expect(windows).toHaveLength(1)
      expect(windows[0]?.focus).toHaveBeenCalledTimes(1)
    }).pipe(Effect.scoped)
  )

  it.effect("should open a new window once the user has closed the last", () =>
    Effect.gen(function* () {
      const providers = yield* built()
      yield* providers.openSignIn
      if (windows[0]) windows[0].destroyed = true

      yield* providers.openSignIn

      expect(windows).toHaveLength(2)
    }).pipe(Effect.scoped)
  )

  it.effect("should keep an open window open while the layer lives", () =>
    Effect.gen(function* () {
      const providers = yield* built()

      yield* providers.openSignIn

      expect(windows[0]?.close).not.toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("should close an open window when the layer is released", () =>
    Effect.gen(function* () {
      const opened = Effect.gen(function* () {
        const providers = yield* built()
        yield* providers.openSignIn
      })

      yield* Effect.scoped(opened)

      expect(windows[0]?.close).toHaveBeenCalled()
    })
  )

  it.effect("should log a failed load by its code, never its message", () =>
    Effect.gen(function* () {
      const logs: Array<string> = []
      const providers = yield* built(logs)
      loadFailure = Object.assign(new Error("ERR_FAILED loading 'https://tv.youtube.com/?t=1'"), {
        code: "ERR_FAILED"
      })

      yield* providers.openSignIn
      yield* Effect.yieldNow

      expect(logs).toEqual(["ProviderSession: the sign-in window did not load: ERR_FAILED"])
    }).pipe(Effect.scoped)
  )
})

describe("ProviderSession.allows", () => {
  it.each([
    "https://tv.youtube.com/watch",
    "https://www.youtube.com/",
    "https://accounts.youtube.com/",
    "https://accounts.google.com/signin",
    "https://player.twitch.tv/?channel=primevideo&parent=twitch.tv&player=popout"
  ])("should allow %s", (url) => {
    const allows = allowed(url)

    expect(allows).toBe(true)
  })

  it.each([
    "http://tv.youtube.com/",
    "https://www.twitch.tv/primevideo",
    "http://player.twitch.tv/",
    "https://www.google.com/url?q=https://evil.example",
    "https://sites.google.com/",
    "https://evilyoutube.com/",
    "https://tv.youtube.com.evil.com/",
    "https://tv.youtube.com@evil.com/",
    "not a url",
    "http://127.0.0.1:4401/",
    "http://127.0.0.1:4401/remote",
    "http://127.0.0.1:4401/scenario-stream/../remote",
    "http://127.0.0.1:4401/scenario-stream",
    "http://127.0.0.1:4402/scenario-stream/1",
    "http://localhost:4401/scenario-stream/1",
    "https://evil.example/scenario-stream/1",
    "http://127.0.0.1:4401/scenario-stream/401856707"
  ])("should refuse %s", (url) => {
    const allows = allowed(url)

    expect(allows).toBe(false)
  })
})

describe("ProviderSession permission requests", () => {
  it.each(["mediaKeySystem", "fullscreen", "screen-wake-lock"])("should grant %s", (permission) => {
    const answer = granted(permission)

    expect(answer).toBe(true)
  })

  it.each(["media", "geolocation", "notifications", "clipboard-read", "openExternal", "unknown"])(
    "should deny %s",
    (permission) => {
      const answer = granted(permission)

      expect(answer).toBe(false)
    }
  )
})

/** The provider session over the mocked shell window, with every log's message pushed to `logs`. */
function built(logs: Array<string> = []) {
  windows.length = 0
  return Layer.build(ProviderSession.layer.pipe(Layer.provide(shellOf(shell, logs)))).pipe(
    Effect.map((context) => Context.get(context, ProviderSession))
  )
}

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

/** The one sign-in window open; a test with none, or several, fails here. */
function onlyWindow() {
  const [window, ...others] = windows
  if (window === undefined || others.length > 0) throw new Error(`${windows.length} sign-in windows are open`)
  return window
}
