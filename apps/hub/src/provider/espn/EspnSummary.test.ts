import { readFileSync } from "node:fs"
import { assert, describe, it, layer } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Play, PlayId } from "@sportal/domain/Play"
import { TeamId } from "@sportal/domain/Team"
import { DateTime, Effect, Equal, Layer, Logger, Order, Schema } from "effect"
import * as Gzip from "../../Gzip.ts"
import type { ArchivedPlay } from "../Archive.ts"
import type { Decoded } from "../Decoder.ts"
import { FramesDecoded } from "../TestDecoder.ts"
import * as EspnDecode from "./EspnDecode.ts"
import * as EspnPlay from "./EspnPlay.ts"
import { recordedNeAtBuf, recordedPlays } from "./TestEspn.ts"

// NE–BUF's summary, the game the frames fixture records, recorded once after it was final:
//   curl -o fixtures/nfl-summary-401872971.json \
//     'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872971'
// Its drives list 182 plays, each with a wallclock; its win probability also has the coin toss, which no drive lists.
const recorded = readFileSync(new URL("./fixtures/nfl-summary-401872971.json", import.meta.url), "utf8")
const summary: unknown = JSON.parse(recorded)

// The same game's play entities, as FastCast's game topic lists them.
const fastCast = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)))
)(readFileSync(new URL("./fixtures/nfl-plays-2026-10-04.json", import.meta.url), "utf8"))

const nfl = (team: string) => TeamId.make(`nfl:${team}`)
const fbs = (team: string) => TeamId.make(`fbs:${team}`)

const decodeEntity = Schema.decodeUnknownEffect(EspnPlay.FootballPlay("nfl"))

// NE at BUF's recorded frames, decoded once by ESPN's decode for the tests that read them.
const neAtBufDecoded = FramesDecoded.layerOf(recordedNeAtBuf).pipe(Layer.provide(EspnDecode.layer))

