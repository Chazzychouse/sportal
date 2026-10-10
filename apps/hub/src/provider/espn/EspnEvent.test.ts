import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { EspnEvent } from "./EspnEvent.ts"

// How each recorded feed's events decode is locked in EspnState's tests; these are the cases a recording lacks.
describe("EspnEvent", () => {
  it("should decode a site scoreboard event", () => {
    const event = siteEvent()

    const decoded = decode(event)

    assert.isTrue(Result.isSuccess(decoded))
  })

  it("should not decode a site scoreboard event missing a competitor", () => {
    const event = siteEvent()
    const [competition] = event.competitions
    const homeOnly = {
      ...event,
      competitions: [{ ...competition, competitors: competition.competitors.filter(isHome) }]
    }

    const decoded = decode(homeOnly)

    assert.isTrue(Result.isFailure(decoded))
  })
})

const decode = Schema.decodeUnknownResult(EspnEvent("nfl"))

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

const Competitor = Schema.StructWithRest(Schema.Struct({ homeAway: Schema.String }), [
  Schema.Record(Schema.String, Schema.Json)
])

function siteEvent() {
  return Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Struct({
        events: Schema.NonEmptyArray(
          Schema.StructWithRest(
            Schema.Struct({
              competitions: Schema.NonEmptyArray(
                Schema.StructWithRest(Schema.Struct({ competitors: Schema.Array(Competitor) }), [
                  Schema.Record(Schema.String, Schema.Json)
                ])
              )
            }),
            [Schema.Record(Schema.String, Schema.Json)]
          )
        )
      })
    )
  )(fixture("nfl-scoreboard-2026-10-04T1800Z.json")).events[0]
}

function isHome(competitor: { readonly homeAway: string }): boolean {
  return competitor.homeAway === "home"
}
