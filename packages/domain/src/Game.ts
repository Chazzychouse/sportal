import { DateTime, type Duration, Option, Order, Schema } from "effect"
import { GameEventKind } from "./GameEvent.ts"
import { LeagueId } from "./League.ts"
import { Situation } from "./Situation.ts"
import { Team, type TeamId } from "./Team.ts"

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

  /** The period, then less time left on the clock, whatever the status. */
  private static readonly clockTime: Order.Order<GameSnapshot> = Order.combine(
    Order.mapInput(Order.Number, (game: GameSnapshot) => game.period),
    Order.mapInput(Order.flip(Order.Number), (game: GameSnapshot) => game.secondsLeft())
  )

  /**
   * How far a game has got: before kickoff, in play, or over; then the period; then less time left on the clock; then,
   * at the same clock, halftime after play. Any other statuses at the same clock tie. Orders two snapshots of one game.
   */
  static readonly gameTime: Order.Order<GameSnapshot> = Order.combine(
    Order.mapInput(Order.Number, (game: GameSnapshot) => gameTimeRank[game.progress()]),
    Order.combine(
      GameSnapshot.clockTime,
      Order.mapInput(Order.Number, (game: GameSnapshot) => (game.status === "halftime" ? 1 : 0))
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

  /** Whether the game is live at `now`, or upcoming with its kickoff no later than `window` after `now`. */
  isLiveOrKicksOffWithin(window: Duration.Duration, now: DateTime.Utc): boolean {
    const progress = this.progress()
    return (
      progress === "live" ||
      (progress === "upcoming" &&
        DateTime.isLessThanOrEqualTo(this.kickoff, DateTime.addDuration(now, window)))
    )
  }

  /**
   * Later in game time, or at the same game time with more points, or with as many points split differently. The clock
   * stops on a score, so at the same game time only the points say which is newer.
   */
  isAheadOf(that: GameSnapshot): boolean {
    const order = GameSnapshot.gameTime(this, that)
    if (order !== 0) return order > 0
    const points = this.points() - that.points()
    if (points !== 0) return points > 0
    return this.home.score !== that.home.score
  }

  /**
   * Ahead of `over`, a snapshot of this game once it was over (a final, a postponement): later in the period or on the
   * clock whatever either's status, or at the same clock with more points. So overtime after a spurious final, or a
   * postponed game resuming, is ahead, and a poll lagging the end of the game is not.
   */
  isAheadOfOver(over: GameSnapshot): boolean {
    const order = GameSnapshot.clockTime(this, over)
    return order !== 0 ? order > 0 : this.points() > over.points()
  }

  /** Both teams' points together. */
  private points(): number {
    return this.home.score + this.away.score
  }

  /** The points between the teams. */
  margin(): number {
    return Math.abs(this.home.score - this.away.score)
  }

  /** Whether the game is in overtime, the fifth period or later. */
  inOvertime(): boolean {
    return this.period >= 5
  }

  /** Whether the game has a score worth showing: it is being played or is final. */
  scored(): boolean {
    return this.progress() === "live" || this.status === "final"
  }

  /** The broadcast networks, joined with " · ". */
  networks(): string {
    return this.broadcasts.map(({ network }) => network).join(" · ")
  }

  /** The status, period, and clock as one line, for a log. */
  statusLine(): string {
    return `${this.status}, period ${this.period}, ${this.clock}`
  }

  /** A team's abbreviation, or its id when it plays in neither side. */
  abbreviationOf(id: TeamId): string {
    return [this.home.team, this.away.team].find((team) => team.id === id)?.abbreviation ?? id
  }

  /** "<away abbreviation> at <home abbreviation>", for a title or a log line. */
  matchup(): string {
    return `${this.away.team.abbreviation} at ${this.home.team.abbreviation}`
  }

  /**
   * This game moved on to `later`'s status, period, clock, scores, and situation, keeping its own teams, rankings,
   * kickoff, and broadcasts.
   */
  advancedTo(later: GameSnapshot): GameSnapshot {
    return new GameSnapshot({
      ...later,
      id: this.id,
      league: this.league,
      kickoff: this.kickoff,
      broadcasts: this.broadcasts,
      home: { ...this.home, score: later.home.score },
      away: { ...this.away, score: later.away.score }
    })
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
    return !(this.league === "fbs" && this.inOvertime())
  }

  /** Live in the last two minutes of the first or second half, with time still on the clock. */
  inTwoMinuteDrill(): boolean {
    const left = this.secondsLeft()
    return this.status === "live" && (this.period === 2 || this.period === 4) && left > 0 && left <= 120
  }

  /**
   * Where a spot is on the field, from the team with the ball and the yards it has to the goal it attacks. None
   * when either is missing, the team plays in neither side, or the yards are off the field.
   */
  spotOf(spot: {
    readonly team?: TeamId | undefined
    readonly yardsToEndzone?: number | undefined
  }): Option.Option<BallSpot> {
    const { team, yardsToEndzone } = spot
    if (team === undefined || yardsToEndzone === undefined) return Option.none()
    if (team === this.home.team.id)
      return BallSpot.makeOption({ yards: 100 - yardsToEndzone, toward: "away" })
    if (team === this.away.team.id) return BallSpot.makeOption({ yards: yardsToEndzone, toward: "home" })
    return Option.none()
  }

  /**
   * Whether the game is being played right now: live, with time left on a timed period's clock. Halftime, the break
   * between periods, and everything before kickoff or after the final are not.
   */
  inPlay(): boolean {
    return this.status === "live" && !(this.timed() && this.secondsLeft() === 0)
  }

  /** Where the ball is: the spot of the situation's team with the ball, at its yard line. */
  ball(): Option.Option<BallSpot> {
    return this.spotOf({ team: this.situation?.possession, yardsToEndzone: this.situation?.yardLine })
  }

  /**
   * What happened in this game since `previous`, an earlier snapshot of it: points, the ball changing hands, a
   * drive reaching the 40, the red zone, goal to go, or fourth down, a timeout, and the clock and status. A change
   * of possession is a turnover only when the last play names an interception or a fumble and nobody scored.
   */
  eventsSince(previous: GameSnapshot): ReadonlyArray<GameEventKind> {
    return [
      this.scoreEventsSince(previous),
      this.possessionEventsSince(previous),
      this.driveEventsSince(previous),
      this.timeoutEventsSince(previous),
      this.clockEventsSince(previous)
    ].flat()
  }

  private scoreEventsSince(previous: GameSnapshot): ReadonlyArray<GameEventKind> {
    return (["home", "away"] as const).flatMap((side) => {
      const points = this[side].score - previous[side].score
      return points > 0 ? [GameEventKind.ScoreChanged({ team: this[side].team.id, points })] : []
    })
  }

  private possessionEventsSince(previous: GameSnapshot): ReadonlyArray<GameEventKind> {
    const team = this.situation?.possession
    const before = previous.situation?.possession
    if (team === undefined || before === undefined || team === before) return []

    const scored = this.scoreEventsSince(previous).length > 0
    const turnedOver = !scored && /intercept|fumble/i.test(this.situation?.lastPlay ?? "")
    return [turnedOver ? GameEventKind.Turnover({ team }) : GameEventKind.PossessionChanged({ team })]
  }

  private driveEventsSince(previous: GameSnapshot): ReadonlyArray<GameEventKind> {
    const before = previous.situation
    const after = this.situation
    const team = after?.possession
    if (team === undefined || after === undefined) return []

    // Only a change on the same team's drive is news, except that a new drive starting inside the 40 (a turnover
    // on a short field) is reported: a short field is what the Director should anticipate.
    const already = (test: (situation: Situation) => boolean) =>
      before !== undefined && before.possession === team && test(before)

    return [
      ...(after.inScoringRange() && !already((s) => s.inScoringRange())
        ? [GameEventKind.ReachedScoringRange({ team })]
        : []),
      ...(after.inRedZone() && !already((s) => s.inRedZone())
        ? [GameEventKind.EnteredRedZone({ team })]
        : []),
      ...(after.goalToGo() && !already((s) => s.goalToGo()) ? [GameEventKind.GoalToGo({ team })] : []),
      ...(after.down === 4 && !already((s) => s.down === 4 && s.yardLine === after.yardLine)
        ? [GameEventKind.FourthDown({ team })]
        : [])
    ]
  }

  private timeoutEventsSince(previous: GameSnapshot): ReadonlyArray<GameEventKind> {
    const before = previous.situation
    const after = this.situation
    if (before === undefined || after === undefined) return []

    // One fewer in the same period only: a new period resets counts, and a poll without counts reads as zero.
    const tookOne = (was: number, now: number) => this.period === previous.period && was - now === 1

    return [
      ...(tookOne(before.homeTimeouts, after.homeTimeouts)
        ? [GameEventKind.TimeoutTaken({ team: this.home.team.id })]
        : []),
      ...(tookOne(before.awayTimeouts, after.awayTimeouts)
        ? [GameEventKind.TimeoutTaken({ team: this.away.team.id })]
        : [])
    ]
  }

  private clockEventsSince(previous: GameSnapshot): ReadonlyArray<GameEventKind> {
    return [
      this.inTwoMinuteDrill() && !previous.inTwoMinuteDrill() ? [GameEventKind.TwoMinuteDrill()] : [],
      this.inOvertime() && !previous.inOvertime() ? [GameEventKind.Overtime()] : [],
      this.period > previous.period && previous.period >= 1
        ? [GameEventKind.PeriodEnded({ period: previous.period })]
        : [],
      this.status === "halftime" && previous.status !== "halftime" ? [GameEventKind.WentToHalftime()] : [],
      this.status === "final" && previous.status !== "final" ? [GameEventKind.WentFinal()] : []
    ].flat()
  }
}

/** Where a spot is on the field: yards from the home goal line (0–100), and the way its team is going. */
export class BallSpot extends Schema.Class<BallSpot>("sportal/BallSpot")({
  yards: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  toward: Schema.Literals(["home", "away"])
}) {}

const watchRank = { live: 0, upcoming: 1, over: 2 } as const

const gameTimeRank = { upcoming: 0, live: 1, over: 2 } as const

/** Seconds in a quarter, college and NFL alike. */
const quarterSeconds = 15 * 60