describe("EspnDecode.decoders.decodeSummary", () => {
  it.effect("should read every play a drive lists", () =>
    Effect.gen(function* () {
      const plays = yield* EspnDecode.decoders.nfl.decodeSummary(summary)

      assert.strictEqual(plays.length, recordedPlays)
    })
  )

  it.effect("should read the plays in sequence order", () =>
    Effect.gen(function* () {
      const plays = yield* EspnDecode.decoders.nfl.decodeSummary(summary)

      const sequences = plays.map(({ play }) => play.sequence)

      assert.deepStrictEqual(sequences, sequences.toSorted(Order.Number))
    })
  )

  it.effect("should read the first play, a kickoff, with its wallclock", () =>
    Effect.gen(function* () {
      const [first] = yield* EspnDecode.decoders.nfl.decodeSummary(summary)

      assert.deepStrictEqual(
        [first?.play.id, first?.play._tag, first?.wallclock.epochMilliseconds],
        [PlayId.make("40187297140"), "Kickoff", DateTime.makeUnsafe("2026-10-04T17:02:33Z").epochMilliseconds]
      )
    })
  )

  it.effect("should read the first scoring play's scores, case, and team", () =>
    Effect.gen(function* () {
      const plays = yield* EspnDecode.decoders.nfl.decodeSummary(summary)

      const scoring = plays.find(({ play }) => play.scoring)?.play

      assert.deepStrictEqual(
        [scoring?.id, scoring?.homeScore, scoring?.awayScore, scoring?._tag, completedBy(scoring)],
        [PlayId.make("401872971484"), 0, 7, "Completion", nfl("17")]
      )
    })
  )

  it.effect("should read the first scoring play's scores, case, and team as FastCast's entity does", () =>
    Effect.gen(function* () {
      const pushed = yield* decodeEntity(fastCast["401872971484"])

      assert.deepStrictEqual(
        [pushed.homeScore, pushed.awayScore, pushed._tag, completedBy(pushed)],
        [0, 7, "Completion", nfl("17")]
      )
    })
  )

  it.effect("should read the first scoring play as FastCast's entity for it, field for field", () =>
    Effect.gen(function* () {
      const plays = yield* EspnDecode.decoders.nfl.decodeSummary(summary)
      const pushed = yield* decodeEntity(fastCast["401872971484"])

      const scoring = plays.find(({ play }) => play.scoring)?.play

      assert.isTrue(Equal.equals(scoring, pushed))
    })
  )

  it.effect("should give a lost fumble the recovering team: the team with the ball as it ended", () =>
    Effect.gen(function* () {
      const plays = yield* EspnDecode.decoders.nfl.decodeSummary(summary)

      const fumble = plays
        .map(({ play }) => play)
        .filter(Play.guards.Fumble)
        .find((play) => play.id === PlayId.make("4018729712179"))

      assert.deepStrictEqual(
        [fumble?.recovery, fumble?.team, fumble?.start.team, fumble?.end.team],
        ["opponent", nfl("17"), nfl("2"), nfl("17")]
      )
    })
  )

  it.effect("should read win probability where the summary has the play's", () =>
    Effect.gen(function* () {
      const [first] = yield* EspnDecode.decoders.nfl.decodeSummary(summary)

      assert.strictEqual(first?.play.homeWinProbability, 0.7286)
    })
  )

  it.effect("should read no win probability where the summary has none for the play", () =>
    Effect.gen(function* () {
      const [first] = yield* EspnDecode.decoders.nfl.decodeSummary(withoutFirstProbability())

      assert.isFalse(first !== undefined && "homeWinProbability" in first.play)
    })
  )

  it.effect("should still read the next play's win probability when one is missing", () =>
    Effect.gen(function* () {
      const read = yield* EspnDecode.decoders.nfl.decodeSummary(summary)

      const unread = yield* EspnDecode.decoders.nfl.decodeSummary(withoutFirstProbability())

      assert.isDefined(unread[1]?.play.homeWinProbability)
      assert.strictEqual(unread[1]?.play.homeWinProbability, read[1]?.play.homeWinProbability)
    })
  )

  it.effect("should give each timeout the team its participants mark as calling it", () =>
    Effect.gen(function* () {
      const plays = yield* EspnDecode.decoders.nfl.decodeSummary(summary)

      assert.deepStrictEqual(timeoutsOf(plays), [
        [1, "3:27", nfl("17")],
        [2, "0:45", nfl("2")],
        [2, "0:16", nfl("2")],
        [4, "1:00", nfl("2")],
        [4, "0:42", nfl("2")],
        [4, "0:39", nfl("2")]
      ])
    })
  )

  it.effect("should give each of WSH at PHI's timeouts, from both teams, its caller", () =>
    Effect.gen(function* () {
      // WSH at PHI of 2026-09-13, as the archive fetched it:
      //   curl 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872929' | gzip \
      //     > fixtures/nfl-summary-401872929.json.gz
      // Its timeouts' texts call Washington WAS, which its header calls WSH; the caller comes from the participants.
      const recordedSummary = yield* gzipped("nfl-summary-401872929")

      const plays = yield* EspnDecode.decoders.nfl.decodeSummary(recordedSummary)

      assert.deepStrictEqual(timeoutsOf(plays), [
        [1, "1:02", nfl("21")],
        [2, "0:33", nfl("28")],
        [3, "10:03", nfl("28")],
        [4, "2:04", nfl("28")],
        [4, "1:01", nfl("21")]
      ])
    })
  )

  it.effect("should give each of CLE at JAX's timeouts, all Cleveland's, its caller", () =>
    Effect.gen(function* () {
      // CLE at JAX of 2026-09-13, as the archive fetched it:
      //   curl 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872922' | gzip \
      //     > fixtures/nfl-summary-401872922.json.gz
      // Only Cleveland called timeouts; their texts say "CLV", which no header abbreviation is.
      const recordedSummary = yield* gzipped("nfl-summary-401872922")

      const plays = yield* EspnDecode.decoders.nfl.decodeSummary(recordedSummary)

      assert.deepStrictEqual(timeoutsOf(plays), [
        [2, "4:52", nfl("5")],
        [2, "1:45", nfl("5")],
        [3, "0:50", nfl("5")]
      ])
    })
  )

  it.effect("should give each of a college game's timeouts, VAN at UGA's, its caller", () =>
    Effect.gen(function* () {
      // VAN at UGA of 2026-10-03, once it was final:
      //   curl 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=401856705' \
      //     | gzip > fixtures/fbs-summary-401856705.json.gz
      // Its timeouts' texts name each school by its place ("Timeout Georgia, clock 02:05"), two of them at 2:00.
      const recordedSummary = yield* gzipped("fbs-summary-401856705")

      const plays = yield* EspnDecode.decoders.fbs.decodeSummary(recordedSummary)

      assert.deepStrictEqual(timeoutsOf(plays), [
        [2, "2:05", fbs("61")],
        [2, "2:00", fbs("238")],
        [2, "0:35", fbs("238")],
        [3, "1:37", fbs("238")],
        [4, "2:00", fbs("61")]
      ])
    })
  )

  it.effect("should give a timeout no participant is marked as calling no caller", () =>
    Effect.gen(function* () {
      const plays = yield* EspnDecode.decoders.nfl.decodeSummary(withoutFirstCaller())

      assert.deepStrictEqual(timeoutsOf(plays)[0], [1, "3:27", undefined])
    })
  )

  it.effect("should warn naming a timeout no participant is marked as calling", () =>
    Effect.gen(function* () {
      const warnings: Array<string> = []

      yield* EspnDecode.decoders.nfl
        .decodeSummary(withoutFirstCaller())
        .pipe(Effect.provide(collecting(warnings)))

      assert.deepStrictEqual(warnings, [
        "EspnSummary: nfl timeouts 401872971723 have no caller marked; counted for neither"
      ])
    })
  )

  it.effect("should not warn when every timeout has its caller marked", () =>
    Effect.gen(function* () {
      const warnings: Array<string> = []

      yield* EspnDecode.decoders.nfl.decodeSummary(summary).pipe(Effect.provide(collecting(warnings)))

      assert.deepStrictEqual(warnings, [])
    })
  )

  it.effect("should still read the game when a timeout has no caller", () =>
    Effect.gen(function* () {
      const plays = yield* EspnDecode.decoders.nfl.decodeSummary(withoutFirstCaller())

      assert.strictEqual(plays.length, recordedPlays)
    })
  )

  it.effect("should not read a play without a wallclock", () =>
    Effect.gen(function* () {
      const kickoffWithoutWallclock = edited(',"wallclock":"2026-10-04T17:02:33Z"', "")

      const plays = yield* EspnDecode.decoders.nfl.decodeSummary(kickoffWithoutWallclock)

      // The kickoff, 40187297140, is not read: the first play read is the rush after it.
      assert.deepStrictEqual(
        [plays.length, plays[0]?.play.id],
        [recordedPlays - 1, PlayId.make("40187297163")]
      )
    })
  )

  it.effect("should read no plays from a summary without drives", () =>
    Effect.gen(function* () {
      const plays = yield* EspnDecode.decoders.nfl.decodeSummary({})

      assert.deepStrictEqual(plays, [])
    })
  )

  it.effect("should read plays that round-trip Equal through their JSON", () =>
    Effect.gen(function* () {
      const plays = yield* EspnDecode.decoders.nfl.decodeSummary(summary)
      const json = Schema.fromJsonString(Play)

      const back = yield* Effect.forEach(plays, ({ play }) =>
        Schema.encodeEffect(json)(play).pipe(Effect.flatMap(Schema.decodeEffect(json)))
      )

      assert.isTrue(back.every((play, i) => Equal.equals(play, plays[i]?.play)))
    })
  )
})

