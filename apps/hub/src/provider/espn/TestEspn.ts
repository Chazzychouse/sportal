import { readFileSync } from "node:fs"

/** A recorded ESPN site scoreboard from this adapter's fixtures, for tests of other modules. */
export function recordedScoreboard(name: "fbs-scoreboard-2026-10-03T2024Z" | "nfl-scoreboard-pregame") {
  return readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")
}

/**
 * Where NE at BUF's frames on 2026-10-04 are, for `readFrames`: imported from the recording with
 * `pnpm --filter @sportal/hub feed:import --recording …/2026-10-04/nfl --games 401872971 --out …`, its game topic's
 * frames and every scoreboard poll of the day, trimmed to it.
 */
export const neAtBufFrames = new URL("./fixtures/nfl-2026-10-04-ne-buf.frames.jsonl.gz", import.meta.url)
  .pathname
