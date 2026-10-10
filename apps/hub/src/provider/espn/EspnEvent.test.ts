import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { GameSnapshot } from "@sportal/domain/Game"
import { Effect, Result, Schema } from "effect"
import { listingOf } from "./EspnEvent.ts"

describe("listingOf", () => {
  // Each recorded poll as it decoded when both feeds' events were read by one transform.
  it.effect("should decode each listing", () =>
    Effect.gen(function* () {
      const expected = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            deliveries: Schema.Array(
              Schema.Struct({ league: Schema.String, games: Schema.Array(Schema.Json) })
            )
          })
        )
      )(fixture("decoded-snapshots.json"))

      const fbs = yield* listingOf("fbs", fixture("fbs-scoreboard-live.json"))
      const nfl = yield* listingOf("nfl", scoreboardBody)

      assert.deepStrictEqual(
        encoded([
          { league: "fbs", games: fbs.map((game) => encode(game)) },
          { league: "nfl", games: nfl.map((game) => encode(game)) }
        ]),
        expected.deliveries.map(({ league, games }) => ({ league, games }))
      )
    })
  )

  it.effect("should read a poll response as its league's listing", () =>
    Effect.gen(function* () {
      const games = yield* listingOf("nfl", scoreboardBody)

      assert.strictEqual(games.length, 16)
      assert.isTrue(games.every((game) => game.league === "nfl"))
    })
  )

  it.effect("should skip an event that does not decode, and list the rest", () =>
    Effect.gen(function* () {
      const { events } = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ events: Schema.Array(Schema.Json) }))
      )(scoreboardBody)
      const withBroken = JSON.stringify({ events: [{ id: "broken" }, ...events] })

      const games = yield* listingOf("nfl", withBroken)

      assert.strictEqual(games.length, events.length)
    })
  )

  // How each recorded feed's events decode is locked above; these are the cases a recording lacks.
  it.effect("should list a site scoreboard event", () =>
    Effect.gen(function* () {
      const event = siteEvent()

      const games = yield* listingOf("nfl", JSON.stringify({ events: [event] }))

      assert.lengthOf(games, 1)
    })
  )

  it.effect("should skip a site scoreboard event missing a competitor", () =>
    Effect.gen(function* () {
      const event = siteEvent()
      const [competition] = event.competitions
      const homeOnly = {
        ...event,
        competitions: [{ ...competition, competitors: competition.competitors.filter(isHome) }]
      }

      const games = yield* listingOf("nfl", JSON.stringify({ events: [homeOnly] }))

      assert.lengthOf(games, 0)
    })
  )

  it.effect("should fail a body that is not a scoreboard", () =>
    Effect.gen(function* () {
      const listed = yield* Effect.result(listingOf("nfl", "not json"))

      assert.isTrue(Result.isFailure(listed))
    })
  )
})

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
// Recorded from ESPN on 2026-10-04: the NFL scoreboard polled at 18:00Z.
const scoreboardBody = fixture("nfl-scoreboard-2026-10-04T1800Z.json")
const encode = Schema.encodeSync(GameSnapshot)
const encoded = (value: unknown) => JSON.parse(JSON.stringify(value))

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
