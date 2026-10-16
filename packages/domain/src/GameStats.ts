import { Option, Schema } from "effect"
import { GameId } from "./Game.ts"
import { Highlight } from "./Highlight.ts"
import { PlayId } from "./Play.ts"

/** One team stat as the provider words it, each side's value as it shows it ("24", "7-17", "35:38"). */
export const TeamStat = Schema.Struct({ label: Schema.String, home: Schema.String, away: Schema.String })
export type TeamStat = typeof TeamStat.Type

/** A side's best in one category: the athlete, and their line as the provider shows it. */
export const Leader = Schema.Struct({
  category: Schema.String,
  side: Schema.Literals(["home", "away"]),
  athlete: Schema.Struct({ name: Schema.String, headshot: Schema.optional(Schema.String) }),
  line: Schema.String
})
export type Leader = typeof Leader.Type

/** The home side's chance of winning after a play, 0 to 1. */
export const WinChance = Schema.Struct({
  play: PlayId,
  home: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
})
export type WinChance = typeof WinChance.Type

/**
 * A game's stats, in any sport: points per period, team stats in the provider's order and words, each side's
 * leaders, the home side's win probability by play when the provider has it, the scoring plays in order, and the
 * game's highlights.
 */
export class GameStats extends Schema.Class<GameStats>("sportal/GameStats")({
  game: GameId,
  linescore: Schema.Struct({ home: Schema.Array(Schema.Int), away: Schema.Array(Schema.Int) }),
  teamStats: Schema.Array(TeamStat),
  leaders: Schema.Array(Leader),
  winProbability: Schema.optional(Schema.Array(WinChance)),
  scoringPlays: Schema.Array(PlayId),
  highlights: Schema.Array(Highlight)
}) {
  /** A game with nothing to show yet: before its start. */
  static empty(game: GameId): GameStats {
    return new GameStats({
      game,
      linescore: { home: [], away: [] },
      teamStats: [],
      leaders: [],
      scoringPlays: [],
      highlights: []
    })
  }

  /**
   * The home side's share of a stat whose values are both plain numbers, for a two-sided bar; an even split when both
   * are 0. None for a stat shown as text ("7-17", "35:38").
   */
  static homeShare(stat: TeamStat): Option.Option<number> {
    if (!plainNumber.test(stat.home) || !plainNumber.test(stat.away)) return Option.none()
    const home = Number(stat.home)
    const total = home + Number(stat.away)
    return Option.some(total === 0 ? 0.5 : home / total)
  }
}

const plainNumber = /^\d+(\.\d+)?$/
