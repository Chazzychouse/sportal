import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"
import { confine, hostOf, load } from "./Navigation.ts"
import * as TestDesktop from "./TestDesktop.ts"

describe("hostOf", () => {
  it("should keep only the hostname, dropping any path or query that could carry a token", () => {
    const host = hostOf("https://tv.youtube.com/watch/abc?token=secret")

    expect(host).toBe("tv.youtube.com")
  })

  it("should name an address it cannot parse without repeating it", () => {
    const host = hostOf("not a url")

    expect(host).toBe("(unparseable address)")
  })
})

describe("load", () => {
  it.effect("should fail with the code Electron attaches to a failed load, never its message", () =>
    Effect.gen(function* () {
      const error = Object.assign(new Error("ERR_ABORTED (-3) loading 'https://x/?t=1'"), {
        code: "ERR_ABORTED"
      })

      const failure = yield* load(failing(error), "https://x/?t=1").pipe(Effect.flip)

      expect(failure.code).toBe("ERR_ABORTED")
    })
  )

  it.effect.each([new Error("no code"), "a string", undefined])(
    "should fail with an unknown code for %s",
    (error) =>
      Effect.gen(function* () {
        const failure = yield* load(failing(error), "https://x/").pipe(Effect.flip)

        expect(failure.code).toBe("unknown")
      })
  )

  it.effect("should succeed when the page loads", () =>
    load({ loadURL: () => Promise.resolve() }, "https://x/")
  )
})

describe("confine", () => {
  it.each(["will-navigate", "will-redirect"])(
    "should refuse a %s off the permitted addresses, saying where",
    (event) => {
      const { contents, warn } = confined({ subframes: false })
      const refused = TestDesktop.navigation("https://evil.example/path?token=secret", true)

      contents.emit(event, refused)

      expect(refused.preventDefault).toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith("refused navigation to evil.example")
    }
  )

  it("should let a permitted navigation through", () => {
    const { contents, warn } = confined({ subframes: false })
    const allowed = TestDesktop.navigation("http://hub/screen", true)

    contents.emit("will-navigate", allowed)

    expect(allowed.preventDefault).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it("should never open a new window", () => {
    const { contents } = confined({ subframes: false })

    const opened = contents.openWindow()

    expect(opened).toEqual({ action: "deny" })
  })

  it("should refuse a subframe navigation off the permitted addresses when asked to", () => {
    const { contents } = confined({ subframes: true })
    const inFrame = TestDesktop.navigation("https://evil.example/", false)

    contents.emit("will-frame-navigate", inFrame)

    expect(inFrame.preventDefault).toHaveBeenCalled()
  })

  it("should let a subframe navigation off the permitted addresses through when not asked to", () => {
    const { contents } = confined({ subframes: false })
    const elsewhere = TestDesktop.navigation("https://evil.example/", false)

    contents.emit("will-frame-navigate", elsewhere)

    expect(elsewhere.preventDefault).not.toHaveBeenCalled()
  })
})

function failing(error: unknown) {
  return { loadURL: () => Promise.reject(error) }
}

/** Page contents confined to the Hub's addresses, with a spy for the warnings. */
function confined(options: { subframes: boolean }) {
  const contents = TestDesktop.fakeContents()
  const warn = vi.fn()
  confine(contents, (url) => url.startsWith("http://hub/"), warn, options)
  return { contents, warn }
}
