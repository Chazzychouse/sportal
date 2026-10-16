import { GameId } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Array as Arr, Data, Option } from "effect"

/**
 * A league ESPN serves the Hub: where its site scoreboard and game summary are, and its FastCast game topic prefix.
 * A sport joins by a row in `followed` and its situation and play-detail decode in `EspnEvent` and `EspnPlay`.
 */
export class EspnLeague extends Data.Class<{
  readonly league: LeagueId
  /** ESPN's sport and league in its URLs, as `football/nfl`. */
  readonly path: string
  /** What the scoreboard needs besides a date, as `groups=80&limit=300`; empty for none. */
  readonly scoreboardQuery: string
  readonly topicPrefix: string
}> {
  static readonly followed: ReadonlyArray<EspnLeague> = [
    new EspnLeague({
      league: "nfl",
      path: "football/nfl",
      scoreboardQuery: "",
      topicPrefix: "gp-football-nfl-"
    }),
    new EspnLeague({
      league: "fbs",
      path: "football/college-football",
      scoreboardQuery: "groups=80&limit=300",
      topicPrefix: "gp-football-college-football-"
    })
  ]

  /** League `league`, when ESPN serves it to the Hub. */
  static of(league: LeagueId): Option.Option<EspnLeague> {
    return Arr.findFirst(EspnLeague.followed, (each) => each.league === league)
  }

  /** The league and game of FastCast topic `tc`, when it is a followed league's game topic naming a game. */
  static ofTopic(tc: string): Option.Option<{ readonly league: EspnLeague; readonly game: GameId }> {
    return Arr.findFirst(EspnLeague.followed, (league) =>
      tc.startsWith(league.topicPrefix) && tc.length > league.topicPrefix.length
        ? Option.some({ league, game: GameId.make(tc.slice(league.topicPrefix.length)) })
        : Option.none()
    )
  }

  /** The site scoreboard: today's games (every FBS game of the week for college), or day `date`'s (`YYYY-MM-DD`). */
  scoreboardUrl(date: Option.Option<string>): string {
    const query = [
      ...(this.scoreboardQuery === "" ? [] : [this.scoreboardQuery]),
      ...Option.toArray(Option.map(date, (day) => `dates=${day.replaceAll("-", "")}`))
    ].join("&")
    return `${base}/${this.path}/scoreboard${query === "" ? "" : `?${query}`}`
  }

  /** The game summary of `game`, which carries its plays. */
  summaryUrl(game: GameId): string {
    return `${base}/${this.path}/summary?event=${game}`
  }

  /** FastCast's game topic of `game`. */
  topicOf(game: GameId): string {
    return `${this.topicPrefix}${game}`
  }
}

const base = "https://site.api.espn.com/apis/site/v2/sports"
