import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Array as Arr, Data, type DateTime, HashSet, Option } from "effect"

/** A FastCast game topic: one game's package, which carries its plays. */
export class Topic extends Data.Class<{ readonly league: LeagueId; readonly game: GameId }> {
  /** The topic FastCast's `tc` names, when it is a game's. */
  static fromTc(tc: string): Option.Option<Topic> {
    return Arr.findFirst(LeagueId.literals, (league) => {
      const prefix = prefixOf(league)
      return tc.startsWith(prefix) && tc.length > prefix.length
        ? Option.some(new Topic({ league, game: GameId.make(tc.slice(prefix.length)) }))
        : Option.none()
    })
  }

  /** The topic of each of `games` live or kicking off within `GameSnapshot.kickoffWindow` at `now`: those FastCast follows. */
  static wantedAt(games: Iterable<GameSnapshot>, now: DateTime.Utc): HashSet.HashSet<Topic> {
    const wanted = [...games].filter((game) => game.isLiveOrKicksOffWithin(GameSnapshot.kickoffWindow, now))
    return HashSet.fromIterable(wanted.map((game) => new Topic({ league: game.league, game: game.id })))
  }

  /** This topic as FastCast's `tc` names it. */
  tc(): string {
    return `${prefixOf(this.league)}${this.game}`
  }
}

function prefixOf(league: LeagueId): string {
  return league === "nfl" ? "gp-football-nfl-" : "gp-football-college-football-"
}
