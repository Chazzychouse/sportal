import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { type Play, PlayId } from "@sportal/domain/Play"
import { TeamId } from "@sportal/domain/Team"
import { Effect, Schema } from "effect"
import * as EspnPlay from "./EspnPlay.ts"

// Play entities from the 2026-10-04 NFL recording, each as its game's `gp-` topic first added it, without its
// participants.
const recorded = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)))
)(readFileSync(new URL("./fixtures/nfl-plays-2026-10-04.json", import.meta.url), "utf8"))
const entity = (id: string) => recorded[id] ?? {}

const nfl = (team: string) => TeamId.make(`nfl:${team}`)

const decodePlay = Schema.decodeUnknownEffect(EspnPlay.Play("nfl"))

// What a play is, beside its text and win probability.
const shape = (play: Play) => ({
  id: play.id,
  sequence: play.sequence,
  period: play.period,
  clock: play.clock,
  team: play.team,
  kind: play.kind,
  yards: play.yards,
  scoring: play.scoring,
  homeScore: play.homeScore,
  awayScore: play.awayScore,
  start: { ...play.start },
  end: { ...play.end }
})

describe("EspnPlay", () => {
  it.effect("a rush", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("40187297063"))

      assert.deepStrictEqual(shape(play), {
        id: PlayId.make("40187297063"),
        sequence: 6300,
        period: 1,
        clock: "14:55",
        team: nfl("21"),
        kind: "rush",
        yards: 2,
        scoring: false,
        homeScore: 0,
        awayScore: 0,
        start: { down: 1, distance: 10, yardsToEndzone: 75, team: nfl("21") },
        end: { down: 2, distance: 8, yardsToEndzone: 73, team: nfl("21") }
      })
      assert.strictEqual(play.text, "S.Barkley up the middle to PHI 27 for 2 yards (O.Speights; J.Stewart).")
      assert.strictEqual(play.homeWinProbability, 0.3675)
    })
  )

  it.effect("a pass reception is a pass", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("40187297363"))

      assert.deepStrictEqual(
        [play.kind, play.team, play.yards, play.start.yardsToEndzone, play.end.yardsToEndzone],
        ["pass", nfl("10"), 15, 58, 43]
      )
    })
  )

  it.effect("a fumble the offense recovers is a fumble, kept by the team with the ball", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("401872971330"))

      assert.deepStrictEqual(
        [play.kind, play.team, play.start.team, play.end.team, play.yards],
        ["fumble", nfl("17"), nfl("17"), nfl("17"), 21]
      )
    })
  )

  it.effect("a fumble the defense recovers is lost: the ball ends with the other team", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("4018729712179"))

      assert.deepStrictEqual([play.kind, play.start.team, play.end.team], ["fumbleLost", nfl("2"), nfl("17")])
    })
  )

  it.effect("a passing touchdown scores; ESPN's placeholder down after it reads as no down", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("401872966237"))

      assert.deepStrictEqual(shape(play), {
        id: PlayId.make("401872966237"),
        sequence: 23700,
        period: 1,
        clock: "11:08",
        team: nfl("22"),
        kind: "pass",
        yards: 12,
        scoring: true,
        homeScore: 0,
        awayScore: 6,
        start: { down: 1, distance: 10, yardsToEndzone: 12, team: nfl("22") },
        end: { down: undefined, distance: undefined, yardsToEndzone: 0, team: nfl("22") }
      })
    })
  )

  it.effect("an official timeout is no team's timeout", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("401872966271"))

      assert.deepStrictEqual(
        [play.kind, play.team, play.start.down, play.start.distance, play.awayScore],
        ["other", nfl("22"), undefined, undefined, 7]
      )
    })
  )

  it.effect("a type the table does not know is other, and is listed as unknown", () =>
    Effect.gen(function* () {
      const unknown = { ...entity("40187297063"), type: { id: PlayId.make("999"), text: "Something New" } }
      const play = yield* decodePlay(unknown)

      assert.strictEqual(play.kind, "other")
      assert.deepStrictEqual(EspnPlay.unknownTypes([unknown, entity("401872966271")]), [
        { id: PlayId.make("999"), text: "Something New" }
      ])
    })
  )
})
