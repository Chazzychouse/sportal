import { Schema } from "effect"

export const TeamId = Schema.String.pipe(Schema.brand("TeamId"))
export type TeamId = typeof TeamId.Type

export class Team extends Schema.Class<Team>("sportal/Team")({
  id: TeamId,
  abbreviation: Schema.String,
  name: Schema.String,
  /** Where the team is from, as its league names it ("Ohio State", "New England"). */
  location: Schema.String,
  /** The team's short name ("Patriots", or for some colleges the place: "Charlotte"). */
  shortName: Schema.String,
  logo: Schema.optional(Schema.String)
}) {}