// Decoding NE–BUF's whole recording takes about a second alone, and many under a full suite's load: the layer decodes
// it once for the tests that read it, with a timeout to match.
layer(neAtBufDecoded, { timeout: "60 seconds" })(
  "EspnDecode.decoders.decodeSummary, beside the recorded FastCast topic",
  (it) => {
    it.effect("should read the plays the recorded FastCast topic last had, in its order", () =>
      Effect.gen(function* () {
        const decoded = yield* FramesDecoded
        const pushed = lastPushedOf(decoded)

        const plays = yield* EspnDecode.decoders.nfl.decodeSummary(summary)

        assert.deepStrictEqual(
          plays.map(({ play }) => play.id),
          pushed.map((play) => play.id)
        )
      })
    )

    it.effect(
      "should read every field of every play as the recorded FastCast topic last had it, but those ESPN rewrote",
      () =>
        Effect.gen(function* () {
          const decoded = yield* FramesDecoded
          const pushed = lastPushedOf(decoded)

          // Left out: `text`, which ESPN rewrote for the summary (a penalty's line break, a clock prefix, a leading
          // space); and, on the last kneel only, 4018729714600, `yards` and `end`, which ESPN corrected after the game
          // (-2 yards to -1) and FastCast never sent. Every other field of every play is compared, team, case, outcome,
          // period, clock, scores, start and end among them, a timeout's caller too.
          const compared = (play: Play) => {
            const { text: _text, ...rest } = play
            return play.id === PlayId.make("4018729714600") ? { ...rest, yards: 0, end: {} } : { ...rest }
          }

          const plays = yield* EspnDecode.decoders.nfl.decodeSummary(summary)

          assert.deepStrictEqual(
            plays.map(({ play }) => compared(play)),
            pushed.map(compared)
          )
        })
    )

    it.effect(
      "should read every play but three as the recorded FastCast topic last had it, field for field",
      () =>
        Effect.gen(function* () {
          const decoded = yield* FramesDecoded
          const pushed = lastPushedOf(decoded)

          const plays = yield* EspnDecode.decoders.nfl.decodeSummary(summary)

          const equal = plays.filter(({ play }, i) => Equal.equals(play, pushed[i]))
          assert.strictEqual(equal.length, recordedPlays - 3)
        })
    )
  }
)

