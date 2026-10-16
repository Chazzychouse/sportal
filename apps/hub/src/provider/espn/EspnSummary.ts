import type { GameId } from "@sportal/domain/Game"
import { GameStats, type Leader, type TeamStat } from "@sportal/domain/GameStats"
import { Highlight, HighlightId } from "@sportal/domain/Highlight"
import { League, type LeagueId } from "@sportal/domain/League"
import { PlayId } from "@sportal/domain/Play"
import { Effect, Schema } from "effect"
import {
  EspnSummaryPayload,
  type SummaryLeaders,
  type SummaryStat,
  type SummaryVideo
} from "./EspnSummaryPayload.ts"

/**
 * Game `game` of `league`'s summary `body` read as its stats. Points per period come from the header; team stats pair
 * the two sides' box score rows by name, in ESPN's order and words (baseball keeps a few of each group); leaders are
 * each category's first athlete, on the side of their team; scoring plays are ESPN's own list, or for baseball, which
 * has none, the plays marked scoring. Basketball has no scoring plays: every basket scores. A win probability point
 * outside 0 to 1 is left out, as is a video with no mp4 or no duration in whole seconds.
 */
export const decode = Effect.fnUntraced(function* (league: LeagueId, game: GameId, body: string) {
  const summary = yield* decodeSummary(body)
  const [competition] = summary.header.competitions

  const sideOf = new Map(competition.competitors.map(({ id, homeAway }) => [id, homeAway] as const))
  const linescoreOf = (side: "home" | "away") =>
    (competition.competitors.find(({ homeAway }) => homeAway === side)?.linescores ?? []).map(
      ({ displayValue }) => pointsOf(displayValue)
    )
  const rowsOf = (side: "home" | "away") =>
    rowsFrom(summary.boxscore?.teams.find(({ homeAway }) => homeAway === side)?.statistics ?? [])

  const linescore = { home: linescoreOf("home"), away: linescoreOf("away") }
  const teamStats = paired(rowsOf("home"), rowsOf("away"))
  const leaders = leadersOf(summary.leaders ?? [], sideOf)
  const winProbability = summary.winprobability?.flatMap(({ playId, homeWinPercentage }) =>
    homeWinPercentage < 0 || homeWinPercentage > 1
      ? []
      : [{ play: PlayId.make(playId), home: homeWinPercentage }]
  )
  const scoringPlays = scoringOf(league, summary)
  const highlights = (summary.videos ?? []).flatMap((video) => highlightOf(game, video))
  return new GameStats({ game, linescore, teamStats, leaders, winProbability, scoringPlays, highlights })
})

/** A team stat row before pairing: ESPN's name for it, its label, and this side's value. */
interface Row {
  readonly name: string
  readonly label: string
  readonly value: string
}

// A period's points are digits; anything else reads as 0.
function pointsOf(displayValue: string): number {
  return Number.parseInt(displayValue, 10) || 0
}

/** A side's rows: each labeled stat, and each kept stat of a group, named `<group>.<stat>`. */
function rowsFrom(statistics: ReadonlyArray<SummaryStat>): ReadonlyArray<Row> {
  return statistics.flatMap(({ name, label, displayValue, stats }) => {
    if (stats !== undefined) {
      const kept = groupedKept[name] ?? []
      return stats
        .filter((stat) => kept.includes(stat.name))
        .map((stat) => ({ name: `${name}.${stat.name}`, label: stat.displayName, value: stat.displayValue }))
    }
    return label === undefined || displayValue === undefined ? [] : [{ name, label, value: displayValue }]
  })
}

/**
 * The stats of baseball's groups that a stats view shows; the rest (ratings, rates per nine, games played) say
 * nothing about one game.
 */
const groupedKept: Readonly<Record<string, ReadonlyArray<string>>> = {
  batting: ["hits", "homeRuns", "RBIs", "walks", "strikeouts", "stolenBases", "runnersLeftOnBase", "avg"],
  pitching: ["pitches", "ERA"],
  fielding: ["errors"]
}

/**
 * The home rows in order, each with the away row of its name: the one at the same place when its name matches (ESPN
 * repeats a name, as NFL's "interceptions"), else the first of that name. A row only one side has is left out.
 */
function paired(home: ReadonlyArray<Row>, away: ReadonlyArray<Row>): ReadonlyArray<TeamStat> {
  return home.flatMap((row, index) => {
    const same = away[index]
    const other = same?.name === row.name ? same : away.find(({ name }) => name === row.name)
    return other === undefined ? [] : [{ label: row.label, home: row.value, away: other.value }]
  })
}

/** Each category's first athlete, on the side its team plays; a team the header does not name is left out. */
function leadersOf(
  teams: ReadonlyArray<SummaryLeaders>,
  sideOf: ReadonlyMap<string, "home" | "away">
): ReadonlyArray<Leader> {
  return teams.flatMap(({ team, leaders }) => {
    const side = sideOf.get(team.id)
    if (side === undefined) return []
    return leaders.flatMap(({ displayName, leaders: athletes }) => {
      const [first] = athletes
      if (first === undefined) return []
      const athlete = { name: first.athlete.displayName, headshot: first.athlete.headshot?.href }
      return [{ category: displayName, side, athlete, line: first.displayValue }]
    })
  })
}

function scoringOf(league: LeagueId, summary: EspnSummaryPayload): ReadonlyArray<PlayId> {
  if (summary.scoringPlays !== undefined) return summary.scoringPlays.map(({ id }) => PlayId.make(id))
  if (League.of(league).sport !== "baseball") return []
  return (summary.plays ?? [])
    .filter(({ scoringPlay }) => scoringPlay === true)
    .map(({ id }) => PlayId.make(id))
}

function highlightOf(game: GameId, video: SummaryVideo): ReadonlyArray<Highlight> {
  const source = video.links?.source
  const duration = video.duration
  if (source === undefined || duration === undefined || !Number.isInteger(duration)) return []
  return [
    new Highlight({
      id: HighlightId.make(String(video.id)),
      game,
      headline: video.headline,
      duration,
      video: source.HD?.href ?? source.href,
      ...(video.thumbnail === undefined ? {} : { thumbnail: video.thumbnail })
    })
  ]
}

const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(EspnSummaryPayload))
