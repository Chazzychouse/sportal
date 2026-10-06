import { readFileSync } from "node:fs"
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
 * Where NE at BUF's frames on 2026-10-04 are, for `readFrames`: imported from the recording with
 * `pnpm --filter @sportal/hub feed:import --recording …/2026-10-04/nfl --games 401872971 --out …`, its game topic's
 * frames and every scoreboard poll of the day, trimmed to it.
 */
export const neAtBufFrames = new URL("./fixtures/nfl-2026-10-04-ne-buf.frames.jsonl.gz", import.meta.url)
  .pathname
