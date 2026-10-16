import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Highlight, HighlightId } from "@sportal/domain/Highlight"
import { PlayId } from "@sportal/domain/Play"
import { Effect, Schema } from "effect"
import * as TestHub from "../../TestHub.ts"
import * as EspnSummary from "./EspnSummary.ts"

describe("EspnSummary.decode", () => {
  describe("an NFL summary", () => {
    it.effect("should read each side's points per quarter", () =>
      Effect.gen(function* () {
        const stats = yield* nfl

        assert.deepStrictEqual(stats.linescore, { home: [0, 17, 0, 9], away: [7, 7, 7, 8] })
      })
    )

    it.effect("should read the team stats in ESPN's order and words", () =>
      Effect.gen(function* () {
        const stats = yield* nfl

        assert.deepStrictEqual(stats.teamStats[0], { label: "1st Downs", home: "19", away: "26" })
      })
    )

    it.effect("should read each leader on the side of its team", () =>
      Effect.gen(function* () {
        const stats = yield* nfl

        assert.deepStrictEqual(stats.leaders[0], {
          category: "Passing Yards",
          side: "home",
          athlete: {
            name: "Josh Allen",
            headshot: "https://a.espncdn.com/i/headshots/nfl/players/full/3918298.png"
          },
          line: "23/33, 253 YDS, 1 TD, 1 INT"
        })
      })
    )

    it.effect("should read the home side's win probability by play", () =>
      Effect.gen(function* () {
        const stats = yield* nfl

        assert.strictEqual(stats.winProbability?.length, 183)
        assert.deepStrictEqual(stats.winProbability?.[0], { play: PlayId.make("4018729711"), home: 0.7057 })
      })
    )

    it.effect("should read the scoring plays in order", () =>
      Effect.gen(function* () {
        const stats = yield* nfl

        assert.strictEqual(stats.scoringPlays.length, 9)
        assert.deepStrictEqual(stats.scoringPlays.slice(0, 2), [
          PlayId.make("401872971484"),
          PlayId.make("401872971967")
        ])
      })
    )

    it.effect("should read no highlights from a summary with no videos", () =>
      Effect.gen(function* () {
        const stats = yield* nfl

        assert.deepStrictEqual(stats.highlights, [])
      })
    )

    it.effect("should read no win probability from a summary that sends none", () =>
      Effect.gen(function* () {
        const body = withoutKey(TestHub.recordedSummary("nfl-summary-401872971"), "winprobability")

        const stats = yield* EspnSummary.decode("nfl", GameId.make("401872971"), body)

        assert.isUndefined(stats.winProbability)
      })
    )

    it.effect("should leave out a win probability point outside 0 to 1", () =>
      Effect.gen(function* () {
        const body = withFirstOf(TestHub.recordedSummary("nfl-summary-401872971"), "winprobability", {
          homeWinPercentage: 1.5
        })

        const stats = yield* EspnSummary.decode("nfl", GameId.make("401872971"), body)

        assert.strictEqual(stats.winProbability?.length, 182)
      })
    )
  })

  describe("an FBS summary", () => {
    it.effect("should read each side's points per quarter", () =>
      Effect.gen(function* () {
        const stats = yield* fbs

        assert.deepStrictEqual(stats.linescore, { home: [0, 14, 3, 0], away: [3, 7, 7, 3] })
      })
    )

    it.effect("should read its videos as highlights, each with its HD mp4", () =>
      Effect.gen(function* () {
        const stats = yield* fbs

        assert.strictEqual(stats.highlights.length, 13)
        assert.deepStrictEqual(
          stats.highlights[0],
          new Highlight({
            id: HighlightId.make("50152231"),
            game: GameId.make("401856712"),
            headline: "Georgia takes control after forcing a Keelon Russell fumble",
            duration: 33,
            video:
              "https://espnmedia-cdn.akamaized.net/espn/media/16x9/wsc/2026/1011/ebdf8121-464c-46cf-a01a-963fbe7523ba/ebdf8121-464c-46cf-a01a-963fbe7523ba.mp4",
            thumbnail:
              "https://espnmedia-cdn.akamaized.net/espn/media/common/wsc/2026/1011/ebdf8121-464c-46cf-a01a-963fbe7523ba/ebdf8121-464c-46cf-a01a-963fbe7523ba.jpg"
          })
        )
      })
    )

    it.effect("should leave out a video whose duration is not whole seconds", () =>
      Effect.gen(function* () {
        const body = withFirstOf(TestHub.recordedSummary("fbs-summary-401856712"), "videos", {
          duration: 33.5
        })

        const stats = yield* EspnSummary.decode("fbs", GameId.make("401856712"), body)

        assert.strictEqual(stats.highlights.length, 12)
      })
    )

    it.effect("should leave out a video with no duration", () =>
      Effect.gen(function* () {
        const body = withFirstOf(TestHub.recordedSummary("fbs-summary-401856712"), "videos", {
          duration: undefined
        })

        const stats = yield* EspnSummary.decode("fbs", GameId.make("401856712"), body)

        assert.strictEqual(stats.highlights.length, 12)
      })
    )
  })

  describe("an MLB summary", () => {
    it.effect("should read each side's runs per inning, the home side's last half unplayed", () =>
      Effect.gen(function* () {
        const stats = yield* mlb

        assert.deepStrictEqual(stats.linescore, {
          home: [0, 1, 0, 0, 2, 0, 0, 0],
          away: [0, 0, 0, 2, 0, 0, 0, 0, 0]
        })
      })
    )

    it.effect("should keep only the chosen stats of its batting, pitching and fielding groups", () =>
      Effect.gen(function* () {
        const stats = yield* mlb

        assert.strictEqual(stats.teamStats.length, 11)
        assert.deepStrictEqual(stats.teamStats[0], { label: "Strikeouts", home: "8", away: "13" })
      })
    )

    it.effect("should read its scoring plays from its plays", () =>
      Effect.gen(function* () {
        const stats = yield* mlb

        assert.deepStrictEqual(stats.scoringPlays, [
          PlayId.make("4019080250302990057"),
          PlayId.make("4019080250605990057"),
          PlayId.make("4019080250902990057")
        ])
      })
    )

    it.effect("should read no leaders, since ESPN sends none for baseball", () =>
      Effect.gen(function* () {
        const stats = yield* mlb

        assert.deepStrictEqual(stats.leaders, [])
      })
    )
  })

  describe("an NBA summary", () => {
    it.effect("should read the team stats in ESPN's words", () =>
      Effect.gen(function* () {
        const stats = yield* nba

        assert.deepStrictEqual(stats.teamStats[0], { label: "FG", home: "43-90", away: "40-79" })
      })
    )

    it.effect("should read each leader on the side of its team", () =>
      Effect.gen(function* () {
        const stats = yield* nba

        assert.deepStrictEqual(
          [stats.leaders[0]?.category, stats.leaders[0]?.side, stats.leaders[0]?.athlete.name],
          ["Points", "home", "Jalen Brunson"]
        )
      })
    )

    it.effect("should read no scoring plays, since every basket scores", () =>
      Effect.gen(function* () {
        const stats = yield* nba

        assert.deepStrictEqual(stats.scoringPlays, [])
      })
    )

    it.effect("should read its first highlight", () =>
      Effect.gen(function* () {
        const stats = yield* nba

        assert.strictEqual(stats.highlights[0]?.id, HighlightId.make("50193529"))
        assert.strictEqual(stats.highlights[0]?.duration, 74)
      })
    )
  })
})

