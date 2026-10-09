import { readFileSync } from "node:fs"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"
import { GuideReader } from "../GuideReader.ts"

/** The first page of YouTube TV's live guide, read 2026-10-03T20:24:45Z, for tests of other modules. */
export const recordedGuide = readFileSync(
  new URL("./fixtures/guide-2026-10-03T2024Z.json", import.meta.url),
  "utf8"
)

/** When the recorded guide was read, in epoch milliseconds for the test clock. */
export const recordedAt = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T20:24:45Z"))

/** Reads the recorded guide on the test clock at the moment it was recorded. */
export const readRecordedGuide = Effect.gen(function* () {
  yield* TestClock.setTime(recordedAt)
  const reader = yield* GuideReader

  yield* reader.readGuide(recordedGuide)
})
