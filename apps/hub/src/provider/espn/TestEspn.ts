import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Layer } from "effect"
import * as Socket from "effect/socket/Socket"

/** A WebSocket constructor for tests that never push: opening a socket throws. */
export const noSocket = Layer.succeed(Socket.WebSocketConstructor, () => {
  throw new Error("this test opens no socket")
})

/** A recorded ESPN site scoreboard from this adapter's fixtures, for tests of other modules. */
export function recordedScoreboard(name: "fbs-scoreboard-2026-10-03T2024Z" | "nfl-scoreboard-pregame") {
  return readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")
}

/** ESPN's NFL FastCast scoreboard checkpoint of 2026-10-04 at 17:52Z (mid 4286637), as its checkpoint frame's body. */
export function recordedCheckpoint() {
  return readFileSync(
    new URL("./fixtures/nfl-fastcast-checkpoint-2026-10-04T1752Z.json", import.meta.url),
    "utf8"
  )
}

/**
 * This adapter's fixtures folder, where NE at BUF's frames on 2026-10-04 are kept as the recorded scenario
 * `neAtBufFrames`: imported from the recording, its game topic's frames and every scoreboard poll of the day, trimmed
 * to it.
 */
export const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
export const neAtBufFrames = "nfl-2026-10-04-ne-buf"
