import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"

vi.mock("electron", () => ({
  session: { fromPartition: vi.fn() },
  WebContentsView: vi.fn()
}))

const { allows, grantsPermission, hostOf, loadErrorCode } = await import("./ProviderSession.ts")

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
