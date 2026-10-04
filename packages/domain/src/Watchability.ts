import { DateTime, Duration, Schema } from "effect"
import { GameId, type GameSnapshot } from "./Game.ts"

/**
 * How worth watching a game is right now, 0–100, whether it is in a lull, and why — with what it remembers to tell
 * a lull: when play last showed, and how long a break or a boost lasts. Folded forward one snapshot at a time.
 */
export class Watchability extends Schema.Class<Watchability>("sportal/Watchability")({
  game: GameId,
  score: Schema.Int,
  lull: Schema.Boolean,
  /** Short reasons for the score, the largest part first. */
  reasons: Schema.Array(Schema.String),
  /** When the game last showed play: its clock, last play, period, or status changed. */
  activeAt: Schema.DateTimeUtcFromString,
  /** Until when a TV break after a timeout, a score, or a change of possession lasts, unless play shows first. */
  breakUntil: Schema.optional(Schema.DateTimeUtcFromString),
  /** Until when a score or a turnover still adds to the score. */
  boostUntil: Schema.optional(Schema.DateTimeUtcFromString)
}) {
  /** A game first seen at `now`. With no history, a lull shows only from its status, its clock, or a timeout as its last play. */
  static initial(game: GameSnapshot, now: DateTime.Utc): Watchability {
    const timeout = /timeout/i.test(game.situation?.lastPlay ?? "") && !lateInHalf(game)
    return judged(game, now, {
      activeAt: now,
      breakUntil: timeout ? DateTime.addDuration(now, breakLength) : undefined,
      boostUntil: undefined
    })
  }

  /** This game one snapshot on: `before` is the snapshot this was judged from, `after` the new one. */
  next(before: GameSnapshot, after: GameSnapshot, now: DateTime.Utc): Watchability {
    const events = after.eventsSince(before)
    const played =
      before.clock !== after.clock ||
      before.period !== after.period ||
      before.status !== after.status ||
      before.situation?.lastPlay !== after.situation?.lastPlay
    const breaks = events.some(
      (event) =>
        event._tag === "ScoreChanged" ||
        event._tag === "PossessionChanged" ||
        (event._tag === "TimeoutTaken" && !lateInHalf(after))
    )
    const boosts = events.some((event) => event._tag === "ScoreChanged" || event._tag === "Turnover")
    const newPlay = before.situation?.lastPlay !== after.situation?.lastPlay
    return judged(after, now, {
      activeAt: played ? now : this.activeAt,
      breakUntil: breaks ? DateTime.addDuration(now, breakLength) : newPlay ? undefined : this.breakUntil,
      boostUntil: boosts ? DateTime.addDuration(now, boostLength) : this.boostUntil
    })
  }
}

/** How long a TV break is taken to last after a timeout, a score, or a change of possession. */
const breakLength = Duration.seconds(90)
/** How long a score or a turnover adds to a game's score. */
const boostLength = Duration.seconds(60)
/** No change in the clock or the last play for this long is a lull (60 s: see the plan's measurement). */
const stoppedAfter = Duration.seconds(60)

function judged(
  game: GameSnapshot,
  now: DateTime.Utc,
  memory: {
    activeAt: DateTime.Utc
    breakUntil: DateTime.Utc | undefined
    boostUntil: DateTime.Utc | undefined
  }
): Watchability {
  const breakUntil = stillOn(memory.breakUntil, now)
  const boostUntil = stillOn(memory.boostUntil, now)
  const stopped =
    DateTime.toEpochMillis(now) - DateTime.toEpochMillis(memory.activeAt) >= Duration.toMillis(stoppedAfter)
  const lull =
    game.status === "halftime" ||
    game.status === "delayed" ||
    (game.status === "live" && (game.secondsLeft() === 0 || breakUntil !== undefined || stopped))
  const parts = game.isLive()
    ? [closeness(game), situation(game), stakes(game), ...(boostUntil === undefined ? [] : [boost])]
    : []
  return new Watchability({
    game: game.id,
    score: Math.min(100, Math.round(parts.reduce((total, part) => total + part.points, 0))),
    lull,
    reasons: parts
      .filter((part) => part.points >= 1)
      .sort((a, b) => b.points - a.points)
      .map((part) => part.reason),
    activeAt: memory.activeAt,
    ...(breakUntil === undefined ? {} : { breakUntil }),
    ...(boostUntil === undefined ? {} : { boostUntil })
  })
}

