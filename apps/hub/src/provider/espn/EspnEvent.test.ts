import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { GameSnapshot, Network } from "@sportal/domain/Game"
import { Effect, Equal, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Delivery } from "../Provider.ts"
import * as EspnEvent from "./EspnEvent.ts"
import * as TestEspn from "./TestEspn.ts"

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

      const fbs = yield* EspnEvent.listingOf("fbs", fixture("fbs-scoreboard-live.json"))
      const nfl = yield* EspnEvent.listingOf("nfl", scoreboardBody)

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
      const games = yield* EspnEvent.listingOf("nfl", scoreboardBody)

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

      const games = yield* EspnEvent.listingOf("nfl", withBroken)

      assert.strictEqual(games.length, events.length)
    })
  )

  // How each recorded feed's events decode is locked above; these are the cases a recording lacks.
  it.effect("should list a site scoreboard event", () =>
    Effect.gen(function* () {
      const event = siteEvent()

      const games = yield* EspnEvent.listingOf("nfl", JSON.stringify({ events: [event] }))

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

      const games = yield* EspnEvent.listingOf("nfl", JSON.stringify({ events: [homeOnly] }))

      assert.lengthOf(games, 0)
    })
  )

  it.effect("should decode a live FBS scoreboard into snapshots", () =>
    Effect.gen(function* () {
      const slate = yield* EspnEvent.listingOf("fbs", TestEspn.recordedScoreboard("fbs-scoreboard-live"))

      const game = slate.find((g) => g.id === "401862787")
      assert.strictEqual(slate.length, 59)
      assert.strictEqual(game?.status, "live")
      assert.strictEqual(game?.away.team.abbreviation, "MEM")
      assert.strictEqual(game?.away.team.id, "fbs:235")
      assert.strictEqual(game?.away.score, 27)
      assert.deepStrictEqual(game?.broadcasts, [{ network: Network.make("ESPN+"), medium: "streaming" }])
    })
  )

  it.effect("should keep television and streaming broadcasts and drop radio", () =>
    Effect.gen(function* () {
      const slate = yield* EspnEvent.listingOf("fbs", TestEspn.recordedScoreboard("fbs-scoreboard-live"))

      const game = slate.find((g) => g.id === "401856710")
      assert.deepStrictEqual(game?.broadcasts, [{ network: Network.make("ESPN"), medium: "tv" }])
    })
  )

  it.effect("should keep each team's location and short name", () =>
    Effect.gen(function* () {
      const slate = yield* EspnEvent.listingOf("fbs", TestEspn.recordedScoreboard("fbs-scoreboard-live"))

      const game = slate.find((g) => g.id === "401862787")
      assert.strictEqual(game?.home.team.location, "Charlotte")
      assert.strictEqual(game?.home.team.shortName, "Charlotte")
      assert.strictEqual(game?.home.team.name, "Charlotte 49ers")
    })
  )

  it.effect("should keep each team's colors", () =>
    Effect.gen(function* () {
      const slate = yield* EspnEvent.listingOf("fbs", TestEspn.recordedScoreboard("fbs-scoreboard-live"))

      const game = slate.find((g) => g.id === "401862787")
      assert.strictEqual(game?.home.team.color, "005035")
      assert.strictEqual(game?.home.team.alternateColor, "a49665")
    })
  )

  it.effect("should leave a team without colors with neither", () =>
    Effect.gen(function* () {
      const slate = yield* EspnEvent.listingOf(
        "fbs",
        withoutColors(TestEspn.recordedScoreboard("fbs-scoreboard-live"))
      )

      const game = slate.find((g) => g.id === "401862787")
      assert.strictEqual(game?.home.team.color, undefined)
      assert.strictEqual(game?.home.team.alternateColor, undefined)
    })
  )

  it.effect("should leave out what ESPN reports with placeholder values", () =>
    Effect.gen(function* () {
      const slate = yield* EspnEvent.listingOf("fbs", TestEspn.recordedScoreboard("fbs-scoreboard-live"))

      const game = slate.find((g) => g.id === "401862787")
      // ESPN sends rank 99 for an unranked team and down -1 between plays.
      assert.strictEqual(game?.home.ranking, undefined)
      assert.strictEqual(game?.situation?.down, undefined)
    })
  )

  it.effect("should decode an NFL scoreboard, namespacing team ids by league", () =>
    Effect.gen(function* () {
      const slate = yield* EspnEvent.listingOf("nfl", TestEspn.recordedScoreboard("nfl-scoreboard-pregame"))

      assert.strictEqual(slate.length, 16)
      assert.isTrue(slate.every((game) => game.league === "nfl" && game.home.team.id.startsWith("nfl:")))
      assert.isTrue(slate.some((game) => game.status === "scheduled" && game.situation === undefined))
    })
  )

  it.effect(
    "should orient the yard line for the team with the ball: ESPN counts it from the home goal line",
    () =>
      Effect.gen(function* () {
        const slate = yield* EspnEvent.listingOf(
          "fbs",
          TestEspn.recordedScoreboard("fbs-scoreboard-2026-10-03T2024Z")
        )

        const yardLine = (id: string) => slate.find((g) => g.id === id)?.situation?.yardLine
        // Away ball, "4th & 1 at NCSU 11": Louisville is 11 yards from the goal.
        assert.strictEqual(yardLine("401858248"), 11)
        // Home ball, "1st & 10 at MIZ 10": Missouri is at its own 10, 90 yards from the goal.
        assert.strictEqual(yardLine("401856708"), 90)
        // Home ball, "1st & 10 at UK 49": South Carolina is 49 yards from the goal.
        assert.strictEqual(yardLine("401856709"), 49)
        // Away ball, "2nd & 7 at MD 33": Maryland is at its own 33.
        assert.strictEqual(yardLine("401858475"), 67)
        // No one has the ball: the yard line cannot be oriented.
        assert.strictEqual(yardLine("401856710"), undefined)
      })
  )

  it.effect("should fail a body that is not a scoreboard", () =>
    Effect.gen(function* () {
      const listed = yield* Effect.result(EspnEvent.listingOf("nfl", "not json"))

      assert.isTrue(Result.isFailure(listed))
    })
  )
})

// Decoding NE at BUF's whole recorded day takes seconds alone, and many under a full suite's load: whichever test
// runs first decodes it, so each has a timeout to match.
describe("the recorded NE at BUF day", () => {
  it.effect(
    "should decode every snapshot so it reads back from its JSON Equal to itself",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(TestEspn.duringNeAtBuf.epochMilliseconds)
        const decoded = yield* TestEspn.neAtBufDecoded
        const deliveries = decoded.flat()
        const snapshots = deliveries.flatMap((delivery) =>
          Delivery.$is("Listing")(delivery) ? delivery.games : []
        )

        const backs = yield* Effect.forEach(snapshots, (snapshot) =>
          Schema.encodeEffect(snapshotJson)(snapshot).pipe(Effect.flatMap(Schema.decodeEffect(snapshotJson)))
        )

        assert.isNotEmpty(snapshots)
        for (const [index, snapshot] of snapshots.entries()) {
          assert.isTrue(Equal.equals(backs[index], snapshot), snapshot.id)
        }
      }),
    { timeout: 60_000 }
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

const snapshotJson = Schema.fromJsonString(GameSnapshot)

/** `body` without any team's colors. */
function withoutColors(body: string) {
  return JSON.stringify(JSON.parse(body), (key, value) =>
    key === "color" || key === "alternateColor" ? undefined : value
  )
}
