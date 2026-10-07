import { readFileSync } from "node:fs"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Play, PlayId } from "@sportal/domain/Play"
import { TeamId } from "@sportal/domain/Team"
import { DateTime, Effect, Equal, Layer, Logger, Order, Schema } from "effect"
import type { ArchivedPlay } from "../../corpus/Archive.ts"
import * as Gzip from "../../Gzip.ts"
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

  it.effect(
    "a timeout's caller is the header's team when the text uses another code for it: WAS for the header's WSH",
    () =>
      Effect.gen(function* () {
        // WSH at PHI of 2026-09-13, as the archive fetched it:
        //   curl 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872929' | gzip \
        //     > fixtures/nfl-summary-401872929.json.gz
        // Its timeouts name PHI, and WAS for Washington, which its header calls WSH.
        const plays = yield* EspnSummary.plays("nfl", yield* gzipped("nfl-summary-401872929"))

        assert.deepStrictEqual(
          plays.flatMap(({ play, ...archived }) =>
            play.kind === "timeout" ? [[play.period, play.clock, archived.timeoutBy]] : []
          ),
          [
            [1, "1:02", nfl("21")],
            [2, "0:33", nfl("28")],
            [3, "10:03", nfl("28")],
            [4, "2:04", nfl("28")],
            [4, "1:01", nfl("21")]
          ]
        )
      })
  )

  it.effect(
    "a timeout's caller is the one team whose place has the code's letters in order: CLV for Cleveland",
    () =>
      Effect.gen(function* () {
        // CLE at JAX of 2026-09-13, as the archive fetched it:
        //   curl 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872922' | gzip \
        //     > fixtures/nfl-summary-401872922.json.gz
        // Only Cleveland called timeouts, each "by CLV", which no header abbreviation is and no elimination places.
        const plays = yield* EspnSummary.plays("nfl", yield* gzipped("nfl-summary-401872922"))

        assert.deepStrictEqual(timeoutsOf(plays), [
          [2, "4:52", nfl("5")],
          [2, "1:45", nfl("5")],
          [3, "0:50", nfl("5")]
        ])
      })
  )

  it.effect('a college timeout\'s caller is the school its text names: "Timeout Georgia, clock 02:05"', () =>
    Effect.gen(function* () {
      // VAN at UGA of 2026-10-03, once it was final:
      //   curl 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=401856705' \
      //     | gzip > fixtures/fbs-summary-401856705.json.gz
      // Its timeouts name each school by its place, two of them at 2:00.
      const plays = yield* EspnSummary.plays("fbs", yield* gzipped("fbs-summary-401856705"))
      const fbs = (team: string) => TeamId.make(`fbs:${team}`)

      assert.deepStrictEqual(timeoutsOf(plays), [
        [2, "2:05", fbs("61")],
        [2, "2:00", fbs("238")],
        [2, "0:35", fbs("238")],
        [3, "1:37", fbs("238")],
        [4, "2:00", fbs("61")]
      ])
    })
  )

  it.effect("a timeout no team called says no caller, and is not warned of", () =>
    Effect.gen(function* () {
      const logs: Array<string> = []
      const plays = yield* EspnSummary.plays(
        "nfl",
        edited("Timeout #1 by NE at 03:27.", "Official timeout at 03:27.")
      ).pipe(Effect.provide(captured(logs)))

      assert.deepStrictEqual(timeoutsOf(plays)[0], [1, "3:27", undefined])
      assert.deepStrictEqual(logs, [])
    })
  )

  it.effect("a code left over once both teams are named names no caller", () =>
    Effect.gen(function* () {
      const plays = yield* EspnSummary.plays(
        "nfl",
        edited("Timeout #1 by BUF at 00:45.", "Timeout #1 by XYZ at 00:45.")
      )

      assert.deepStrictEqual(
        plays.flatMap(({ play, ...archived }) =>
          play.kind === "timeout" ? [[play.period, play.clock, archived.timeoutBy]] : []
        ),
        [
          [1, "3:27", nfl("17")],
          [2, "0:45", undefined],
          [2, "0:16", nfl("2")],
          [4, "1:00", nfl("2")],
          [4, "0:42", nfl("2")],
          [4, "0:39", nfl("2")]
        ]
      )
    })
  )

  it.effect("one code no header team has is the one team never named", () =>
    Effect.gen(function* () {
      const plays = yield* EspnSummary.plays(
        "nfl",
        edited("Timeout #1 by NE at 03:27.", "Timeout #1 by NWE at 03:27.")
      )

      assert.strictEqual(plays.find(({ play }) => play.kind === "timeout")?.timeoutBy, nfl("17"))
    })
  )

  it.effect("a timeout whose caller does not read says none, and the game still reads", () =>
    Effect.gen(function* () {
      const logs: Array<string> = []
      const plays = yield* EspnSummary.plays(
        "nfl",
        edited("Timeout #1 by NE at 03:27.", "Timeout #1 at 03:27.")
      ).pipe(Effect.provide(captured(logs)))
      const timeout = plays.find(({ play }) => play.kind === "timeout")

      assert.strictEqual(logs.length, 1)
      assert.include(logs[0], "name neither team")

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
// A recorded summary kept gzip'd in `fixtures/`.
function gzipped(name: string) {
  return Gzip.decompress(readFileSync(new URL(`./fixtures/${name}.json.gz`, import.meta.url)), "gzip").pipe(
    Effect.map((text): unknown => JSON.parse(text))
  )
}

// Each timeout's period, clock, and caller.
function timeoutsOf(plays: ReadonlyArray<ArchivedPlay>) {
  return plays.flatMap(({ play, ...archived }) =>
    play.kind === "timeout" ? [[play.period, play.clock, archived.timeoutBy]] : []
  )
}

// A logger that keeps each message logged in `logs`, in place of the default.
function captured(logs: Array<string>) {
  return Logger.layer([
    Logger.make<unknown, void>(({ message }) => {
      logs.push(String(Array.isArray(message) ? message[0] : message))
    })
  ])
}

function edited(from: string, to: string): unknown {
  assert.include(recorded, from)
  return JSON.parse(recorded.replace(from, to))
}
