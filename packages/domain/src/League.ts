import { Data, Schema } from "effect"

/** A league as Sportal knows it: its id, the sport it plays, and its name as people say it. */
export class League extends Data.Class<{
  readonly id: LeagueId
  readonly sport: Sport
  readonly name: string
}> {
  /** League `id`. */
  static of(id: LeagueId): League {
    return leagues[id]
  }
}

export const LeagueId = Schema.Literals(["nfl", "fbs", "mlb", "nba"])
export type LeagueId = typeof LeagueId.Type

/** The sport a league plays: it says which situation and play detail its games carry. */
export const Sport = Schema.Literals(["football", "baseball", "basketball"])
export type Sport = typeof Sport.Type

const leagues: { readonly [L in LeagueId]: League } = {
  nfl: new League({ id: "nfl", sport: "football", name: "NFL" }),
  fbs: new League({ id: "fbs", sport: "football", name: "College Football" }),
  mlb: new League({ id: "mlb", sport: "baseball", name: "MLB" }),
  nba: new League({ id: "nba", sport: "basketball", name: "NBA" })
}
