import { DateTime, Duration, Equal, Option, Order, Schema } from "effect"
import { LeagueId } from "./League.ts"
import { Play } from "./Play.ts"
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
  /**
   * How long before its kickoff an upcoming game counts with the live ones: the slate holds it as current, FastCast
   * follows its topic, and ESPN's scoreboard is polled every minute.
   */
  static readonly kickoffWindow = Duration.minutes(30)

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
  progress(): Progress {
    return progressOf[this.status](this.period)
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

  /**
   * Behind `had`, a snapshot of the same game: earlier in game time, or at the same game time with fewer points (a
   * listing lagging an earlier one), unless `had` is over and this is ahead of its end (overtime after a spurious
   * final, a postponed game resuming).
   */
  isBehind(had: GameSnapshot): boolean {
    const resumed = had.progress() === "over" && this.isAheadOfOver(had)
    return had.isAheadOf(this) && !this.isAheadOf(had) && !resumed
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

  /** "<away abbreviation> at <home abbreviation>", for a title or a log line. */
  matchup(): string {
    return `${this.away.team.abbreviation} at ${this.home.team.abbreviation}`
  }

  /**
   * This game moved on to `moved`'s status, period, clock, scores, and situation (none when it has none), keeping its
   * own teams, rankings, kickoff, and broadcasts.
   */
  advancedTo(moved: {
    readonly status: GameStatus
    readonly period: number
    readonly clock: string
    readonly homeScore: number
    readonly awayScore: number
    readonly situation?: Situation | undefined
  }): GameSnapshot {
    return new GameSnapshot({
      id: this.id,
      league: this.league,
      kickoff: this.kickoff,
      broadcasts: this.broadcasts,
      status: moved.status,
      period: moved.period,
      clock: moved.clock,
      home: { ...this.home, score: moved.homeScore },
      away: { ...this.away, score: moved.awayScore },
      ...(moved.situation === undefined ? {} : { situation: moved.situation })
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
}

/** A game as the slate has it: its latest snapshot, and its plays in `Play.order`. */
export class Game extends Schema.Class<Game>("sportal/Game")({
  snapshot: GameSnapshot,
  plays: Schema.Array(Play)
}) {
  /** How many of its plays `recent` keeps. */
  private static readonly recentCount = 10

  /** A game first seen as `snapshot`, with no plays yet. */
  static of(snapshot: GameSnapshot): Game {
    return new Game({ snapshot, plays: [] })
  }

  /** This game with `snapshot` taken, unless it equals this game's or is behind it: then this game itself. */
  snapshotTaken(snapshot: GameSnapshot): Game {
    if (Equal.equals(this.snapshot, snapshot) || snapshot.isBehind(this.snapshot)) return this

    return new Game({ ...this, snapshot })
  }

  /** This game with its whole list of plays replaced, in `Play.order`; this game itself when nothing changed. */
  playsTaken(plays: ReadonlyArray<Play>): Game {
    const sorted = plays.toSorted(Play.order)
    if (Equal.equals(sorted, this.plays)) return this

    return new Game({ ...this, plays: sorted })
  }

  /** The plays this game has that `earlier` lacks, by id, in this game's order. */
  playsAfter(earlier: Game): ReadonlyArray<Play> {
    const had = new Set(earlier.plays.map(({ id }) => id))
    return this.plays.filter(({ id }) => !had.has(id))
  }

  /** This game with only its last ten plays: what the live stream sends. */
  recent(): Game {
    if (this.plays.length <= Game.recentCount) return this

    return new Game({ ...this, plays: this.plays.slice(-Game.recentCount) })
  }
}

/** Where a spot is on the field: yards from the home goal line (0–100), and the way its team is going. */
export class BallSpot extends Schema.Class<BallSpot>("sportal/BallSpot")({
  yards: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  toward: Schema.Literals(["home", "away"])
}) {}

/** Where a game is in its day. */
export type Progress = "upcoming" | "live" | "over"

/** Each status's progress, given the period it is in. */
const progressOf: Record<GameStatus, (period: number) => Progress> = {
  scheduled: () => "upcoming",
  delayed: (period) => (period >= 1 ? "live" : "upcoming"),
  live: () => "live",
  halftime: () => "live",
  final: () => "over",
  postponed: () => "over",
  canceled: () => "over"
}

const watchRank = { live: 0, upcoming: 1, over: 2 } as const

const gameTimeRank = { upcoming: 0, live: 1, over: 2 } as const

/** Seconds in a quarter, college and NFL alike. */
const quarterSeconds = 15 * 60
