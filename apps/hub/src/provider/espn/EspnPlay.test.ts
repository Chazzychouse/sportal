import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { FootballPlay, Other, type Play, PlayId, Rush } from "@sportal/domain/Play"
import { TeamId } from "@sportal/domain/Team"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Delivery } from "../Provider.ts"
import * as EspnPlay from "./EspnPlay.ts"
import { decodedFrames, duringNeAtBuf, recordedNeAtBuf } from "./TestEspn.ts"

// Play entities from the 2026-10-04 NFL recording, each as its game's `gp-` topic first added it, without its
// participants; NE–BUF's first score, 401872971484, as the topic last had it, after its extra point.
const recorded = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)))
)(readFileSync(new URL("./fixtures/nfl-plays-2026-10-04.json", import.meta.url), "utf8"))
const entity = (id: string) => recorded[id] ?? {}

const nfl = (team: string) => TeamId.make(`nfl:${team}`)

const decodePlay = Schema.decodeUnknownEffect(EspnPlay.FootballPlay("nfl"))

// A recorded play read as `type` instead of its own.
const typed = (type: { readonly id: string; readonly text: string }) =>
  decodePlay({ ...entity("401872966237"), type })

// `play` as the case `guard` narrows to; none when it is another case.
const narrowed = <Case extends Play>(guard: (play: Play) => play is Case, play: Play): Case | undefined =>
  guard(play) ? play : undefined

// A play's wire form, field by field.
const wireOf = (play: Play): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(Schema.encodeSync(FootballPlay)(play)))

// Every ESPN play type id the recordings have, with its text, and the case and outcome it reads as.
const recordedTypes = [
  { id: "5", text: "Rush", play: { _tag: "Rush", touchdown: false } },
  { id: "68", text: "Rushing Touchdown", play: { _tag: "Rush", touchdown: true } },
  { id: "24", text: "Pass Reception", play: { _tag: "Completion", touchdown: false } },
  { id: "4", text: "Pass Completion", play: { _tag: "Completion", touchdown: false } },
  { id: "67", text: "Passing Touchdown", play: { _tag: "Completion", touchdown: true } },
  { id: "3", text: "Pass Incompletion", play: { _tag: "Incompletion" } },
  { id: "63", text: "Interception", play: { _tag: "Interception", return: "none" } },
  { id: "26", text: "Pass Interception Return", play: { _tag: "Interception", return: "returned" } },
  { id: "36", text: "Interception Return Touchdown", play: { _tag: "Interception", return: "touchdown" } },
  { id: "7", text: "Sack", play: { _tag: "Sack", fumbleLost: false } },
  { id: "80", text: "Sack Opp Fumble Recovery", play: { _tag: "Sack", fumbleLost: true } },
  { id: "69", text: "Fumble", play: { _tag: "Fumble", recovery: "unknown" } },
  { id: "9", text: "Fumble Recovery (Own)", play: { _tag: "Fumble", recovery: "own" } },
  { id: "29", text: "Fumble Recovery (Opponent)", play: { _tag: "Fumble", recovery: "opponent" } },
  { id: "39", text: "Fumble Return Touchdown", play: { _tag: "Fumble", recovery: "touchdown" } },
  { id: "15", text: "Two Point Pass", play: { _tag: "TwoPointTry", by: "pass" } },
  { id: "16", text: "Two Point Rush", play: { _tag: "TwoPointTry", by: "rush" } },
  { id: "53", text: "Kickoff", play: { _tag: "Kickoff", returnTouchdown: false } },
  { id: "32", text: "Kickoff Return Touchdown", play: { _tag: "Kickoff", returnTouchdown: true } },
  { id: "52", text: "Punt", play: { _tag: "Punt", return: "none" } },
  { id: "14", text: "Punt Return", play: { _tag: "Punt", return: "returned" } },
  { id: "34", text: "Punt Return Touchdown", play: { _tag: "Punt", return: "touchdown" } },
  { id: "59", text: "Field Goal Good", play: { _tag: "FieldGoal", result: "good" } },
  { id: "60", text: "Field Goal Missed", play: { _tag: "FieldGoal", result: "missed" } },
  { id: "18", text: "Blocked Field Goal", play: { _tag: "FieldGoal", result: "blocked" } },
  { id: "61", text: "Extra Point Good", play: { _tag: "ExtraPoint", good: true } },
  { id: "62", text: "Extra Point Missed", play: { _tag: "ExtraPoint", good: false } },
  { id: "20", text: "Safety", play: { _tag: "Safety" } },
  { id: "8", text: "Penalty", play: { _tag: "Penalty" } },
  { id: "21", text: "Timeout", play: { _tag: "Timeout" } },
  { id: "74", text: "Official Timeout", play: { _tag: "Stoppage", kind: "officialTimeout" } },
  { id: "75", text: "Two-minute warning", play: { _tag: "Stoppage", kind: "twoMinuteWarning" } },
  { id: "70", text: "Coin Toss", play: { _tag: "Stoppage", kind: "coinToss" } },
  { id: "2", text: "End Period", play: { _tag: "PeriodEnd", ends: "period" } },
  { id: "65", text: "End of Half", play: { _tag: "PeriodEnd", ends: "half" } },
  { id: "79", text: "End of Regulation", play: { _tag: "PeriodEnd", ends: "regulation" } },
  { id: "66", text: "End of Game", play: { _tag: "PeriodEnd", ends: "game" } }
] as const

