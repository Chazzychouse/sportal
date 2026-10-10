import { readFileSync } from "node:fs"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"
import { YouTubeTv } from "./YouTubeTv.ts"

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
  const youTubeTv = yield* YouTubeTv

  yield* youTubeTv.readGuide(recordedGuide)
})

/** A guide response with one row, News 3 airing Ohio State at Iowa, whose live id is `videoId`. */
export function oneRowGuide(videoId: string) {
  const row = {
    station: {
      epgStationRenderer: {
        stationId: "UCPc5PkgTSfcJCi3-dJyg3Tg",
        icon: { accessibility: { accessibilityData: { label: "News 3" } } }
      }
    },
    navigationEndpoint: { watchEndpoint: { videoId } },
    airings: [
      {
        epgAiringRenderer: {
          beginTimeMs: String(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T19:35:00Z"))),
          endTimeMs: String(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T23:00:00Z"))),
          title: { runs: [{ text: "Ohio State at Iowa" }] }
        }
      }
    ]
  }
  return JSON.stringify({
    contents: {
      epgRenderer: { paginationRenderer: { epgPaginationRenderer: { contents: [{ epgRowRenderer: row }] } } }
    }
  })
}
