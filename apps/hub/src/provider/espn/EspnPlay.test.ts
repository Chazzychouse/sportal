import { existsSync, readFileSync } from "node:fs"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Fumble, Other, type Play, PlayId, Rush, Stoppage } from "@sportal/domain/Play"
import { TeamId } from "@sportal/domain/Team"
import { Effect, Layer, Schema } from "effect"
import * as Gzip from "../../Gzip.ts"
import { Scenarios } from "../../scenario/Scenarios.ts"
import { decodedFrames } from "../../TestFeed.ts"
import * as EspnDecode from "./EspnDecode.ts"
import * as EspnPlay from "./EspnPlay.ts"
import * as EspnSummary from "./EspnSummary.ts"
import { fixtures, neAtBufFrames } from "./TestEspn.ts"

// Play entities from the 2026-10-04 NFL recording, each as its game's `gp-` topic first added it, without its
// participants; NE–BUF's first score, 401872971484, as the topic last had it, after its extra point.
const recorded = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)))
)(readFileSync(new URL("./fixtures/nfl-plays-2026-10-04.json", import.meta.url), "utf8"))
const entity = (id: string) => recorded[id] ?? {}

const nfl = (team: string) => TeamId.make(`nfl:${team}`)

const decodePlay = Schema.decodeUnknownEffect(EspnPlay.Play("nfl"))

// A recorded play read as `type` instead of its own.
const typed = (type: { readonly id: string; readonly text: string }) =>
  decodePlay({ ...entity("401872966237"), type })

// Some fields of a play, by name.
const fieldsOf = (play: Play, names: ReadonlyArray<string>) =>
  Object.fromEntries(names.map((name) => [name, Reflect.get(play, name)]))

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

describe("EspnPlay.Play", () => {
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

      assert.deepStrictEqual(fieldsOf(play, ["_tag", "touchdown", "team", "yards"]), {
        _tag: "Completion",
        touchdown: false,
        team: nfl("10"),
        yards: 15
      })
      assert.deepStrictEqual([play.start.yardsToEndzone, play.end.yardsToEndzone], [58, 43])
    })
  )

  it.effect("should read a fumble the offense recovers as kept by the team with the ball", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("401872971330"))

      assert.instanceOf(play, Fumble)
      assert.deepStrictEqual(fieldsOf(play, ["recovery", "team", "yards"]), {
        recovery: "own",
        team: nfl("17"),
        yards: 21
      })
      assert.deepStrictEqual([play.start.team, play.end.team], [nfl("17"), nfl("17")])
    })
  )

  it.effect("should read a fumble the defense recovers as lost, the ball ending with the other team", () =>
    Effect.gen(function* () {
      const play = yield* decodePlay(entity("4018729712179"))

      assert.deepStrictEqual(fieldsOf(play, ["_tag", "recovery"]), { _tag: "Fumble", recovery: "opponent" })
      assert.deepStrictEqual([play.start.team, play.end.team], [nfl("2"), nfl("17")])
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

      assert.instanceOf(play, Stoppage)
      assert.deepStrictEqual(
        [play.kind, play.start.team, play.start.down, play.start.distance, play.awayScore],
        ["officialTimeout", nfl("22"), undefined, undefined, 7]
      )
    })
  )

  it.effect("should read an extra point as a good one", () =>
    Effect.gen(function* () {
      // No recorded game topic lists a try as its own play: ESPN's type for one is as the recorded FBS scoreboard
      // (fixtures/fbs-scoreboard-2026-10-03T2024Z.json) names a last play's.
      const play = yield* typed({ id: "61", text: "Extra Point Good" })

      assert.deepStrictEqual(fieldsOf(play, ["_tag", "good"]), { _tag: "ExtraPoint", good: true })
    })
  )

  it.effect.each([
    { type: { id: "15", text: "Two Point Pass" }, by: "pass" },
    { type: { id: "16", text: "Two Point Rush" }, by: "rush" }
  ])("should read a two-point try by $by", ({ type, by }) =>
    Effect.gen(function* () {
      const play = yield* typed(type)

      assert.deepStrictEqual(fieldsOf(play, ["_tag", "by"]), { _tag: "TwoPointTry", by })
    })
  )

  it.effect.each(recordedTypes)(
    "should read each recorded type id as its table row: $id $text",
    ({ id, text, play }) =>
      Effect.gen(function* () {
        const read = yield* typed({ id, text })

        assert.deepStrictEqual(fieldsOf(read, Object.keys(play)), play)
      })
  )

  it.effect(
    "should read every play in the recorded fixtures without falling back to Other",
    () =>
      Effect.gen(function* () {
        const { frames } = yield* Scenarios.use((scenarios) => scenarios.load(neAtBufFrames)).pipe(
          Effect.provide(Scenarios.in(fixtures, []).pipe(Layer.provideMerge(NodeServices.layer)))
        )
        const decoded = yield* decodedFrames(frames).pipe(Effect.provide(EspnDecode.layer))
        const pushed = decoded
          .flatMap(({ deliveries }) => deliveries)
          .flatMap((delivery) => (delivery._tag === "Plays" ? delivery.plays : []))
        const entities = yield* Effect.forEach(Object.values(recorded), (one) => decodePlay(one))
        const summaries = yield* Effect.forEach(
          [
            { league: "nfl", name: "nfl-summary-401872971" },
            { league: "nfl", name: "nfl-summary-401872922" },
            { league: "nfl", name: "nfl-summary-401872929" },
            { league: "fbs", name: "fbs-summary-401856705" }
          ] as const,
          ({ league, name }) =>
            Effect.flatMap(summaryOf(name), (summary) => EspnSummary.plays(league, summary))
        )

        const all = [...pushed, ...entities, ...summaries.flat().map(({ play }) => play)]

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

      assert.instanceOf(play, Other)
      assert.deepStrictEqual(play.type, { id: "999", text: "Something New" })
    })
  )

  it.effect("should read a kickoff return touchdown as a kickoff with returnTouchdown", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "32", text: "Kickoff Return Touchdown" })

      assert.deepStrictEqual(fieldsOf(play, ["_tag", "returnTouchdown"]), {
        _tag: "Kickoff",
        returnTouchdown: true
      })
    })
  )

  it.effect("should read a blocked field goal as a field goal, blocked", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "18", text: "Blocked Field Goal" })

      assert.deepStrictEqual(fieldsOf(play, ["_tag", "result"]), { _tag: "FieldGoal", result: "blocked" })
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

      assert.deepStrictEqual(fieldsOf(play, ["_tag", "kind"]), { _tag: "Stoppage", kind: "coinToss" })
    })
  )

  it.effect("should leave a timeout's caller unread", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "21", text: "Timeout" })

      assert.deepStrictEqual(fieldsOf(play, ["_tag", "team"]), { _tag: "Timeout", team: undefined })
    })
  )
})

