import { createHash } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Logger, Stream } from "effect"
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
  WebContentsView: vi.fn()
}))

const { ProviderSession } = await import("./ProviderSession.ts")
const { GuideReader } = await import("./GuideReader.ts")

// The second config holds the context, and the first has a brace inside a string, as real pages do.
const guidePage = [
  '<script>ytcfg.set({"EXPERIMENT_FLAGS":{"note":"a } in a string"}});</script>',
  '<script>ytcfg.set({"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB_UNPLUGGED","clientVersion":"1.20260930.04.00"}}});</script>'
].join("")

describe("GuideReader", () => {
  it.effect("reads when asked: the guide request the page would send, signed as the account", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      const guides = yield* collect(reader.guides, 1)
      yield* reader.readSoon
      yield* settle

      expect(yield* Fiber.join(guides)).toEqual(["the guide"])
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

  it.effect("does not read until asked, then reads every 5 minutes", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      yield* settle
      yield* TestClock.adjust("20 minutes") // the web UI has not asked, so nothing is read
      yield* settle
      expect(sent).not.toHaveBeenCalled()
      yield* reader.readSoon
      yield* settle
      expect(sent).toHaveBeenCalledTimes(2)
      yield* TestClock.adjust("5 minutes")
      yield* settle
      expect(sent).toHaveBeenCalledTimes(4)
    }).pipe(Effect.scoped)
  )

  it.effect("logs a refused guide request as a likely sign-out, and reads again later", () =>
    Effect.gen(function* () {
      const logs: Array<string> = []
      const reader = yield* attached(logs)
      const guides = yield* collect(reader.guides, 1)
      answers.guide = { status: 401, body: "" }
      yield* reader.readSoon
      yield* settle
      expect(logs).toEqual([
        "GuideReader: the guide could not be read: /youtubei/v1/browse answered 401 (signed out of YouTube TV?)"
      ])
      answers.guide = { status: 200, body: "the guide" }
      yield* TestClock.adjust("5 minutes")
      yield* settle
      expect(yield* Fiber.join(guides)).toEqual(["the guide"])
    }).pipe(Effect.scoped)
  )

  it.effect("sends no guide request when the guide page has no client config", () =>
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

  it.effect("sends no guide request when the session is not signed in", () =>
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

/** Lets forked fibers and resolved promises run. */
const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve))).pipe(
  Effect.repeat({ times: 5 })
)

function collect<A>(stream: Stream.Stream<A>, count: number) {
  return Effect.gen(function* () {
    const fiber = yield* stream.pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    return fiber
  })
}

function attached(logs: Array<string> = []) {
  sent.mockClear()
  answers.page = guidePage
  answers.guide = { status: 200, body: "the guide" }
  answers.cookies = [{ name: "SAPISID", value: "the-sapisid" }]
  const capture = Logger.make<unknown, void>(({ message }) => {
    logs.push(String(Array.isArray(message) ? message[0] : message))
  })
  return Layer.build(
    GuideReader.layer.pipe(Layer.provide(ProviderSession.layer), Layer.provide(Logger.layer([capture])))
  ).pipe(Effect.map((context) => Context.get(context, GuideReader)))
}
