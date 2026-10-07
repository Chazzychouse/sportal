import { Effect, Layer, Logger, Stream } from "effect"
import type { BrowserWindow } from "electron"
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
    Layer.succeed(ShellConfig, ShellConfig.of({ hubUrl: "http://127.0.0.1:4401" })),
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
