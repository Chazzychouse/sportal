import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { EspnEvent } from "./EspnEvent.ts"

// How each recorded feed's events decode is locked in EspnDecode's tests; these are the cases a recording lacks.
describe("EspnEvent", () => {
  it("a site scoreboard event missing a competitor does not decode", () => {
    const event = siteEvent()
    const [competition] = event.competitions
    const homeOnly = {
      ...event,
      competitions: [{ ...competition, competitors: competition.competitors.filter(isHome) }]
    }

    assert.isTrue(Result.isSuccess(decode(event)))
    assert.isTrue(Result.isFailure(decode(homeOnly)))
  })

  it("a FastCast event missing a competitor does not decode", () => {
    const event = fastCastEvent()

    assert.isTrue(Result.isSuccess(decode(event)))
    assert.isTrue(Result.isFailure(decode({ ...event, competitors: event.competitors.filter(isHome) })))
  })
})

const decode = Schema.decodeUnknownResult(EspnEvent("nfl"))

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

const Competitor = Schema.StructWithRest(Schema.Struct({ homeAway: Schema.String }), [
  Schema.Record(Schema.String, Schema.Json)
])

function siteEvent() {
  return Schema.decodeUnknownSync(
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

function fastCastEvent() {
  return Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        sports: Schema.NonEmptyArray(
          Schema.Struct({
            leagues: Schema.NonEmptyArray(
              Schema.Struct({
                events: Schema.NonEmptyArray(
                  Schema.StructWithRest(Schema.Struct({ competitors: Schema.Array(Competitor) }), [
                    Schema.Record(Schema.String, Schema.Json)
                  ])
                )
              })
            )
          })
        )
      })
    )
  )(fixture("nfl-fastcast-checkpoint-2026-10-04T1752Z.json")).sports[0].leagues[0].events[0]
}

function isHome(competitor: { readonly homeAway: string }): boolean {
  return competitor.homeAway === "home"
}