// A recorded summary kept gzip'd in `fixtures/`.
function gzipped(name: string) {
  return Gzip.decompress(readFileSync(new URL(`./fixtures/${name}.json.gz`, import.meta.url)), "gzip").pipe(
    Effect.map((text): unknown => JSON.parse(text))
  )
}

// Each timeout's period, clock, and caller.
function timeoutsOf(plays: ReadonlyArray<ArchivedPlay>) {
  return plays
    .map(({ play }) => play)
    .filter(Play.guards.Timeout)
    .map((timeout) => [timeout.period, timeout.clock, timeout.team])
}

// A layer beside the default logger that collects each warning's message into `warnings`.
function collecting(warnings: Array<string>) {
  return Logger.layer(
    [
      Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(String(message))
      })
    ],
    { mergeWithExisting: true }
  )
}

// A completion's team; none for another case.
function completedBy(play: Play | undefined) {
  return [play].filter(Play.guards.Completion).at(0)?.team
}

// The recorded summary without the first play's win probability.
function withoutFirstProbability() {
  return edited('{"homeWinPercentage":0.7286,"tiePercentage":0.0,"playId":"40187297140"},', "")
}

// The recorded summary with its first timeout, NE's at 3:27 of the first quarter, marked as called by no team.
function withoutFirstCaller() {
  return edited('"id":"17","order":2,"type":"defense","timeout":true', '"id":"17","order":2,"type":"defense"')
}

// The recorded summary with its first `from` replaced by `to`.
function edited(from: string, to: string): unknown {
  assert.include(recorded, from)
  return JSON.parse(recorded.replace(from, to))
}

/** The plays NE–BUF's recorded FastCast topic last had, from what its frames said. */
function lastPushedOf(decoded: ReadonlyArray<Decoded>): ReadonlyArray<Play> {
  const lists = decoded
    .flatMap(({ deliveries }) => deliveries)
    .flatMap((delivery) =>
      delivery._tag === "Plays" && delivery.game === GameId.make("401872971") ? [delivery.plays] : []
    )
  return lists.at(-1) ?? []
}
