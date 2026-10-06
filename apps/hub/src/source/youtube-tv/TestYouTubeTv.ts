import { readFileSync } from "node:fs"

/** The first page of YouTube TV's live guide, read 2026-10-03T20:24:45Z, for tests of other modules. */
export const recordedGuide = readFileSync(
  new URL("./fixtures/guide-2026-10-03T2024Z.json", import.meta.url),
  "utf8"
)
