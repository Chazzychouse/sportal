import { DateTime, Duration, Equal, Option, Order, Schema } from "effect"
import { LeagueId } from "./League.ts"
import { Play } from "./Play.ts"
import { Situation } from "./Situation.ts"
import { Team } from "./Team.ts"

export const GameId = Schema.String.pipe(Schema.brand("GameId"))
export type GameId = typeof GameId.Type

export const GameStatus = Schema.Literals([
  "scheduled",
  "live",
  "break",
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

/** A team's wins and losses this season, as the scoreboard gives them; ties are left out. */
export const TeamRecord = Schema.Struct({ wins: Schema.Int, losses: Schema.Int })
export type TeamRecord = typeof TeamRecord.Type

/**
 * The pregame betting line: the side favored, if either, by how many points (`spread`, never negative), and the
 * total points expected. The scoreboard sends it only before the start.
 */
export const Odds = Schema.Struct({
  favorite: Schema.optional(Schema.Literals(["home", "away"])),
  spread: Schema.Finite,
  overUnder: Schema.optional(Schema.Finite)
})
export type Odds = typeof Odds.Type

const Side = Schema.Struct({
  team: Team,
  score: Schema.Int,
  ranking: Schema.optional(Schema.Int),
  record: Schema.optional(TeamRecord)
})

export class GameSnapshot extends Schema.Class<GameSnapshot>("sportal/GameSnapshot")({
  id: GameId,
  league: LeagueId,
  startsAt: Schema.DateTimeUtcFromString,
  status: GameStatus,
  period: Schema.Int,
  /** Seconds left in the period, when the period runs on a clock: absent in baseball, and in a college overtime, which has none. */
  clock: Schema.optional(Schema.Int),
  /** The provider's short status, shown as it is ("Top 7th", "7:21 - 2nd", "Halftime"). */
  statusText: Schema.String,
  home: Side,
  away: Side,
  broadcasts: Schema.Array(Broadcast),
  situation: Schema.optional(Situation),
  odds: Schema.optional(Odds)
}) {
  /**
   * How long before its start an upcoming game counts with the live ones: the slate holds it as current, FastCast
   * follows its topic, and ESPN's scoreboard is polled every minute.
   */
  static readonly startWindow = Duration.minutes(30)

  /** Live games first, then upcoming by start, then everything that is over. */
  static readonly watchOrder: Order.Order<GameSnapshot> = Order.combine(
    Order.mapInput(Order.Number, (game: GameSnapshot) => watchRank[game.progress()]),
    Order.mapInput(DateTime.Order, (game: GameSnapshot) => game.startsAt)
  )

  /** The period, then less time left on the clock, then the situation's own order, whatever the status. */
  private static readonly clockTime: Order.Order<GameSnapshot> = Order.combine(
    Order.combine(
      Order.mapInput(Order.Number, (game: GameSnapshot) => game.period),
      Order.mapInput(Order.flip(Order.Number), (game: GameSnapshot) => game.clock ?? 0)
    ),
    Order.mapInput(Situation.order, (game: GameSnapshot) => game.situation)
  )

  /**
   * How far a game has got: before the start, in play, or over; then the period; then less time left on the clock; then,
   * at the same clock, a break after play. Any other statuses at the same clock tie. Orders two snapshots of one game.
   */
  private static readonly gameTime: Order.Order<GameSnapshot> = Order.combine(
    Order.mapInput(Order.Number, (game: GameSnapshot) => gameTimeRank[game.progress()]),
    Order.combine(
      GameSnapshot.clockTime,
      Order.mapInput(Order.Number, (game: GameSnapshot) => (game.status === "break" ? 1 : 0))
    )
  )

  /**
   * Where the game is in its day: not started, being played, or done with (final, postponed, canceled). A delay
   * before the start is upcoming and a delay during the game is live.
   */
  progress(): Progress {
    return progressOf[this.status](this.period)
  }

  /** Whether the game is live at `now`, or upcoming with its start no later than `window` after `now`. */
  isLiveOrStartsWithin(window: Duration.Duration, now: DateTime.Utc): boolean {
    const progress = this.progress()
    return (
      progress === "live" ||
      (progress === "upcoming" &&
        DateTime.isLessThanOrEqualTo(this.startsAt, DateTime.addDuration(now, window)))
    )
  }

  /**
   * Later in game time, or at the same game time with more points, or with as many points split differently. The clock
   * stops on a score, so at the same game time only the points say which is newer.
   */
  private isAheadOf(that: GameSnapshot): boolean {
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
  private isAheadOfOver(over: GameSnapshot): boolean {
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

  /** The score as one line of text: "KC 21–14 BUF", or "KC @ BUF" before there is a score. */
  scoreline(): string {
    if (!this.scored()) return `${this.away.team.abbreviation} @ ${this.home.team.abbreviation}`
    return `${this.away.team.abbreviation} ${this.away.score}–${this.home.score} ${this.home.team.abbreviation}`
  }

  /**
   * Whether the game is being played right now: live, with time left on the clock when it has one. A break, and
   * everything before the start or after the final, are not.
   */
  inPlay(): boolean {
    return this.status === "live" && (this.clock === undefined || this.clock > 0)
  }
}

/** A page of a game's plays, newest first, and whether earlier ones remain. */
export const PlaysPage = Schema.Struct({ plays: Schema.Array(Play), more: Schema.Boolean })
export type PlaysPage = typeof PlaysPage.Type

/**
 * What changed in a game's plays: plays added after the last it had, or anything else (a play revised or removed),
 * which replaces the list with its latest page. Each list is newest first.
 */
export const PlaysChange = Schema.TaggedUnion({
  Appended: { plays: Schema.Array(Play) },
  Reset: { plays: Schema.Array(Play) }
})
export type PlaysChange = typeof PlaysChange.Type

/** A game as the slate has it: its latest snapshot, and its plays in `Play.order`. */
export class Game extends Schema.Class<Game>("sportal/Game")({
  snapshot: GameSnapshot,
  plays: Schema.Array(Play)
}) {
  /** How many plays a page holds unless asked for fewer. */
  static readonly pageSize = 50

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

  /** Its plays before sequence `before` (all of them without it), newest first, at most `limit`, and whether more remain. */
  playsPage(before: number | undefined, limit: number): PlaysPage {
    const earlier = before === undefined ? this.plays : this.plays.filter((play) => play.sequence < before)
    return { plays: earlier.slice(-limit).toReversed(), more: earlier.length > limit }
  }

  /**
   * What changed in its plays since `earlier`, the same game before: none when they are the same; the plays added
   * when `earlier`'s are all still first and unchanged; otherwise a reset to its latest page.
   */
  playsChange(earlier: Game): Option.Option<PlaysChange> {
    if (Equal.equals(earlier.plays, this.plays)) return Option.none()

    const kept = this.plays.slice(0, earlier.plays.length)
    if (this.plays.length > earlier.plays.length && Equal.equals(kept, earlier.plays)) {
      return Option.some({ _tag: "Appended", plays: this.plays.slice(earlier.plays.length).toReversed() })
    }
    return Option.some({ _tag: "Reset", plays: this.playsPage(undefined, Game.pageSize).plays })
  }
}

/** Where a game is in its day. */
export const Progress = Schema.Literals(["upcoming", "live", "over"])
export type Progress = typeof Progress.Type

/** Each status's progress, given the period it is in. */
const progressOf: Record<GameStatus, (period: number) => Progress> = {
  scheduled: () => "upcoming",
  delayed: (period) => (period >= 1 ? "live" : "upcoming"),
  live: () => "live",
  break: () => "live",
  final: () => "over",
  postponed: () => "over",
  canceled: () => "over"
}

const watchRank = { live: 0, upcoming: 1, over: 2 } as const

const gameTimeRank = { upcoming: 0, live: 1, over: 2 } as const
