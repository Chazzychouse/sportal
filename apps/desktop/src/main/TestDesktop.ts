import { Effect, Layer, Logger, Option, Stream } from "effect"
import type { BrowserWindow } from "electron"
import { vi } from "vitest"
import { ShellConfig } from "./ShellConfig.ts"
import { ShellWindow } from "./ShellWindow.ts"

/**
 * The shell around a service under test: the web UI on the dev server, `window` as the shell window, and
 * every log's message pushed to `logs`.
 */
export function shellOf(window: BrowserWindow, logs: Array<string> = []) {
  const capture = Logger.make<unknown, void>(({ message }) => {
    logs.push(String(Array.isArray(message) ? message[0] : message))
  })
  return Layer.mergeAll(
    Layer.succeed(
      ShellConfig,
      ShellConfig.of({ hubUrl: "http://127.0.0.1:4401", embeddedHub: Option.none() })
    ),
    Layer.succeed(ShellWindow, window),
    Logger.layer([capture])
  )
}

/** Starts collecting the first `count` values a shell service streams, subscribed before this returns. */
export function collect<A>(stream: Stream.Stream<A>, count: number) {
  return Effect.gen(function* () {
    const fiber = yield* stream.pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    return fiber
  })
}

/**
 * A page's contents that records its listeners, so a test can `emit` what Electron would. `load` answers
 * `loadURL`; by default every page loads.
 */
export function fakeContents(load: () => Promise<void> = () => Promise.resolve()) {
  const listeners = new Map<string, Array<(...args: Array<unknown>) => void>>()
  let openHandler: () => unknown = () => undefined
  return {
    loadURL: vi.fn(load),
    setAudioMuted: vi.fn(),
    close: vi.fn(),
    focus: vi.fn(),
    isDestroyed: () => false,
    on: vi.fn((event: string, listener: (...args: Array<unknown>) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    setWindowOpenHandler: (handler: () => unknown) => {
      openHandler = handler
    },
    emit: (event: string, ...args: Array<unknown>) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    openWindow: () => openHandler()
  }
}

/** A navigation Electron reports to `will-navigate` and its kin, with a spy for its refusal. */
export function navigation(url: string, isMainFrame: boolean) {
  return { url, isMainFrame, preventDefault: vi.fn() }
}
