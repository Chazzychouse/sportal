import { vi } from "vitest"

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
