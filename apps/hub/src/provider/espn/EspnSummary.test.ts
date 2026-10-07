import { readFileSync } from "node:fs"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Play, PlayId } from "@sportal/domain/Play"
import { TeamId } from "@sportal/domain/Team"
import { DateTime, Effect, Equal, Layer, Order, Schema } from "effect"
import { Scenarios } from "../../scenario/Scenarios.ts"
import { decodedFrames } from "../../TestFeed.ts"
import * as EspnDecode from "./EspnDecode.ts"
import * as EspnPlay from "./EspnPlay.ts"
import * as EspnSummary from "./EspnSummary.ts"
import { fixtures, neAtBufFrames } from "./TestEspn.ts"

// NE–BUF's summary, the game the frames fixture records, recorded once after it was final:
//   curl -o fixtures/nfl-summary-401872971.json \
//     'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872971'
// Its drives list 182 plays, each with a wallclock; its win probability also has the coin toss, which no drive lists.
const recorded = readFileSync(new URL("./fixtures/nfl-summary-401872971.json", import.meta.url), "utf8")
const summary: unknown = JSON.parse(recorded)
const recordedPlays = 182

// The same game's play entities, as FastCast's game topic lists them.
const fastCast = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)))
)(readFileSync(new URL("./fixtures/nfl-plays-2026-10-04.json", import.meta.url), "utf8"))

const nfl = (team: string) => TeamId.make(`nfl:${team}`)