function stillOn(until: DateTime.Utc | undefined, now: DateTime.Utc): DateTime.Utc | undefined {
  return until !== undefined && DateTime.isGreaterThan(until, now) ? until : undefined
}

/** The last two minutes of a half or overtime: timeouts there are short, not TV breaks. */
function lateInHalf(game: GameSnapshot): boolean {
  return game.inTwoMinuteDrill() || (game.status === "live" && game.period >= 5)
}

/** Late and close: the largest part. Overtime counts fully; the fourth quarter more the less time is left. */
function closeness(game: GameSnapshot) {
  const margin = Math.abs(game.home.score - game.away.score)
  const lateness =
    game.period >= 5
      ? 1
      : game.period === 4
        ? 0.6 + 0.4 * (1 - game.secondsLeft() / (15 * 60))
        : (earlyLateness[game.period] ?? 0)
  const close = margin <= 3 ? 1 : margin <= oneScore ? 0.8 : margin <= 16 ? 0.35 : 0.05
  const how =
    margin === 0 ? "tied" : margin <= oneScore ? "one-score" : margin <= 16 ? "two-score" : `${margin}-point`
  const period = game.period >= 5 ? "OT" : `Q${game.period}`
  return { points: closenessPoints * lateness * close, reason: `${how} ${period}, ${game.clock}` }
}

const closenessPoints = 50
/** Lateness of the first three quarters, by period. */
const earlyLateness = [0, 0.1, 0.2, 0.35]
/** A margin one score can tie or overturn. */
const oneScore = 8

/**
 * Field position and the clock for the team with the ball: from the 40, the red zone, goal to go, fourth down, the
 * two-minute drill. Full credit only in a one-score game.
 */
function situation(game: GameSnapshot) {
  const s = game.situation
  if (game.status !== "live" || s === undefined || s.possession === undefined || s.yardLine === undefined)
    return { points: 0, reason: "" }
  const offense = s.possession === game.home.team.id ? game.home.team : game.away.team
  const signals: Array<[number, string]> = []
  if (s.isRedZone) signals.push([redZonePoints, `red zone at the ${s.yardLine}`])
  else if (s.inScoringRange()) signals.push([scoringRangePoints, `at the ${s.yardLine}`])
  if (s.goalToGo()) signals.push([goalToGoPoints, "goal to go"])
  if (s.down === 4) signals.push([fourthDownPoints, `4th & ${s.distance ?? "?"}`])
  if (lateInHalf(game))
    signals.push([twoMinutePoints, game.period >= 5 ? "overtime possession" : "two-minute drill"])
  const raw = Math.min(
    situationCap,
    signals.reduce((total, [points]) => total + points, 0)
  )
  const margin = Math.abs(game.home.score - game.away.score)
  return {
    points: raw * (margin <= oneScore ? 1 : blowoutShare),
    reason: `${offense.abbreviation} ${signals.map(([, label]) => label).join(", ")}`
  }
}

const redZonePoints = 16
const scoringRangePoints = 8
const goalToGoPoints = 6
const fourthDownPoints = 6
const twoMinutePoints = 6
const situationCap = 30
/** The share of field-position credit a game more than one score apart keeps. */
const blowoutShare = 0.2

/** Stakes, from the third quarter in a one-score game: an upset brewing, or two ranked teams. */
function stakes(game: GameSnapshot) {
  const margin = Math.abs(game.home.score - game.away.score)
  if (game.period < 3 || margin > oneScore) return { points: 0, reason: "" }
  for (const [ranked, other] of [
    [game.home, game.away],
    [game.away, game.home]
  ] as const) {
    if (
      ranked.ranking !== undefined &&
      (other.ranking === undefined || other.ranking > ranked.ranking) &&
      other.score >= ranked.score
    )
      return {
        points: upsetPoints,
        reason: `upset brewing: ${other.team.abbreviation} ${other.score > ranked.score ? "leads" : "ties"} #${ranked.ranking} ${ranked.team.abbreviation}`
      }
  }
  return game.home.ranking !== undefined && game.away.ranking !== undefined
    ? {
        points: rankedPoints,
        reason: `#${game.away.ranking} ${game.away.team.abbreviation} at #${game.home.ranking} ${game.home.team.abbreviation}`
      }
    : { points: 0, reason: "" }
}

const upsetPoints = 10
const rankedPoints = 6

/** A score or a turnover in the last minute. */
const boost = { points: 8, reason: "just scored or turned over" }
