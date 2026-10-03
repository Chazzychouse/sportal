import { Schema } from "effect"

export const TeamId = Schema.String.pipe(Schema.brand("TeamId"))
export type TeamId = typeof TeamId.Type

export class Team extends Schema.Class<Team>("sportal/Team")({
  id: TeamId,
  abbreviation: Schema.String,
  name: Schema.String,
  logo: Schema.optional(Schema.String)
}) {}
