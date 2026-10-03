import { Schema } from "effect"

export const LeagueId = Schema.Literals(["nfl", "fbs"])
export type LeagueId = typeof LeagueId.Type
