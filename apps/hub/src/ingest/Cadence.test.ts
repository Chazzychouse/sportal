import { assert, describe, it } from "@effect/vitest"
import { liveSnapshot, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Duration } from "effect"
import * as Cadence from "./Cadence.ts"

const now = DateTime.makeUnsafe("2026-10-03T12:00:00Z")

describe("Cadence.interval", () => {
  it("polls every 10 seconds while a game is live", () => {
    const slate = [liveSnapshot({ kickoff: DateTime.makeUnsafe("2026-10-03T11:00:00Z") })]
    assert.deepStrictEqual(Cadence.interval(slate, now, false), Duration.seconds(10))
  })

  it("polls every 10 seconds while the only game is delayed in the second quarter", () => {
    const slate = [
      snapshot({ status: "delayed", period: 2, kickoff: DateTime.makeUnsafe("2026-10-03T11:00:00Z") })
    ]
    assert.deepStrictEqual(Cadence.interval(slate, now, false), Duration.seconds(10))
  })

  it("polls every minute when a kickoff is within 30 minutes", () => {
    const slate = [snapshot({ kickoff: DateTime.makeUnsafe("2026-10-03T12:20:00Z") })]
    assert.deepStrictEqual(Cadence.interval(slate, now, false), Duration.minutes(1))
  })

  it("polls every 15 minutes when the next kickoff is more than 30 minutes away", () => {
    const slate = [snapshot({ kickoff: DateTime.makeUnsafe("2026-10-03T13:00:00Z") })]
    assert.deepStrictEqual(Cadence.interval(slate, now, false), Duration.minutes(15))
  })

  it("retries after 30 seconds when a poll failed and the slate is empty", () => {
    assert.deepStrictEqual(Cadence.interval([], now, true), Duration.seconds(30))
  })

  it("keeps the live cadence when a poll failed during a live game", () => {
    const slate = [liveSnapshot({ kickoff: DateTime.makeUnsafe("2026-10-03T11:00:00Z") })]
    assert.deepStrictEqual(Cadence.interval(slate, now, true), Duration.seconds(10))
  })
})
