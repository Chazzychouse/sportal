import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Exit, Schema } from "effect"
import { bounds, dates, GameDay } from "./GameDay.ts"

describe("GameDay", () => {
  it.effect("should accept a YYYY-MM-DD date", () =>
    Effect.gen(function* () {
      const day = yield* Schema.decodeEffect(GameDay)("2026-10-04")

      assert.strictEqual(day, "2026-10-04")
    })
  )

  it.effect.each(["2026-10-4", "20261004", "2026-02-30", "2026-10-04T12:00:00Z"])(
    "should refuse a date that is not YYYY-MM-DD: %s",
    (date) =>
      Effect.gen(function* () {
        const exit = yield* Schema.decodeEffect(GameDay)(date).pipe(Effect.exit)

        assert.isTrue(Exit.isFailure(exit))
      })
  )
})

describe("GameDay.bounds", () => {
  it("should run from 04:00 local on the day until 04:00 the next, across a change of clocks", () => {
    const zone = DateTime.zoneMakeNamedUnsafe("America/New_York")

    const { from, until } = bounds(GameDay.make("2026-10-31"), zone)

    assert.deepStrictEqual(
      [DateTime.formatIso(from), DateTime.formatIso(until)],
      ["2026-10-31T08:00:00.000Z", "2026-11-01T09:00:00.000Z"]
    )
  })
})

describe("GameDay.dates", () => {
  it("should list every day from one to another, both included, across a month's end", () => {
    const listed: ReadonlyArray<string> = dates(GameDay.make("2026-09-29"), GameDay.make("2026-10-02"))

    assert.deepStrictEqual(listed, ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"])
  })

  it("should list the one day when both are the same", () => {
    const listed: ReadonlyArray<string> = dates(GameDay.make("2026-10-04"), GameDay.make("2026-10-04"))

    assert.deepStrictEqual(listed, ["2026-10-04"])
  })

  it("should list none when the last is before the first", () => {
    const listed: ReadonlyArray<string> = dates(GameDay.make("2026-10-04"), GameDay.make("2026-10-03"))

    assert.deepStrictEqual(listed, [])
  })
})
