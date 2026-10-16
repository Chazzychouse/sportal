import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { FootballDetail, Play, PlayDetail, PlayId } from "@sportal/domain/Play"
import { TeamId } from "@sportal/domain/Team"
import { Effect, Equal, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as TestHub from "../../TestHub.ts"
import { Delivery } from "../Provider.ts"
import * as EspnPlay from "./EspnPlay.ts"

describe("EspnPlay.summaryPlays", () => {
  it.effect("should read every play of a recorded game summary", () =>
    Effect.gen(function* () {
      const body = TestHub.recordedSummary("nfl-summary-401872971")

      const plays = yield* EspnPlay.summaryPlays("nfl", body)

      assert.strictEqual(plays.length, 182)
      assert.strictEqual(plays[0]?.type.text, "Kickoff")
    })
  )

  it.effect("should read a summary play's team from its id", () =>
    Effect.gen(function* () {
      const body = TestHub.recordedSummary("nfl-summary-401872971")

      const plays = yield* EspnPlay.summaryPlays("nfl", body)

      assert.deepStrictEqual(plays[1]?.offense().pipe(Option.getOrUndefined), nfl("2"))
    })
  )
})

describe("EspnPlay.play", () => {
  it.effect("should read a rush, with its text", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("40187297063"))

      assert.deepStrictEqual(
        play,
        new Play({
          id: PlayId.make("40187297063"),
          sequence: 6300,
          period: 1,
          clock: "14:55",
          text: "S.Barkley up the middle to PHI 27 for 2 yards (O.Speights; J.Stewart).",
          type: { id: "5", text: "Rush" },
          scoring: false,
          homeScore: 0,
          awayScore: 0,
          team: nfl("21"),
          detail: new FootballDetail({
            kind: "run",
            yards: 2,
            start: { down: 1, distance: 10, yardsToEndzone: 75, team: nfl("21") },
            end: { down: 2, distance: 8, yardsToEndzone: 73, team: nfl("21") }
          })
        })
      )
    })
  )

  it.effect("should read a pass reception as a pass", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("40187297363"))

      const detail = footballOf(play)
      assert.deepStrictEqual(
        [play.type.id, detail?.kind, play.team, detail?.yards],
        ["24", "pass", nfl("10"), 15]
      )
      assert.deepStrictEqual([detail?.start.yardsToEndzone, detail?.end.yardsToEndzone], [58, 43])
    })
  )

  it.effect("should read a fumble the offense recovers with the ball kept by the team with the ball", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("401872971330"))

      const detail = footballOf(play)
      assert.deepStrictEqual(
        [play.type.id, play.team, detail?.yards, detail?.start.team, detail?.end.team],
        ["9", nfl("17"), 21, nfl("17"), nfl("17")]
      )
    })
  )

  it.effect("should read a fumble the defense recovers with the ball ending with the other team", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("4018729712179"))

      const detail = footballOf(play)
      assert.deepStrictEqual(
        [play.type.id, detail?.start.team, detail?.end.team],
        ["29", nfl("2"), nfl("17")]
      )
    })
  )

  it.effect("should read a passing touchdown as a scoring pass", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("401872966237"))

      const { text: _text, ...rest } = play
      assert.deepStrictEqual(
        { ...rest },
        {
          id: PlayId.make("401872966237"),
          sequence: 23700,
          period: 1,
          clock: "11:08",
          type: { id: "67", text: "Passing Touchdown" },
          scoring: true,
          homeScore: 0,
          awayScore: 6,
          team: nfl("22"),
          detail: new FootballDetail({
            kind: "pass",
            yards: 12,
            start: { down: 1, distance: 10, yardsToEndzone: 12, team: nfl("22") },
            end: { yardsToEndzone: 0, team: nfl("22") }
          })
        }
      )
    })
  )

  it.effect("should read ESPN's placeholder down after a touchdown as no down", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("401872966237"))

      assert.deepStrictEqual(footballOf(play)?.end, { yardsToEndzone: 0, team: nfl("22") })
    })
  )

  it.effect("should read an official timeout as its own type, not a team's timeout", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("401872966271"))

      const detail = footballOf(play)
      assert.deepStrictEqual(
        [
          play.type.id,
          detail?.kind,
          detail?.start.team,
          detail?.start.down,
          detail?.start.distance,
          play.awayScore
        ],
        ["74", "other", nfl("22"), undefined, undefined, 7]
      )
    })
  )

  it.effect("should read an extra point as a kick", () =>
    Effect.gen(function* () {
      // No recorded game topic lists a try as its own play: ESPN's type for one is as the recorded FBS scoreboard
      // (fixtures/fbs-scoreboard-2026-10-03T2024Z.json) names a last play's.
      const play = yield* typed({ id: "61", text: "Extra Point Good" })

      assert.strictEqual(footballOf(play)?.kind, "kick")
    })
  )

  it.effect.each([
    { type: { id: "15", text: "Two Point Pass" }, kind: "pass" },
    { type: { id: "16", text: "Two Point Rush" }, kind: "run" }
  ])("should read a two-point try as a $kind", ({ type, kind }) =>
    Effect.gen(function* () {
      const play = yield* typed(type)

      assert.strictEqual(footballOf(play)?.kind, kind)
    })
  )

  it.effect.each(recordedTypes)(
    "should read each recorded type id as its table row: $id $text",
    ({ id, text, kind }) =>
      Effect.gen(function* () {
        const play = yield* typed({ id, text })

        assert.deepStrictEqual([play.type, footballOf(play)?.kind], [{ id, text }, kind])
      })
  )

  it.effect(
    "should read every play in the recorded fixtures as a type the table has",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(TestHub.duringNeAtBuf.epochMilliseconds)
        const day = yield* TestHub.recordedNeAtBuf
        const decoded = yield* TestHub.replayed(day)
        const pushed = decoded.flatMap((delivery) => (Delivery.$is("Plays")(delivery) ? delivery.plays : []))
        const entities = yield* Effect.forEach(Object.values(recorded), (one) => decodePlay(one))

        const all = [...pushed, ...entities]

        const known = new Set<string>(recordedTypes.map(({ id }) => id))
        assert.isNotEmpty(pushed)
        assert.deepStrictEqual(
          all.filter((play) => !known.has(play.type.id)).map((play) => play.id),
          []
        )
      }),
    { timeout: 60_000 }
  )

  it.effect("should read an unknown type as other, keeping its id and text", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "999", text: "Something New" })

      assert.deepStrictEqual(
        [footballOf(play)?.kind, play.type],
        ["other", { id: "999", text: "Something New" }]
      )
    })
  )

  it.effect("should read a kickoff return touchdown as a kick", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "32", text: "Kickoff Return Touchdown" })

      assert.strictEqual(footballOf(play)?.kind, "kick")
    })
  )

  it.effect("should read a blocked field goal as a kick", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "18", text: "Blocked Field Goal" })

      assert.strictEqual(footballOf(play)?.kind, "kick")
    })
  )

  it.effect("should read a safety as other", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "20", text: "Safety" })

      assert.strictEqual(footballOf(play)?.kind, "other")
    })
  )

  it.effect("should read a coin toss as other", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "70", text: "Coin Toss" })

      assert.strictEqual(footballOf(play)?.kind, "other")
    })
  )

  it.effect("should read a timeout's caller from its timeout taker", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay({
        ...entity("401872966237"),
        type: { id: "21", text: "Timeout" },
        participants: [{ type: "timeout_taker", team: { $key: "4" } }]
      })

      assert.strictEqual(play.team, nfl("4"))
    })
  )

  it.effect("should not read the team with the ball as a timeout's caller", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "21", text: "Timeout" })

      assert.deepStrictEqual([play.type.id, play.team], ["21", undefined])
    })
  )
})

