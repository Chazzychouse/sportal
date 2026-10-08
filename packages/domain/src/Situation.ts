import { Schema } from "effect"
import { TeamId } from "./Team.ts"

export class Situation extends Schema.Class<Situation>("sportal/Situation")({
  possession: Schema.optional(TeamId),
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  /** Yards to the goal the team with the ball attacks; absent when no team has the ball. */
  yardLine: Schema.optional(Schema.Int),
  homeTimeouts: Schema.Int,
  awayTimeouts: Schema.Int,
  lastPlay: Schema.optional(Schema.String)
}) {
  /** The ball is at the opponent's 20 or closer. */
  inRedZone(): boolean {
    return this.yardLine !== undefined && this.yardLine <= redZone
  }

  /** The line to gain is the goal line. */
  goalToGo(): boolean {
    return this.yardLine !== undefined && this.distance !== undefined && this.distance >= this.yardLine
  }
}

/** Yards to the goal at which a drive is in the red zone. */
const redZone = 20
