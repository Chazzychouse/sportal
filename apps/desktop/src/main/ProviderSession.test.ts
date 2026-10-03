import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"

vi.mock("electron", () => ({
  session: { fromPartition: vi.fn() },
  WebContentsView: vi.fn()
}))

const { allows, grantsPermission } = await import("./ProviderSession.ts")

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