describe("EspnPlay.FootballPlay", () => {
  it.effect("should read a rush, with its text and win probability", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("40187297063"))

      assert.deepStrictEqual(
        play,
        new Rush({
          id: PlayId.make("40187297063"),
          sequence: 6300,
          period: 1,
          clock: "14:55",
          text: "S.Barkley up the middle to PHI 27 for 2 yards (O.Speights; J.Stewart).",
          scoring: false,
          homeScore: 0,
          awayScore: 0,
          start: { down: 1, distance: 10, yardsToEndzone: 75, team: nfl("21") },
          end: { down: 2, distance: 8, yardsToEndzone: 73, team: nfl("21") },
          homeWinProbability: 0.3675,
          team: nfl("21"),
          yards: 2,
          touchdown: false
        })
      )
    })
  )

  it.effect("should read a pass reception as a completion", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("40187297363"))

      const completion = narrowed(FootballPlay.guards.Completion, play)
      assert.deepStrictEqual(
        [completion?.touchdown, completion?.team, completion?.yards],
        [false, nfl("10"), 15]
      )
      assert.deepStrictEqual([play.start.yardsToEndzone, play.end.yardsToEndzone], [58, 43])
    })
  )

  it.effect("should read a fumble the offense recovers as kept by the team with the ball", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("401872971330"))

      const fumble = narrowed(FootballPlay.guards.Fumble, play)
      assert.deepStrictEqual(
        [fumble?.recovery, fumble?.team, fumble?.yards, fumble?.start.team, fumble?.end.team],
        ["own", nfl("17"), 21, nfl("17"), nfl("17")]
      )
    })
  )

  it.effect("should read a fumble the defense recovers as lost, the ball ending with the other team", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("4018729712179"))

      const fumble = narrowed(FootballPlay.guards.Fumble, play)
      assert.deepStrictEqual(
        [fumble?.recovery, fumble?.start.team, fumble?.end.team],
        ["opponent", nfl("2"), nfl("17")]
      )
    })
  )

  it.effect("should read a passing touchdown as a scoring completion", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("401872966237"))

      const { text: _text, homeWinProbability: _probability, ...rest } = play
      assert.deepStrictEqual(
        { ...rest },
        {
          _tag: "Completion",
          id: PlayId.make("401872966237"),
          sequence: 23700,
          period: 1,
          clock: "11:08",
          scoring: true,
          homeScore: 0,
          awayScore: 6,
          start: { down: 1, distance: 10, yardsToEndzone: 12, team: nfl("22") },
          end: { yardsToEndzone: 0, team: nfl("22") },
          team: nfl("22"),
          yards: 12,
          touchdown: true
        }
      )
    })
  )

  it.effect("should read ESPN's placeholder down after a touchdown as no down", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("401872966237"))

      assert.deepStrictEqual(play.end, { yardsToEndzone: 0, team: nfl("22") })
    })
  )

  it.effect("should read an official timeout as a stoppage, not a team's timeout", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("401872966271"))

      const stoppage = narrowed(FootballPlay.guards.Stoppage, play)
      assert.deepStrictEqual(
        [
          stoppage?.kind,
          stoppage?.start.team,
          stoppage?.start.down,
          stoppage?.start.distance,
          stoppage?.awayScore
        ],
        ["officialTimeout", nfl("22"), undefined, undefined, 7]
      )
    })
  )

  it.effect("should read an extra point as a good one", () =>
    Effect.gen(function* () {
      // No recorded game topic lists a try as its own play: ESPN's type for one is as the recorded FBS scoreboard
      // (fixtures/fbs-scoreboard-2026-10-03T2024Z.json) names a last play's.
      const play = yield* typed({ id: "61", text: "Extra Point Good" })

      assert.isTrue(narrowed(FootballPlay.guards.ExtraPoint, play)?.good)
    })
  )

  it.effect.each([
    { type: { id: "15", text: "Two Point Pass" }, by: "pass" },
    { type: { id: "16", text: "Two Point Rush" }, by: "rush" }
  ])("should read a two-point try by $by", ({ type, by }) =>
    Effect.gen(function* () {
      const play = yield* typed(type)

      assert.strictEqual(narrowed(FootballPlay.guards.TwoPointTry, play)?.by, by)
    })
  )

  it.effect.each(recordedTypes)(
    "should read each recorded type id as its table row: $id $text",
    ({ id, text, play }) =>
      Effect.gen(function* () {
        const read = yield* typed({ id, text })

        const wire = wireOf(read)

        assert.deepStrictEqual(
          Object.fromEntries(Object.keys(play).map((field) => [field, wire[field]])),
          play
        )
      })
  )

  it.effect(
    "should read every play in the recorded fixtures without falling back to Other",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(duringNeAtBuf.epochMilliseconds)
        const frames = yield* recordedNeAtBuf
        const decoded = yield* decodedFrames(frames)
        const pushed = decoded
          .flat()
          .flatMap((delivery) => (Delivery.$is("Plays")(delivery) ? delivery.plays : []))
        const entities = yield* Effect.forEach(Object.values(recorded), (one) => decodePlay(one))

        const all = [...pushed, ...entities]

        assert.isNotEmpty(pushed)
        assert.deepStrictEqual(
          all.filter((play) => play instanceof Other).map((play) => play.id),
          []
        )
      }),
    { timeout: 60_000 }
  )

  it.effect("should read an unknown type as Other, keeping its id and text", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "999", text: "Something New" })

      assert.deepStrictEqual(narrowed(FootballPlay.guards.Other, play)?.type, {
        id: "999",
        text: "Something New"
      })
    })
  )

  it.effect("should read a kickoff return touchdown as a kickoff with returnTouchdown", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "32", text: "Kickoff Return Touchdown" })

      assert.isTrue(narrowed(FootballPlay.guards.Kickoff, play)?.returnTouchdown)
    })
  )

  it.effect("should read a blocked field goal as a field goal, blocked", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "18", text: "Blocked Field Goal" })

      assert.strictEqual(narrowed(FootballPlay.guards.FieldGoal, play)?.result, "blocked")
    })
  )

  it.effect("should read a safety as a safety", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "20", text: "Safety" })

      assert.strictEqual(play._tag, "Safety")
    })
  )

  it.effect("should read a coin toss as a coin toss stoppage", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "70", text: "Coin Toss" })

      assert.strictEqual(narrowed(FootballPlay.guards.Stoppage, play)?.kind, "coinToss")
    })
  )

  it.effect("should read a timeout's caller from its timeout taker", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay({
        ...entity("401872966237"),
        type: { id: "21", text: "Timeout" },
        participants: [{ type: "timeout_taker", team: { $key: "4" } }]
      })

      assert.strictEqual(narrowed(FootballPlay.guards.Timeout, play)?.team, nfl("4"))
    })
  )

  it.effect("should not read the team with the ball as a timeout's caller", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "21", text: "Timeout" })

      const timeout = narrowed(FootballPlay.guards.Timeout, play)

      assert.deepStrictEqual([timeout?._tag, timeout?.team], ["Timeout", undefined])
    })
  )
})
