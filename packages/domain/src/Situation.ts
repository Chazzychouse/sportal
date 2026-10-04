import { Schema } from "effect"
import { TeamId } from "./Team.ts"

export class Situation extends Schema.Class<Situation>("sportal/Situation")({
  possession: Schema.optional(TeamId),
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  /** Yards to the goal the team with the ball attacks; absent when no team has the ball. */
  yardLine: Schema.optional(Schema.Int),
  isRedZone: Schema.Boolean,
  homeTimeouts: Schema.Int,
  awayTimeouts: Schema.Int,
  lastPlay: Schema.optional(Schema.String)
}) {
  /** The ball is at the opponent's 40 or closer: about field-goal range, where a drive starts to matter. */
  inScoringRange(): boolean {
    return this.yardLine !== undefined && this.yardLine <= scoringRange
  }

  /** The line to gain is the goal line. */
  goalToGo(): boolean {
    return this.yardLine !== undefined && this.distance !== undefined && this.distance >= this.yardLine
  }
}

/** Yards to the goal at which a drive is in scoring range. */
const scoringRange = 40
