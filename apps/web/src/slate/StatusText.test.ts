import { assert, describe, it } from "@effect/vitest"
import { snapshot } from "@sportal/domain/TestGame"
import { localTime } from "../LocalTime.ts"
import { statusText } from "./StatusText.ts"

describe("statusText", () => {
  it.each([
    [{ status: "live", period: 2, clock: "7:31" }, "Q2 7:31"],
    [{ status: "live", period: 5, clock: "10:00" }, "OT 10:00"],
    [{ status: "live", period: 6, clock: "10:00" }, "2OT 10:00"],
    [{ status: "live", period: 7, clock: "10:00" }, "3OT 10:00"],
    [{ status: "halftime", period: 2, clock: "0:00" }, "Half"],
    [{ status: "delayed", period: 2, clock: "5:00" }, "Delayed"],
    [{ status: "final", period: 4, clock: "0:00" }, "Final"],
    [{ status: "final", period: 5, clock: "0:00" }, "Final/OT"],
    [{ status: "postponed" }, "Postponed"],
    [{ status: "canceled" }, "Canceled"]
  ] as const)("reads %j as %s", (overrides, text) => {
    assert.strictEqual(statusText(snapshot(overrides)), text)
  })

  it("reads a scheduled game as its local kickoff time", () => {
    const game = snapshot({ status: "scheduled" })
    assert.strictEqual(statusText(game), localTime(game.kickoff))
  })
})
