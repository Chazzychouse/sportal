import { GameId } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Array as Arr, Data, Option } from "effect"

/** What a FastCast topic carries: one league's scoreboard, or one game's package. */
export type Owner = Data.TaggedEnum<{
  Scoreboard: { readonly league: LeagueId }
  Game: { readonly league: LeagueId; readonly game: GameId }
}>
export const Owner = Data.taggedEnum<Owner>()

/**
 * The FastCast topic of `league`'s scoreboard, or of one game's package: with `ownerOf`, an operation of `Owner`, a
 * function beside it because a `Data.taggedEnum` carries no statics. A college game's topic is assumed to follow its
 * scoreboard's, unverified until a live college day.
 */
export function topicOf(league: LeagueId, game?: GameId): string {
  const sport = league === "nfl" ? "football-nfl" : "football-college-football"
  return game === undefined ? `event-${sport}` : `gp-${sport}-${game}`
}

/**
 * What the FastCast topic `tc` carries, when it is a scoreboard's or a game's topic: with `topicOf`, an operation of
 * `Owner`, a function beside it because a `Data.taggedEnum` carries no statics.
 */
export function ownerOf(tc: string): Option.Option<Owner> {
  return Arr.findFirst(LeagueId.literals, (league) => {
    const gamePrefix = topicOf(league, GameId.make(""))
    return tc === topicOf(league)
      ? Option.some(Owner.Scoreboard({ league }))
      : tc.startsWith(gamePrefix) && tc.length > gamePrefix.length
        ? Option.some(Owner.Game({ league, game: GameId.make(tc.slice(gamePrefix.length)) }))
        : Option.none()
  })
}
