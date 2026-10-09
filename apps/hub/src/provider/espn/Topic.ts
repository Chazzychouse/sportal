import { GameId } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Array as Arr, Data, Option } from "effect"

/** What a FastCast topic carries: one league's scoreboard, or one game's package. */
export type Topic = Data.TaggedEnum<{
  Scoreboard: { readonly league: LeagueId }
  Game: { readonly league: LeagueId; readonly game: GameId }
}>
export const Topic = Data.taggedEnum<Topic>()

/**
 * `topic` as FastCast's `tc` names it. A college game's topic is assumed to follow its scoreboard's, unverified until a
 * live college day.
 */
export function tcOf(topic: Topic): string {
  const sport = topic.league === "nfl" ? "football-nfl" : "football-college-football"
  return Topic.$match(topic, {
    Scoreboard: () => `event-${sport}`,
    Game: ({ game }) => `gp-${sport}-${game}`
  })
}

/** The topic FastCast's `tc` names, when it is a scoreboard's or a game's. */
export function topicOf(tc: string): Option.Option<Topic> {
  return Arr.findFirst(LeagueId.literals, (league) => {
    const gamePrefix = tcOf(Topic.Game({ league, game: GameId.make("") }))
    return tc === tcOf(Topic.Scoreboard({ league }))
      ? Option.some(Topic.Scoreboard({ league }))
      : tc.startsWith(gamePrefix) && tc.length > gamePrefix.length
        ? Option.some(Topic.Game({ league, game: GameId.make(tc.slice(gamePrefix.length)) }))
        : Option.none()
  })
}
