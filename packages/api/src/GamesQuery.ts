import { ChannelAvailability } from "@sportal/domain/Channel"
import { GameSnapshot, Progress } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Order, Schema, SchemaGetter } from "effect"
import { ListedGame } from "./ListedGame.ts"

/** A calendar day as `YYYY-MM-DD`. */
export const CalendarDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).pipe(
  Schema.brand("CalendarDate")
)
export type CalendarDate = typeof CalendarDate.Type

/** A day's games, as a query answers them: the day, and its games filtered and in watch order. */
export const GameList = Schema.Struct({ date: CalendarDate, games: Schema.Array(ListedGame) })
export type GameList = typeof GameList.Type

export const GameListJson = Schema.fromJsonString(GameList)

/**
 * What a list of games asks for, as its query string spells it: a day (today in the Hub's time zone without one),
 * leagues and progress as comma lists (all without them), and `carried=true` for only the games a source carries or
 * will carry. With `answer`, which filters and orders.
 */
export const GamesQuery = Object.assign(
  Schema.Struct({
    date: Schema.optional(CalendarDate),
    league: Schema.optional(commaList(LeagueId)),
    progress: Schema.optional(commaList(Progress)),
    carried: Schema.optional(Schema.Literal("true"))
  }),
  { answer }
)
export type GamesQuery = typeof GamesQuery.Type

/** `games` that `query` keeps (all but its day, which picks the games before this), live first, then upcoming, then over. */
function answer(
  query: Omit<GamesQuery, "date">,
  games: ReadonlyArray<ListedGame>
): ReadonlyArray<ListedGame> {
  return games
    .filter(
      ({ snapshot, availability }) =>
        (query.league === undefined || query.league.includes(snapshot.league)) &&
        (query.progress === undefined || query.progress.includes(snapshot.progress())) &&
        (query.carried === undefined || availability.some(carriedOrUpcoming))
    )
    .toSorted(byWatchOrder)
}

/** A comma list in a query string, as `nfl,fbs`, read as the values of `item`. */
function commaList<S extends Schema.Top & { readonly Encoded: string }>(item: S) {
  return Schema.String.pipe(
    Schema.decodeTo(Schema.Array(item), {
      decode: SchemaGetter.transform((list: string) => list.split(",")),
      encode: SchemaGetter.transform((items: ReadonlyArray<string>) => items.join(","))
    })
  )
}

function carriedOrUpcoming(availability: ChannelAvailability): boolean {
  return ChannelAvailability.guards.Carried(availability) || ChannelAvailability.guards.Upcoming(availability)
}

const byWatchOrder = Order.mapInput(GameSnapshot.watchOrder, ({ snapshot }: ListedGame) => snapshot)