describe("EspnPlay.unknownTypes", () => {
  it("should list an unknown type once", () => {
    const unknown = { ...entity("40187297063"), type: { id: "999", text: "Something New" } }

    const types = EspnPlay.unknownTypes([unknown, unknown, entity("401872966271")])

    assert.deepStrictEqual(types, [{ id: "999", text: "Something New" }])
  })

  it("should not list a type the table knows", () => {
    const types = EspnPlay.unknownTypes([{ type: { id: "61", text: "Extra Point Good" } }])

    assert.deepStrictEqual(types, [])
  })
})

describe("EspnPlay.typeOf", () => {
  it.effect.each(recordedTypes.filter(({ id }) => id !== "4"))(
    "should write each row's case back as the row's id: $id $text",
    ({ id, text }) =>
      Effect.gen(function* () {
        const play = yield* typed({ id, text })

        assert.deepStrictEqual(EspnPlay.typeOf(play), { id, text })
      })
  )

  it.effect("should write a pass completion back as a pass reception, the first row that reads alike", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "4", text: "Pass Completion" })

      assert.deepStrictEqual(EspnPlay.typeOf(play), { id: "24", text: "Pass Reception" })
    })
  )

  it.effect("should write an Other back as its own type", () =>
    Effect.gen(function* () {
      const play = yield* typed({ id: "999", text: "Something New" })

      assert.deepStrictEqual(EspnPlay.typeOf(play), { id: "999", text: "Something New" })
    })
  )
})

// A recorded summary in `fixtures/`, as JSON or gzip'd JSON.
function summaryOf(name: string) {
  const plain = new URL(`./fixtures/${name}.json`, import.meta.url)
  const text = existsSync(plain)
    ? Effect.succeed(readFileSync(plain, "utf8"))
    : Gzip.decompress(readFileSync(new URL(`./fixtures/${name}.json.gz`, import.meta.url)), "gzip")
  return Effect.map(text, (json): unknown => JSON.parse(json))
}
