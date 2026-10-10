import { Effect, Stream } from "effect"
import { Shell } from "../shell/Shell.ts"
import { runtime } from "../WebRuntime.ts"
import { HubClient } from "./HubClient.ts"
import * as LiveStream from "./LiveStream.ts"

/**
 * Passes each guide the shell reads to the Hub, and asks the shell to read again each time the live stream connects,
 * since a guide read while the Hub was away was lost. Mounted once, by the Display.
 */
export const relay = runtime.atom((get) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const hub = yield* HubClient

    // Listening first, then asking: the shell's first read waits for the web UI to ask.
    // Each send in a fiber of its own, so a send that dies (already logged) ends only itself.
    yield* shell.guideRead.pipe(
      Stream.runForEach((guide) =>
        hub.sendGuide(guide).pipe(
          Effect.catch((failure) => Effect.logWarning("The Hub did not take a guide", failure)),
          Effect.forkScoped
        )
      ),
      Effect.forkScoped({ startImmediately: true })
    )
    yield* get.stream(LiveStream.live).pipe(
      Stream.map(({ connection }) => LiveStream.Connection.$is("Connected")(connection)),
      Stream.changes,
      Stream.filter((connected) => connected),
      Stream.runForEach(() => shell.readGuide)
    )
  })
)
