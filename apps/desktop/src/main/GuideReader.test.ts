import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"

const created: Array<{ webContents: ReturnType<typeof fakeContents> }> = []

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
const { GuideReader } = await import("./GuideReader.ts")

const guideRequest = {
  url: "https://tv.youtube.com/youtubei/v1/browse?prettyPrint=false",
  postData: JSON.stringify({ browseId: "FEunplugged_epg" })
}
const overlaysRequest = {
  url: "https://tv.youtube.com/youtubei/v1/browse?prettyPrint=false",
  postData: JSON.stringify({ browseId: "FEunplugged_overlays" })
}

describe("GuideReader", () => {
  it.effect("opens the guide when asked, publishes the guide response, and closes the view", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      const guides = yield* collect(reader.guides, 1)
      yield* reader.readSoon
      yield* settle
      const contents = created[0]?.webContents
      expect(contents?.loadURL).toHaveBeenCalledWith("https://tv.youtube.com/live")
      expect(contents?.setAudioMuted).toHaveBeenCalledWith(true)

      contents?.inspector.respond("1", "the guide")
      contents?.inspector.respond("2", "the overlays")
      contents?.inspector.emit("Network.requestWillBeSent", { requestId: "2", request: overlaysRequest })
      contents?.inspector.emit("Network.requestWillBeSent", { requestId: "1", request: guideRequest })
      contents?.inspector.emit("Network.loadingFinished", { requestId: "2" })
      contents?.inspector.emit("Network.loadingFinished", { requestId: "1" })

      expect(yield* Fiber.join(guides)).toEqual(["the guide"])
      yield* settle
      expect(contents?.close).toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("does not open the guide until asked, then reads it every 15 minutes", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      yield* settle
      expect(created).toHaveLength(0)
      yield* reader.readSoon
      yield* settle
      expect(created).toHaveLength(1)
      yield* TestClock.adjust("31 seconds") // the first read gives up
      yield* TestClock.adjust("15 minutes")
      yield* settle
      expect(created).toHaveLength(2)
    }).pipe(Effect.scoped)
  )

  it.effect("gives up after 30 seconds without a guide response, closing the view", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      const guides = yield* collect(reader.guides, 1)
      yield* reader.readSoon
      yield* settle
      yield* TestClock.adjust("30 seconds")
      yield* settle
      expect(created[0]?.webContents.close).toHaveBeenCalled()
      expect(guides.pollUnsafe()).toBeUndefined()
    }).pipe(Effect.scoped)
  )

  it.effect("reads at most once in two minutes however often it is asked", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      yield* reader.readSoon
      yield* settle
      yield* TestClock.adjust("30 seconds")
      yield* reader.readSoon
      yield* reader.readSoon
      yield* settle
      expect(created).toHaveLength(1)
      // The first read ended at 30 seconds; the next may start two minutes after that.
      yield* TestClock.adjust("2 minutes")
      yield* settle
      expect(created).toHaveLength(2)
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

function attached() {
  created.length = 0
  return Layer.build(GuideReader.layer.pipe(Layer.provide(ProviderSession.layer))).pipe(
    Effect.map((context) => Context.get(context, GuideReader))
  )
}

/** A debugger that records its listener, so a test can emit protocol events and set response bodies. */
function fakeInspector() {
  const bodies = new Map<string, string>()
  let listener: ((event: unknown, method: string, params: unknown) => void) | undefined
  return {
    attach: vi.fn(),
    detach: vi.fn(),
    isAttached: () => true,
    on: vi.fn((_event: "message", next: typeof listener) => {
      listener = next
    }),
    removeListener: vi.fn(),
    sendCommand: vi.fn((method: string, params?: { requestId?: string }) =>
      Promise.resolve(
        method === "Network.getResponseBody"
          ? { body: bodies.get(params?.requestId ?? "") ?? "", base64Encoded: false }
          : {}
      )
    ),
    respond: (requestId: string, body: string) => bodies.set(requestId, body),
    emit: (method: string, params: unknown) => listener?.({}, method, params)
  }
}

function fakeContents() {
  const inspector = fakeInspector()
  return {
    loadURL: vi.fn(() => Promise.resolve()),
    setAudioMuted: vi.fn(),
    close: vi.fn(),
    isDestroyed: () => false,
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    debugger: inspector,
    inspector
  }
}
