import { DateTime, Order, Schema } from "effect"
import { GameEvent } from "./GameEvent.ts"
import { LeagueId } from "./League.ts"
import { Situation } from "./Situation.ts"
import { Team } from "./Team.ts"

export const GameId = Schema.String.pipe(Schema.brand("GameId"))
export type GameId = typeof GameId.Type

export const GameStatus = Schema.Literals([
  "scheduled",
  "live",
  "halftime",
  "delayed",
  "final",
  "postponed",
  "canceled"
])
export type GameStatus = typeof GameStatus.Type

/** A network's name as the provider reports it ("CBS", "ESPN"). */
export const Network = Schema.String.pipe(Schema.brand("Network"))
export type Network = typeof Network.Type

/** The fact that a network is airing a game, on television or streaming only. */
export const Broadcast = Schema.Struct({ network: Network, medium: Schema.Literals(["tv", "streaming"]) })
export type Broadcast = typeof Broadcast.Type

const Side = Schema.Struct({ team: Team, score: Schema.Int, ranking: Schema.optional(Schema.Int) })

export class GameSnapshot extends Schema.Class<GameSnapshot>("sportal/GameSnapshot")({
  id: GameId,
  league: LeagueId,
  kickoff: Schema.DateTimeUtcFromString,
  status: GameStatus,
  period: Schema.Int,
  clock: Schema.String,
  home: Side,
  away: Side,
  broadcasts: Schema.Array(Broadcast),
  situation: Schema.optional(Situation)
}) {
  /** Live games first, then upcoming by kickoff, then everything that is over. */
  static readonly watchOrder: Order.Order<GameSnapshot> = Order.combine(
    Order.mapInput(Order.Number, (game: GameSnapshot) => watchRank[game.progress()]),
    Order.mapInput(DateTime.Order, (game: GameSnapshot) => game.kickoff)
  )

  /**
   * How far a game has got: before kickoff, in play, or over; then the period; then less time left on the clock.
   * Orders two snapshots of one game.
   */
  static readonly gameTime: Order.Order<GameSnapshot> = Order.combine(
    Order.mapInput(Order.Number, (game: GameSnapshot) => gameTimeRank[game.progress()]),
    Order.combine(
      Order.mapInput(Order.Number, (game: GameSnapshot) => game.period),
      Order.mapInput(Order.flip(Order.Number), (game: GameSnapshot) => game.secondsLeft())
    )
  )

  /**
   * Where the game is in its day: not started, being played, or done with (final, postponed, canceled). A delay
   * before kickoff is upcoming and a delay during the game is live.
   */
  progress(): "upcoming" | "live" | "over" {
    switch (this.status) {
      case "scheduled":
        return "upcoming"
      case "delayed":
        return this.period >= 1 ? "live" : "upcoming"
      case "live":
      case "halftime":
        return "live"
      case "final":
      case "postponed":
      case "canceled":
        return "over"
    }
  }

  /** "<away abbreviation> at <home abbreviation>", for a title or a log line. */
  matchup(): string {
    return `${this.away.team.abbreviation} at ${this.home.team.abbreviation}`
  }

  /** Seconds left in the period, from the clock ("2:10"). An unreadable clock reads as a full quarter. */
  secondsLeft(): number {
    const [minutes, seconds] = this.clock.split(":").map((part) => Number.parseInt(part, 10))
    const total = (minutes ?? Number.NaN) * 60 + (seconds ?? 0)
    return Number.isFinite(total) ? total : quarterSeconds
  }

  /** The share of the period left on the clock, 0–1. */
  quarterLeft(): number {
    return this.secondsLeft() / quarterSeconds
  }

  /**
   * Whether the period runs on a game clock, so 0:00 means it is over. A college overtime has no clock: ESPN shows
   * it as 0:00 throughout. An NFL overtime has one.
   */
  timed(): boolean {
    return !(this.league === "fbs" && this.period >= 5)
  }

  /** Live in the last two minutes of the first or second half, with time still on the clock. */
  inTwoMinuteDrill(): boolean {
    const left = this.secondsLeft()
    return this.status === "live" && (this.period === 2 || this.period === 4) && left > 0 && left <= 120
  }

  /**
   * What happened in this game since `previous`, an earlier snapshot of it: points, the ball changing hands, a
   * drive reaching the 40, the red zone, goal to go, or fourth down, a timeout, and the clock and status. A change
   * of possession is a turnover only when the last play names an interception or a fumble and nobody scored.
   */
  eventsSince(previous: GameSnapshot): ReadonlyArray<GameEvent> {
    const events: Array<GameEvent> = []
    for (const side of ["home", "away"] as const) {
      const points = this[side].score - previous[side].score
      if (points > 0) events.push(GameEvent.ScoreChanged({ team: this[side].team.id, points }))
    }
    const scored = events.length > 0
    const before = previous.situation
    const after = this.situation
    const team = after?.possession
    if (team !== undefined && before?.possession !== undefined && team !== before.possession)
      events.push(
        !scored && /intercept|fumble/i.test(after?.lastPlay ?? "")
          ? GameEvent.Turnover({ team })
          : GameEvent.PossessionChanged({ team })
      )
    if (team !== undefined && after !== undefined) {
      // Only a change on the same team's drive is news, except that a new drive starting inside the 40 (a turnover
      // on a short field) is reported: a short field is what the Director should anticipate.
      const already = (test: (situation: Situation) => boolean) =>
        before !== undefined && before.possession === team && test(before)
      if (after.inScoringRange() && !already((s) => s.inScoringRange()))
        events.push(GameEvent.ReachedScoringRange({ team }))
      if (after.isRedZone && !already((s) => s.isRedZone)) events.push(GameEvent.EnteredRedZone({ team }))
      if (after.goalToGo() && !already((s) => s.goalToGo())) events.push(GameEvent.GoalToGo({ team }))
      if (after.down === 4 && !already((s) => s.down === 4 && s.yardLine === after.yardLine))
        events.push(GameEvent.FourthDown({ team }))
    }
    if (before !== undefined && after !== undefined) {
      // One fewer in the same period only: a new period resets counts, and a poll without counts reads as zero.
      const tookOne = (was: number, now: number) => this.period === previous.period && was - now === 1
      if (tookOne(before.homeTimeouts, after.homeTimeouts))
        events.push(GameEvent.TimeoutTaken({ team: this.home.team.id }))
      if (tookOne(before.awayTimeouts, after.awayTimeouts))
        events.push(GameEvent.TimeoutTaken({ team: this.away.team.id }))
    }
    if (this.inTwoMinuteDrill() && !previous.inTwoMinuteDrill()) events.push(GameEvent.TwoMinuteDrill())
    if (this.period >= 5 && previous.period < 5) events.push(GameEvent.Overtime())
    if (this.period > previous.period && previous.period >= 1)
      events.push(GameEvent.PeriodEnded({ period: previous.period }))
    if (this.status === "halftime" && previous.status !== "halftime") events.push(GameEvent.WentToHalftime())
    if (this.status === "final" && previous.status !== "final") events.push(GameEvent.WentFinal())
    return events
  }
}

const watchRank = { live: 0, upcoming: 1, over: 2 } as const

const gameTimeRank = { upcoming: 0, live: 1, over: 2 } as const

/** Seconds in a quarter, college and NFL alike. */
const quarterSeconds = 15 * 60
