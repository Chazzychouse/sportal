import { GameId, GameSnapshot, type GameStatus } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Play, PlayId, type PlayKind } from "@sportal/domain/Play"
import { Situation } from "@sportal/domain/Situation"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { Array as Arr, Data, DateTime } from "effect"

/** A written scenario before it is written as frames: each offset's slate, and the plays run at that offset. */
export class ScenarioScript extends Data.Class<{
  readonly name: string
  /** When the scenario starts, as written. */
  readonly origin: DateTime.Utc
  /** In order of `at`, milliseconds after `origin`, the first at 0. */
  readonly steps: ReadonlyArray<{
    readonly at: number
    readonly slate: ReadonlyArray<GameSnapshot>
    readonly plays: ReadonlyArray<{ readonly game: GameId; readonly play: Play }>
  }>
}> {
  /**
   * A scenario written as games and the changes to each from an offset in scenario time ("m:ss" or "h:mm:ss";
   * a kickoff may be negative, for a game already under way). It starts at 2026-10-03 16:00 UTC. Each game is
   * scheduled at its kickoff (the start, unless given) until its first change; each change merges onto the game
   * as it was, and a change with a play runs that play. There is one step per distinct offset.
   */
  static build(
    name: string,
    games: ReadonlyArray<{
      readonly id: string
      readonly home: string
      readonly away: string
      readonly league?: LeagueId
      readonly network?: string
      readonly kickoff?: string
      readonly ranking?: { readonly home?: number; readonly away?: number }
      readonly timeline: ReadonlyArray<readonly [offset: string, change: Change]>
    }>
  ): ScenarioScript {
    const origin = DateTime.makeUnsafe("2026-10-03T16:00:00Z")
    const written = games.map((game) => {
      const first = initial(game, origin)
      return {
        first,
        moments: played(
          first,
          [...game.timeline]
            .map(([offset, change]) => ({ at: millisOf(offset), change }))
            .sort((a, b) => a.at - b.at)
        )
      }
    })
    const offsets = [...new Set([0, ...written.flatMap(({ moments }) => moments.map(({ at }) => at))])].sort(
      (a, b) => a - b
    )
    return new ScenarioScript({
      name,
      origin,
      steps: offsets.map((at) => ({
        at,
        slate: written.map(
          ({ first, moments }) => moments.findLast((moment) => moment.at <= at)?.game ?? first
        ),
        plays: written.flatMap(({ first, moments }) =>
          moments
            .filter((moment) => moment.at === at)
            .flatMap(({ plays }) => plays.map((play) => ({ game: first.id, play })))
        )
      }))
    })
  }
}

/** What `build` says changes in a game at an offset. */
type Change = {
  readonly status?: GameStatus
  readonly period?: number
  readonly clock?: string
  readonly score?: readonly [home: number, away: number]
  /**
   * Who has the ball and where, `yardLine` being yards to the goal they attack (the ESPN adapter orients ESPN's yard line this way);
   * `null` while the ball is dead (after a score, at a break).
   */
  readonly ball?: {
    readonly team: "home" | "away"
    readonly yardLine: number
    readonly down: number
    readonly distance: number
  } | null
  readonly timeouts?: readonly [home: number, away: number]
  /** The play's text, unless given. */
  readonly lastPlay?: string
  /** The play that made this change, written in a sentence of its kind and yards unless `text` is given. */
  readonly play?: { readonly kind: PlayKind; readonly yards: number; readonly text?: string }
}

/** A game as `build` first writes it: scheduled at its kickoff, nil–nil. */
function initial(
  game: Parameters<typeof ScenarioScript.build>[1][number],
  origin: DateTime.Utc
): GameSnapshot {
  const league = game.league ?? "fbs"
  return snapshot({
    id: GameId.make(game.id),
    league,
    kickoff: DateTime.add(origin, { milliseconds: millisOf(game.kickoff ?? "0:00") }),
    home: {
      team: team(game.home, league),
      score: 0,
      ...(game.ranking?.home === undefined ? {} : { ranking: game.ranking.home })
    },
    away: {
      team: team(game.away, league),
      score: 0,
      ...(game.ranking?.away === undefined ? {} : { ranking: game.ranking.away })
    },
    broadcasts: game.network === undefined ? [] : [broadcast(game.network)]
  })
}

/**
 * The game after each change of its timeline, in order, with the play the change ran: numbered from 1 for the game,
 * and named `<game id>-<number>`.
 */
