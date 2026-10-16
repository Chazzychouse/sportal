import { Effect, Stream } from "effect"
import { Shell } from "../shell/Shell.ts"
import { logDefect, runtime } from "../WebRuntime.ts"
import { HubClient } from "./HubClient.ts"
import { Connection, HubSocket } from "./HubSocket.ts"

/**
 * Passes each guide the shell reads to the Hub, and asks the shell to read again each time the Hub socket connects,
 * since a guide read while the Hub was away was lost. Mounted once, by the Display.
 */
export const relay = runtime.atom(
  Effect.gen(function* () {
    const shell = yield* Shell
    const hub = yield* HubClient
    const socket = yield* HubSocket

    // Listening first, then asking: the shell's first read waits for the web UI to ask.
    // Each send in a fiber of its own, so a send that dies ends only itself.
    yield* shell.guideRead.pipe(
      Stream.runForEach((guide) =>
        hub.sendGuide(guide).pipe(
          Effect.catch((failure) => Effect.logWarning("The Hub did not take a guide", failure)),
          logDefect("The guide send"),
          Effect.forkScoped
        )
      ),
      Effect.forkScoped({ startImmediately: true })
    )
    yield* socket.connection.pipe(
      Stream.map(Connection.$is("Connected")),
      Stream.changes,
      Stream.filter((connected) => connected),
      Stream.runForEach(() => shell.readGuide)
    )
  }).pipe(logDefect("The guide relay"))
)