// Decoding NE at BUF's whole recorded day takes seconds alone, and many under a full suite's load: the first test in this file to
// yield the cache pays for the replay, hence the timeout.
describe("the recorded NE at BUF day", () => {
  it.effect(
    "should decode every play so it reads back from its JSON Equal to itself",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(TestHub.duringNeAtBuf.epochMilliseconds)
        const decoded = yield* TestHub.neAtBufDecoded
        const plays = decoded.flatMap((delivery) => (Delivery.$is("Plays")(delivery) ? delivery.plays : []))

        const backs = yield* Effect.forEach(plays, (play) =>
          Schema.encodeEffect(playJson)(play).pipe(Effect.flatMap(Schema.decodeEffect(playJson)))
        )

        assert.isNotEmpty(plays)
        for (const [index, play] of plays.entries()) {
          assert.isTrue(Equal.equals(backs[index], play), play.id)
        }
      }),
    // Round-tripping every recorded play through JSON takes about 5 s more under coverage.
    { timeout: 60_000 }
  )
})

// Play entities from the 2026-10-04 NFL recording, each as its game's `gp-` topic first added it, without its
// participants; NE–BUF's first score, 401872971484, as the topic last had it, after its extra point.
const recorded = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)))
)(readFileSync(new URL("./fixtures/nfl-plays-2026-10-04.json", import.meta.url), "utf8"))
const entity = (id: string) => recorded[id] ?? {}

