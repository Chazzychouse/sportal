import { DateTime, Duration, Schema } from "effect"
import { GameId, GameSnapshot, type GameStatus } from "./Game.ts"
import type { LeagueId } from "./League.ts"
import { Situation } from "./Situation.ts"
import { broadcast, snapshot, team } from "./TestGame.ts"

/** The whole slate `at` milliseconds after a scenario starts. */
const Frame = Schema.Struct({ at: Schema.Int, slate: Schema.Array(GameSnapshot) })

/**
 * A timeline of game snapshots for several games, scripted or cut from a recording, that a Hub can play instead
 * of a provider. Its instants are as written or recorded; `slateAt` moves them to when it is played.
 */
export class Scenario extends Schema.Class<Scenario>("sportal/Scenario")({
  name: Schema.String,
  /** When the scenario starts, as written or recorded. */
  origin: Schema.DateTimeUtcFromString,
  /** In order of `at`, the first at 0. */
  frames: Schema.Array(Frame)
}) {
  /**
   * A scenario written as games and the changes to each from an offset in scenario time ("m:ss" or "h:mm:ss";
   * a kickoff may be negative, for a game already under way). It starts at 2026-10-03 16:00 UTC. Each game is
   * scheduled at its kickoff (the start, unless given) until its first change; each change merges onto the game
   * as it was. There is one frame per distinct offset.
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
      readonly timeline: ReadonlyArray<
        readonly [
          offset: string,
          change: {
            readonly status?: GameStatus
            readonly period?: number
            readonly clock?: string
            readonly score?: readonly [home: number, away: number]
            /**
             * Who has the ball and where, `yardLine` being yards to the goal they attack, as ESPN reports it;
             * `null` while the ball is dead (after a score, at a break).
             */
            readonly ball?: {
              readonly team: "home" | "away"
              readonly yardLine: number
              readonly down: number
              readonly distance: number
            } | null
            readonly timeouts?: readonly [home: number, away: number]
            readonly lastPlay?: string
          }
        ]
      >
    }>
  ): Scenario {
    const origin = DateTime.makeUnsafe("2026-10-03T16:00:00Z")
    const steps = games.map((game) => ({
      first: initial(game, origin),
      timeline: [...game.timeline]
        .map(([offset, change]) => ({ at: millisOf(offset), change }))
        .sort((a, b) => a.at - b.at)
    }))
    const offsets = [...new Set([0, ...steps.flatMap(({ timeline }) => timeline.map(({ at }) => at))])].sort(
      (a, b) => a - b
    )
    return new Scenario({
      name,
      origin,
      frames: offsets.map((at) => ({
        at,
        slate: steps.map(({ first, timeline }) =>
          timeline.filter((step) => step.at <= at).reduce((game, step) => changed(game, step.change), first)
        )
      }))
    })
  }

  /**
   * The slate `elapsed` after the scenario started at `start`: the latest frame by then, held after the last,
   * with every instant moved by the time from the scenario's origin to `start`.
   */
  slateAt(start: DateTime.Utc, elapsed: Duration.Duration): ReadonlyArray<GameSnapshot> {
    const at = Duration.toMillis(elapsed)
    const frame = this.frames.findLast((candidate) => candidate.at <= at) ?? this.frames[0]
    if (frame === undefined) return []
    const shift = DateTime.toEpochMillis(start) - DateTime.toEpochMillis(this.origin)
    return frame.slate.map(
      (game) =>
        new GameSnapshot({
          ...game,
          kickoff: DateTime.makeUnsafe(DateTime.toEpochMillis(game.kickoff) + shift)
        })
    )
  }
}

/** A game as `build` first writes it: scheduled at its kickoff, nil–nil. */
function initial(game: Parameters<typeof Scenario.build>[1][number], origin: DateTime.Utc): GameSnapshot {
  const league = game.league ?? "fbs"
  return snapshot({
    id: GameId.make(game.id),
    league,
    kickoff: DateTime.makeUnsafe(DateTime.toEpochMillis(origin) + millisOf(game.kickoff ?? "0:00")),
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

/** "m:ss", "h:mm:ss", or either with a leading "-", in milliseconds. */
function millisOf(offset: string): number {
  const seconds = offset
    .replace(/^-/, "")
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0)
  return (offset.startsWith("-") ? -1 : 1) * seconds * 1000
}

function changed(
  game: GameSnapshot,
  change: Parameters<typeof Scenario.build>[1][number]["timeline"][number][1]
): GameSnapshot {
  const [home, away] = change.score ?? [game.home.score, game.away.score]
  const status = change.status ?? game.status
  const situation = situationOf(game, status, change)
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
function situationOf(
  game: GameSnapshot,
  status: GameStatus,
  change: Parameters<typeof Scenario.build>[1][number]["timeline"][number][1]
): Situation | undefined {
  const before = game.situation
  const describes =
    change.ball !== undefined || change.timeouts !== undefined || change.lastPlay !== undefined
  if (before === undefined && !describes)
    return status === "live"
      ? new Situation({ isRedZone: false, homeTimeouts: 3, awayTimeouts: 3 })
      : undefined
  const [homeTimeouts, awayTimeouts] = change.timeouts ?? [
    before?.homeTimeouts ?? 3,
    before?.awayTimeouts ?? 3
  ]
  const lastPlay = change.lastPlay ?? before?.lastPlay
  const timing = { homeTimeouts, awayTimeouts, ...(lastPlay === undefined ? {} : { lastPlay }) }
  if (change.ball === null) return new Situation({ isRedZone: false, ...timing })
  if (change.ball === undefined) return new Situation({ ...(before ?? { isRedZone: false }), ...timing })
  const { team: side, yardLine, down, distance } = change.ball
  return new Situation({
    possession: game[side].team.id,
    yardLine,
    down,
    distance,
    isRedZone: yardLine <= 20,
    ...timing
  })
}