function played(
  first: GameSnapshot,
  timeline: ReadonlyArray<{ readonly at: number; readonly change: Change }>
): ReadonlyArray<{ readonly at: number; readonly game: GameSnapshot; readonly plays: ReadonlyArray<Play> }> {
  const [, moments] = Arr.mapAccum(
    timeline,
    { game: first, sequence: 0 },
    ({ game, sequence }, { at, change }) => {
      const after = changed(game, change)
      const next = change.play === undefined ? sequence : sequence + 1
      const plays = change.play === undefined ? [] : [playOf(game, after, change.play, next)]
      return [
        { game: after, sequence: next },
        { at, game: after, plays }
      ] as const
    }
  )
  return moments
}

/** "m:ss", "h:mm:ss", or either with a leading "-", in milliseconds. */
function millisOf(offset: string): number {
  const seconds = offset
    .replace(/^-/, "")
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0)
  return (offset.startsWith("-") ? -1 : 1) * seconds * 1000
}

function changed(game: GameSnapshot, change: Change): GameSnapshot {
  const [home, away] = change.score ?? [game.home.score, game.away.score]
  const status = change.status ?? game.status
  const situation = situationOf(
    game,
    status,
    change.play === undefined || change.lastPlay !== undefined
      ? change
      : { ...change, lastPlay: textOf(change.play) }
  )
  return new GameSnapshot({
    ...game,
    status,
    period: change.period ?? game.period,
    clock: change.clock ?? game.clock,
    home: { ...game.home, score: home },
    away: { ...game.away, score: away },
    ...(situation === undefined ? {} : { situation })
  })
}

/**
 * The game's situation after `change`: none until the game is live or a change describes one, and from then on
 * the earlier situation with the change merged in. Three timeouts each unless said otherwise.
 */
function situationOf(game: GameSnapshot, status: GameStatus, change: Change): Situation | undefined {
  const before = game.situation
  const describes =
    change.ball !== undefined || change.timeouts !== undefined || change.lastPlay !== undefined
  if (before === undefined && !describes)
    return status === "live" ? new Situation({ homeTimeouts: 3, awayTimeouts: 3 }) : undefined
  const [homeTimeouts, awayTimeouts] = change.timeouts ?? [
    before?.homeTimeouts ?? 3,
    before?.awayTimeouts ?? 3
  ]
  const lastPlay = change.lastPlay ?? before?.lastPlay
  const timing = { homeTimeouts, awayTimeouts, ...(lastPlay === undefined ? {} : { lastPlay }) }
  if (change.ball === null) return new Situation(timing)
  if (change.ball === undefined) return new Situation({ ...before, ...timing })
  const { team: side, yardLine, down, distance } = change.ball
  return new Situation({
    possession: game[side].team.id,
    yardLine,
    down,
    distance,
    ...timing
  })
}

/**
 * The play a change ran, numbered `sequence`: its team is the one with the ball before, it goes from the ball before to
 * the ball after (only its team, when the ball is dead after), and it scores when the score changed.
 */
function playOf(
  before: GameSnapshot,
  after: GameSnapshot,
  play: NonNullable<Change["play"]>,
  sequence: number
): Play {
  const team = before.situation?.possession
  const spot = (situation: Situation | undefined) => ({
    team: situation?.possession,
    yardsToEndzone: situation?.yardLine,
    down: situation?.down,
    distance: situation?.distance
  })
  return new Play({
    id: PlayId.make(`${before.id}-${sequence}`),
    sequence,
    period: after.period,
    clock: after.clock,
    team,
    kind: play.kind,
    text: textOf(play),
    yards: play.yards,
    scoring: after.home.score !== before.home.score || after.away.score !== before.away.score,
    homeScore: after.home.score,
    awayScore: after.away.score,
    start: spot(before.situation),
    end: after.situation?.possession === undefined ? { team } : spot(after.situation)
  })
}

/** The play's own text, or a sentence of its kind and yards: "Rush for 4 yards". */
function textOf(play: NonNullable<Change["play"]>): string {
  if (play.text !== undefined) return play.text
  const yards = `${Math.abs(play.yards)} ${Math.abs(play.yards) === 1 ? "yard" : "yards"}`
  return sentences[play.kind](yards)
}

const sentences: Readonly<Record<PlayKind, (yards: string) => string>> = {
  rush: (yards) => `Rush for ${yards}`,
  pass: (yards) => `Pass complete for ${yards}`,
  incompletion: () => "Pass incomplete",
  sack: (yards) => `Sacked for a loss of ${yards}`,
  interception: () => "Pass intercepted",
  fumble: () => "Fumble, recovered by the offense",
  fumbleLost: () => "Fumble, recovered by the defense",
  punt: (yards) => `Punt for ${yards}`,
  kickoff: (yards) => `Kickoff for ${yards}`,
  fieldGoal: (yards) => `Field goal from ${yards}`,
  extraPoint: () => "Extra point is good",
  twoPoint: () => "Two-point conversion",
  penalty: (yards) => `Penalty for ${yards}`,
  timeout: () => "Timeout",
  endPeriod: () => "End of period",
  other: () => "Play"
}
