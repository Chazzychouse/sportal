import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"

vi.mock("electron", () => ({
  session: { fromPartition: vi.fn() },
  WebContentsView: vi.fn()
}))

const { allows, confine, grantsPermission, hostOf, loadErrorCode } = await import("./ProviderSession.ts")

describe("allows", () => {
  it.each([
    "https://tv.youtube.com/watch",
    "https://www.youtube.com/",
    "https://accounts.youtube.com/",
    "https://accounts.google.com/signin"
  ])("allows %s", (url) => {
    expect(allows(url)).toBe(true)
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
    expect(allows(url)).toBe(false)
  })
})

describe("grantsPermission", () => {
  it.each(["mediaKeySystem", "fullscreen", "screen-wake-lock"])("grants %s", (permission) => {
    expect(grantsPermission(permission)).toBe(true)
  })

  it.each(["media", "geolocation", "notifications", "clipboard-read", "openExternal", "unknown"])(
    "denies %s",
    (permission) => {
      expect(grantsPermission(permission)).toBe(false)
    }
  )
})

describe("hostOf", () => {
  it("keeps only the hostname, dropping any path or query that could carry a token", () => {
    expect(hostOf("https://tv.youtube.com/watch/abc?token=secret")).toBe("tv.youtube.com")
  })

  it("names an address it cannot parse without repeating it", () => {
    expect(hostOf("not a url")).toBe("(unparseable address)")
  })
})

describe("loadErrorCode", () => {
  it("reads the code Electron attaches to a failed load", () => {
    expect(
      loadErrorCode(
        Object.assign(new Error("ERR_ABORTED (-3) loading 'https://x/?t=1'"), { code: "ERR_ABORTED" })
      )
    ).toBe("ERR_ABORTED")
  })

  it.each([new Error("no code"), "a string", undefined])("is unknown for %s", (error) => {
    expect(loadErrorCode(error)).toBe("unknown")
  })
})

describe("confine", () => {
  const onHub = (url: string) => url.startsWith("http://hub/")

  it.each(["will-navigate", "will-redirect"])(
    "refuses a %s off the permitted addresses, saying where",
    (event) => {
      const { contents, warn } = confined({ subframes: false })
      const refused = navigation("https://evil.example/path?token=secret", true)
      contents.emit(event, refused)
      expect(refused.preventDefault).toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith("refused navigation to evil.example")
    }
  )

  it("lets a permitted navigation through", () => {
    const { contents, warn } = confined({ subframes: false })
    const allowed = navigation("http://hub/stage", true)
    contents.emit("will-navigate", allowed)
    expect(allowed.preventDefault).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it("never opens a new window", () => {
    const { contents } = confined({ subframes: false })
    expect(contents.openWindow()).toEqual({ action: "deny" })
  })

  it("refuses a subframe navigation off the permitted addresses only when asked to", () => {
    const guarded = confined({ subframes: true })
    const inFrame = navigation("https://evil.example/", false)
    guarded.contents.emit("will-frame-navigate", inFrame)
    expect(inFrame.preventDefault).toHaveBeenCalled()

    const unguarded = confined({ subframes: false })
    const elsewhere = navigation("https://evil.example/", false)
    unguarded.contents.emit("will-frame-navigate", elsewhere)
    expect(elsewhere.preventDefault).not.toHaveBeenCalled()
  })

  function confined(options: { subframes: boolean }) {
    const contents = fakeContents()
    const warn = vi.fn()
    confine(contents, onHub, warn, options)
    return { contents, warn }
  }
})

function navigation(url: string, isMainFrame: boolean) {
  return { url, isMainFrame, preventDefault: vi.fn() }
}

/** A page's contents that records its listeners, so a test can `emit` what Electron would. */
function fakeContents() {
  const listeners = new Map<string, Array<(details: ReturnType<typeof navigation>) => void>>()
  let openHandler: () => unknown = () => undefined
  return {
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
