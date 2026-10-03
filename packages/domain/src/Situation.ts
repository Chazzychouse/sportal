import { Schema } from "effect"
import { TeamId } from "./Team.ts"

export class Situation extends Schema.Class<Situation>("sportal/Situation")({
  possession: Schema.optional(TeamId),
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  yardLine: Schema.optional(Schema.Int),
  isRedZone: Schema.Boolean,
  homeTimeouts: Schema.Int,
  awayTimeouts: Schema.Int,
  lastPlay: Schema.optional(Schema.String)
}) {}
