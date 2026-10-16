import { Option, Order, Schema } from "effect"
import { TeamId } from "./Team.ts"

/** Live football state: the team with the ball, the down and distance, where the ball is, and each side's timeouts. */
export class FootballSituation extends Schema.TaggedClass<FootballSituation>()("Football", {
  possession: Schema.optional(TeamId),
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  /** Yards to the goal the team with the ball attacks; absent when no team has the ball. */
  yardLine: Schema.optional(Schema.Int),
  homeTimeouts: Schema.Int,
  awayTimeouts: Schema.Int
}) {
  /** The ball is at the opponent's 20 or closer. */
  inRedZone(): boolean {
    return this.yardLine !== undefined && this.yardLine <= redZone
  }

  /** The line to gain is the goal line. */
  goalToGo(): boolean {
    return this.yardLine !== undefined && this.distance !== undefined && this.distance >= this.yardLine
  }

  /** Where the ball is in `game`: the spot of the team with the ball, at its yard line. */
  ball(game: {
    readonly home: { readonly team: { readonly id: TeamId } }
    readonly away: { readonly team: { readonly id: TeamId } }
  }): Option.Option<BallSpot> {
    return BallSpot.of(game, { team: this.possession, yardsToEndzone: this.yardLine })
  }
}

/** Live baseball state: the half inning, the outs, the count, and the runners on base. */
export class BaseballSituation extends Schema.TaggedClass<BaseballSituation>()("Baseball", {
  half: Schema.Literals(["top", "bottom"]),
  outs: Schema.Int,
  balls: Schema.Int,
  strikes: Schema.Int,
  onFirst: Schema.Boolean,
  onSecond: Schema.Boolean,
  onThird: Schema.Boolean
}) {}

const cases = Schema.Union([FootballSituation, BaseballSituation]).pipe(Schema.toTaggedUnion("_tag"))

/**
 * A live game's state, by its sport: a tagged union of its cases with `.match`, `.guards`, `.cases`, and `order`.
 * Basketball has no case until its provider sends something worth showing.
 */
export const Situation = Object.assign(cases, {
  /**
   * Later within the same period and clock: in baseball the bottom half after the top, then more outs. Any other
   * pair ties, and so does a missing situation.
   */
  order: Order.combine(
    Order.mapInput(Order.Number, (situation: typeof cases.Type | undefined) =>
      baseballOf(situation)?.half === "bottom" ? 1 : 0
    ),
    Order.mapInput(
      Order.Number,
      (situation: typeof cases.Type | undefined) => baseballOf(situation)?.outs ?? 0
    )
  )
})
export type Situation = typeof cases.Type

/** Where a spot is on the field: yards from the home goal line (0–100), and the way its team is going. */
export class BallSpot extends Schema.Class<BallSpot>("sportal/BallSpot")({
  yards: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  toward: Schema.Literals(["home", "away"])
}) {
  /**
   * Where a spot is in `game`, from the team with the ball and the yards it has to the goal it attacks. None when
   * either is missing, the team plays in neither side, or the yards are off the field.
   */
  static of(
    game: {
      readonly home: { readonly team: { readonly id: TeamId } }
      readonly away: { readonly team: { readonly id: TeamId } }
    },
    spot: { readonly team?: TeamId | undefined; readonly yardsToEndzone?: number | undefined }
  ): Option.Option<BallSpot> {
    const { team, yardsToEndzone } = spot
    if (team === undefined || yardsToEndzone === undefined) return Option.none()
    if (team === game.home.team.id)
      return BallSpot.makeOption({ yards: 100 - yardsToEndzone, toward: "away" })
    if (team === game.away.team.id) return BallSpot.makeOption({ yards: yardsToEndzone, toward: "home" })
    return Option.none()
  }
}

/** Yards to the goal at which a drive is in the red zone. */
const redZone = 20

function baseballOf(situation: typeof cases.Type | undefined): BaseballSituation | undefined {
  return situation !== undefined && cases.guards.Baseball(situation) ? situation : undefined
}