describe("EspnSummary", () => {
  it.effect("reads every play a drive lists, with its wallclock, in sequence order", () =>
    Effect.gen(function* () {
      const plays = yield* EspnSummary.plays("nfl", summary)

      assert.strictEqual(plays.length, recordedPlays)
      assert.deepStrictEqual(
        plays.map(({ play }) => play.sequence),
        plays.map(({ play }) => play.sequence).toSorted(Order.Number)
      )
      const [first] = plays
      assert.strictEqual(first?.play.id, PlayId.make("40187297140"))
      assert.strictEqual(first?.play.kind, "kickoff")
      assert.strictEqual(
        first?.wallclock.epochMilliseconds,
        DateTime.makeUnsafe("2026-10-04T17:02:33Z").epochMilliseconds
      )
    })
  )

  it.effect("the first scoring play reads as FastCast's entity for it does: its scores, kind, and team", () =>
    Effect.gen(function* () {
      const scoring = (yield* EspnSummary.plays("nfl", summary)).find(({ play }) => play.scoring)
      const pushed = yield* Schema.decodeUnknownEffect(EspnPlay.Play("nfl"))(fastCast["401872971484"])

      assert.strictEqual(scoring?.play.id, PlayId.make("401872971484"))
      assert.deepStrictEqual(
        [scoring?.play.homeScore, scoring?.play.awayScore, scoring?.play.kind, scoring?.play.team],
        [0, 7, "pass", nfl("17")]
      )
      assert.deepStrictEqual(
        [pushed.homeScore, pushed.awayScore, pushed.kind, pushed.team],
        [0, 7, "pass", nfl("17")]
      )
      assert.isTrue(Equal.equals(scoring?.play, pushed), "the summary's play is FastCast's, field for field")
    })
  )

  it.effect(
    "a play's team is FastCast's: the team with the ball as it ended, so a lost fumble's is the recovering team",
    () =>
      Effect.gen(function* () {
        const play = (yield* EspnSummary.plays("nfl", summary)).find(
          ({ play }) => play.id === PlayId.make("4018729712179")
        )?.play

        assert.deepStrictEqual(
          [play?.kind, play?.team, play?.start.team, play?.end.team],
          ["fumbleLost", nfl("17"), nfl("2"), nfl("17")]
        )
      })
  )

  it.effect(
    "every play reads as the recorded FastCast topic last had it",
    () =>
      Effect.gen(function* () {
        const { frames } = yield* Scenarios.use((scenarios) => scenarios.load(neAtBufFrames)).pipe(
          Effect.provide(Scenarios.in(fixtures, []).pipe(Layer.provideMerge(NodeServices.layer)))
        )
        const pushed = (yield* decodedFrames(frames).pipe(Effect.provide(EspnDecode.layer)))
          .flatMap(({ deliveries }) => deliveries)
          .flatMap((delivery) =>
            delivery._tag === "Plays" && delivery.game === GameId.make("401872971") ? [delivery.plays] : []
          )
          .at(-1)
        const plays = yield* EspnSummary.plays("nfl", summary)

        assert.deepStrictEqual(
          plays.map(({ play }) => play.id),
          (pushed ?? []).map((play) => play.id)
        )
        // Left out: `text`, which ESPN rewrote for the summary (a penalty's line break, a clock prefix, a leading space);
        // and, on the last kneel only, 4018729714600, `yards` and `end`, which ESPN corrected after the game (-2 yards to
        // -1) and FastCast never sent. Every other field of every play is compared, team, kind, period, clock, scores,
        // start and end among them.
        const compared = (play: Play) => {
          const { text: _text, ...rest } = play
          return play.id === PlayId.make("4018729714600") ? { ...rest, yards: 0, end: {} } : { ...rest }
        }
        assert.deepStrictEqual(
          plays.map(({ play }) => compared(play)),
          (pushed ?? []).map(compared)
        )
        assert.strictEqual(
          plays.filter(({ play }, i) => Equal.equals(play, pushed?.[i])).length,
          recordedPlays - 3,
          "every other play is FastCast's, field for field"
        )
      }),
    { timeout: 60_000 }
  )

  it.effect("reads win probability where the summary has the play's, and none where it does not", () =>
    Effect.gen(function* () {
      const read = yield* EspnSummary.plays("nfl", summary)
      const unread = yield* EspnSummary.plays(
        "nfl",
        edited('{"homeWinPercentage":0.7286,"tiePercentage":0.0,"playId":"40187297140"},', "")
      )

      assert.strictEqual(read[0]?.play.homeWinProbability, 0.7286)
      assert.isFalse(unread[0] !== undefined && "homeWinProbability" in unread[0].play)
      assert.strictEqual(unread[1]?.play.homeWinProbability, read[1]?.play.homeWinProbability)
      assert.isDefined(unread[1]?.play.homeWinProbability)
    })
  )

  it.effect("a timeout says who called it, from its text; no other play says one", () =>
    Effect.gen(function* () {
      const plays = yield* EspnSummary.plays("nfl", summary)

      assert.deepStrictEqual(
        plays.flatMap(({ play, ...archived }) =>
          play.kind === "timeout" ? [[play.period, play.clock, archived.timeoutBy]] : []
        ),
        [
          [1, "3:27", nfl("17")],
          [2, "0:45", nfl("2")],
          [2, "0:16", nfl("2")],
          [4, "1:00", nfl("2")],
          [4, "0:42", nfl("2")],
          [4, "0:39", nfl("2")]
        ]
      )
      assert.isTrue(plays.every((archived) => archived.play.kind === "timeout" || !("timeoutBy" in archived)))
    })
  )

  it.effect("a timeout whose caller does not read says none, and the game still reads", () =>
    Effect.gen(function* () {
      const plays = yield* EspnSummary.plays(
        "nfl",
        edited("Timeout #1 by NE at 03:27.", "Timeout #1 at 03:27.")
      )
      const timeout = plays.find(({ play }) => play.kind === "timeout")

      assert.strictEqual(plays.length, recordedPlays)
      assert.strictEqual(timeout?.play.clock, "3:27")
      assert.isFalse(timeout !== undefined && "timeoutBy" in timeout)
    })
  )

  it.effect("a play without a wallclock is not read", () =>
    Effect.gen(function* () {
      const plays = yield* EspnSummary.plays("nfl", edited(',"wallclock":"2026-10-04T17:02:33Z"', ""))

      assert.strictEqual(plays.length, recordedPlays - 1)
      assert.notStrictEqual(plays[0]?.play.id, PlayId.make("40187297140"))
    })
  )

  it.effect("a summary without drives has no plays", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* EspnSummary.plays("nfl", {}), [])
    })
  )

  it.effect("a play round-trips Equal through its JSON", () =>
    Effect.gen(function* () {
      const plays = yield* EspnSummary.plays("nfl", summary)
      const json = Schema.fromJsonString(Play)
      const back = yield* Effect.forEach(plays, ({ play }) =>
        Schema.encodeEffect(json)(play).pipe(Effect.flatMap(Schema.decodeEffect(json)))
      )

      assert.isTrue(
        back.every((play, i) => Equal.equals(play, plays[i]?.play)),
        "every play reads back Equal"
      )
    })
  )
})

/** The recorded summary with its one `from` replaced by `to`. */
function edited(from: string, to: string): unknown {
  assert.include(recorded, from)
  return JSON.parse(recorded.replace(from, to))
}