// Every ESPN play type id the recordings have, with its text, and the kind it reads as.
const recordedTypes = [
  { id: "5", text: "Rush", kind: "run" },
  { id: "68", text: "Rushing Touchdown", kind: "run" },
  { id: "24", text: "Pass Reception", kind: "pass" },
  { id: "4", text: "Pass Completion", kind: "pass" },
  { id: "67", text: "Passing Touchdown", kind: "pass" },
  { id: "3", text: "Pass Incompletion", kind: "incomplete" },
  { id: "63", text: "Interception", kind: "other" },
  { id: "26", text: "Pass Interception Return", kind: "other" },
  { id: "36", text: "Interception Return Touchdown", kind: "other" },
  { id: "7", text: "Sack", kind: "sack" },
  { id: "80", text: "Sack Opp Fumble Recovery", kind: "sack" },
  { id: "69", text: "Fumble", kind: "other" },
  { id: "9", text: "Fumble Recovery (Own)", kind: "other" },
  { id: "29", text: "Fumble Recovery (Opponent)", kind: "other" },
  { id: "39", text: "Fumble Return Touchdown", kind: "other" },
  { id: "15", text: "Two Point Pass", kind: "pass" },
  { id: "16", text: "Two Point Rush", kind: "run" },
  { id: "53", text: "Kickoff", kind: "kick" },
  { id: "32", text: "Kickoff Return Touchdown", kind: "kick" },
  { id: "52", text: "Punt", kind: "kick" },
  { id: "14", text: "Punt Return", kind: "kick" },
  { id: "34", text: "Punt Return Touchdown", kind: "kick" },
  { id: "59", text: "Field Goal Good", kind: "kick" },
  { id: "60", text: "Field Goal Missed", kind: "kick" },
  { id: "18", text: "Blocked Field Goal", kind: "kick" },
  { id: "61", text: "Extra Point Good", kind: "kick" },
  { id: "62", text: "Extra Point Missed", kind: "kick" },
  { id: "20", text: "Safety", kind: "other" },
  { id: "8", text: "Penalty", kind: "penalty" },
  { id: "21", text: "Timeout", kind: "other" },
  { id: "74", text: "Official Timeout", kind: "other" },
  { id: "75", text: "Two-minute warning", kind: "other" },
  { id: "70", text: "Coin Toss", kind: "other" },
  { id: "2", text: "End Period", kind: "other" },
  { id: "65", text: "End of Half", kind: "other" },
  { id: "79", text: "End of Regulation", kind: "other" },
  { id: "66", text: "End of Game", kind: "other" }
] as const

const nfl = (team: string) => TeamId.make(`nfl:${team}`)

const decodePlay = Schema.decodeUnknownEffect(EspnPlay.play("nfl"))

// A recorded play read as `type` instead of its own.
const typed = (type: { readonly id: string; readonly text: string }) =>
  decodePlay({ ...entity("401872966237"), type })

// `play`'s football detail; none when it is another sport's.
const footballOf = (play: Play): FootballDetail | undefined =>
  PlayDetail.guards.Football(play.detail) ? play.detail : undefined

const playJson = Schema.fromJsonString(Play)