const nfl = EspnSummary.decode(
  "nfl",
  GameId.make("401872971"),
  TestHub.recordedSummary("nfl-summary-401872971")
)
const fbs = EspnSummary.decode(
  "fbs",
  GameId.make("401856712"),
  TestHub.recordedSummary("fbs-summary-401856712")
)
const mlb = EspnSummary.decode(
  "mlb",
  GameId.make("401908025"),
  TestHub.recordedSummary("mlb-summary-401908025")
)
const nba = EspnSummary.decode(
  "nba",
  GameId.make("401908945"),
  TestHub.recordedSummary("nba-summary-401908945")
)

/** `body`, a JSON object, without its key `key`. */
function withoutKey(body: string, key: string): string {
  const summary = Schema.decodeSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(body)
  return JSON.stringify(Object.fromEntries(Object.entries(summary).filter(([each]) => each !== key)))
}

/**
 * `body`, a JSON object, with `fields` over the first entry of its array `key`; a field given as undefined is dropped.
 */
function withFirstOf(
  body: string,
  key: string,
  fields: Readonly<Record<string, Schema.Json | undefined>>
): string {
  const summary = Schema.decodeSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(body)
  const [first, ...rest] = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Json)))(
    summary[key]
  )
  return JSON.stringify({ ...summary, [key]: [{ ...first, ...fields }, ...rest] })
}
