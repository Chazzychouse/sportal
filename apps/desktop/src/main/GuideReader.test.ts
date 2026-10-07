import { createHash } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"

/** What the provider session answers; each test sets what it needs before it asks for a read. */
const answers = {
  page: "",
  guide: { status: 200, body: "" },
  cookies: [] as Array<{ name: string; value: string }>
}
const sent = vi.fn((url: string, _init?: RequestInit) =>
  Promise.resolve(
    url === "https://tv.youtube.com/live"
      ? new Response(answers.page)
      : new Response(answers.guide.body, { status: answers.guide.status })
  )
)

vi.mock("electron", () => ({
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      fetch: sent,
      cookies: { get: () => Promise.resolve(answers.cookies) }
    })
  },
  WebContentsView: vi.fn(),
  BrowserWindow: class {}
}))

const { ProviderSession } = await import("./ProviderSession.ts")
const { GuideReader } = await import("./GuideReader.ts")
const { collect, shellOf } = await import("./TestShell.ts")
const { BrowserWindow } = await import("electron")

describe("GuideReader", () => {
  it.effect("should read when asked, sending the guide request the page would, signed as the account", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      const guides = yield* collect(reader.guides, 1)

      yield* reader.readSoon
      yield* settle
      const read = yield* Fiber.join(guides)

      expect(read).toEqual(["the guide"])
      expect(sent.mock.calls.map(([url]) => url)).toEqual([
        "https://tv.youtube.com/live",
        "https://tv.youtube.com/youtubei/v1/browse?prettyPrint=false"
      ])
      const init = sent.mock.calls[1]?.[1]
      const hash = createHash("sha1").update("0 the-sapisid https://tv.youtube.com").digest("hex")
      expect(init).toMatchObject({
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://tv.youtube.com",
          "x-origin": "https://tv.youtube.com",
          authorization: `SAPISIDHASH 0_${hash}`
        }
      })
      expect(JSON.parse(String(init?.body))).toEqual({
        context: { client: { clientName: "WEB_UNPLUGGED", clientVersion: "1.20260930.04.00" } },
        browseId: "FEunplugged_epg"
      })
    }).pipe(Effect.scoped)
  )

  it.effect("should not read until asked", () =>
    Effect.gen(function* () {
      yield* attached()
      yield* settle

      yield* TestClock.adjust("20 minutes")
      yield* settle

      expect(sent).not.toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("should read once when asked", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      yield* settle
      yield* TestClock.adjust("20 minutes")
      yield* settle

      yield* reader.readSoon
      yield* settle

      expect(sent).toHaveBeenCalledTimes(2)
    }).pipe(Effect.scoped)
  )

  it.effect("should read again every 5 minutes once asked", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      yield* settle
      yield* TestClock.adjust("20 minutes")
      yield* settle
      yield* reader.readSoon
      yield* settle

      yield* TestClock.adjust("5 minutes")
      yield* settle

      expect(sent).toHaveBeenCalledTimes(4)
    }).pipe(Effect.scoped)
  )

  it.effect("should log a refused guide request as a likely sign-out", () =>
    Effect.gen(function* () {
      const logs: Array<string> = []
      const reader = yield* attached(logs)
      answers.guide = { status: 401, body: "" }

      yield* reader.readSoon
      yield* settle

      expect(logs).toEqual([
        "GuideReader: the guide could not be read: /youtubei/v1/browse answered 401 (signed out of YouTube TV?)"
      ])
    }).pipe(Effect.scoped)
  )

  it.effect("should read again 5 minutes after a refused guide request", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      const guides = yield* collect(reader.guides, 1)
      answers.guide = { status: 401, body: "" }
      yield* reader.readSoon
      yield* settle
      answers.guide = { status: 200, body: "the guide" }

      yield* TestClock.adjust("5 minutes")
      yield* settle
      const read = yield* Fiber.join(guides)

      expect(read).toEqual(["the guide"])
    }).pipe(Effect.scoped)
  )

  it.effect("should send no guide request when the guide page has no client config", () =>
    Effect.gen(function* () {
      const logs: Array<string> = []
      const reader = yield* attached(logs)
      answers.page = "<html></html>"

      yield* reader.readSoon
      yield* settle

      expect(sent).toHaveBeenCalledTimes(1)
      expect(logs).toEqual(["GuideReader: the guide could not be read: the guide page has no client config"])
    }).pipe(Effect.scoped)
  )

  it.effect("should send no guide request when the session is not signed in", () =>
    Effect.gen(function* () {
      const logs: Array<string> = []
      const reader = yield* attached(logs)
      answers.cookies = []

      yield* reader.readSoon
      yield* settle

      expect(sent).toHaveBeenCalledTimes(1)
      expect(logs).toEqual([
        "GuideReader: the guide could not be read: the session has no YouTube sign-in (SAPISID)"
      ])
    }).pipe(Effect.scoped)
  )
})

// The second config holds the context, and the first has a brace inside a string, as real pages do.
const guidePage = [
  '<script>ytcfg.set({"EXPERIMENT_FLAGS":{"note":"a } in a string"}});</script>',
  '<script>ytcfg.set({"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB_UNPLUGGED","clientVersion":"1.20260930.04.00"}}});</script>'
].join("")

/** Lets forked fibers and resolved promises run. */
const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve))).pipe(
  Effect.repeat({ times: 5 })
)

/** The guide reader on the real provider session, with Electron mocked; every answer starts signed in. */
function attached(logs: Array<string> = []) {
  sent.mockClear()
  answers.page = guidePage
  answers.guide = { status: 200, body: "the guide" }
  answers.cookies = [{ name: "SAPISID", value: "the-sapisid" }]
  return Layer.build(
    GuideReader.layer.pipe(
      Layer.provide(ProviderSession.layer),
      Layer.provide(shellOf(new BrowserWindow(), logs))
    )
  ).pipe(Effect.map((context) => Context.get(context, GuideReader)))
}
