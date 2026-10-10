import { Data, DateTime, Duration, Option } from "effect"
import { Classification } from "./Classification.ts"
import type { Game, GameId, GameSnapshot, Odds } from "./Game.ts"
import { BreakReason, Moment, type Stakes } from "./Moment.ts"
import { type BigPlayKind, Play, type PlayId } from "./Play.ts"
import { Slate, SlateChange } from "./Slate.ts"

/**
 * The fold that classifies the slate's games, one step per take and per expiry. It keeps per game what the slate
 * does not: the pregame line once the scoreboard drops it, a big play while it lasts, when it last got a play (its
 * stall clock, restarted whenever the game comes into play), and the moment shown and since when, which holds
 * `momentHold` before a lower one replaces it. Pure.
 */
export class Classifier extends Data.Class<{ readonly games: ReadonlyMap<GameId, Followed> }> {
  static readonly empty: Classifier = new Classifier({ games: new Map() })

  /** How long a big play holds its game's moment. */
  static readonly bigPlayHold = Duration.seconds(60)

  /** How long a moment holds before a lower one may replace it. */
  static readonly momentHold = Duration.seconds(20)

  /** How long a live game goes without a new play before it counts as stopped. */
  static readonly stallAfter = Duration.seconds(90)

  /**
   * Each listed game classified at `now`, `changes` being what the take that made `slate` changed (none for an
   * expiry); a game no listing names is forgotten.
   */
  step(
    slate: Slate,
    changes: ReadonlyArray<SlateChange>,
    now: DateTime.Utc
  ): readonly [Classifier, ReadonlyMap<GameId, Classification>] {
    const games = new Map(
      slate.games.map((game) => {
        const id = game.snapshot.id
        const plays = changes.flatMap((change) =>
          SlateChange.$is("Played")(change) && change.game.snapshot.id === id ? [change.play] : []
        )
        return [id, followed(this.games.get(id), game, plays, now)] as const
      })
    )
    const classifications = new Map(
      [...games].map(([id, { classification }]) => [id, classification] as const)
    )
    return [new Classifier({ games }), classifications]
  }

  /** When the earliest held moment runs out, so the next step can let it go. */
  nextExpiry(): Option.Option<DateTime.Utc> {
    return earliest([...this.games.values()].map(({ expiry }) => expiry))
  }
}

/** What the classifier keeps of one game. */
interface Followed {
  readonly odds: Odds | undefined
  readonly bigPlay:
    | { readonly play: PlayId; readonly kind: BigPlayKind; readonly until: DateTime.Utc }
    | undefined
  readonly lastPlayAt: DateTime.Utc
  readonly inPlay: boolean
  readonly classification: Classification
  readonly expiry: DateTime.Utc | undefined
}

function followed(
  had: Followed | undefined,
  game: Game,
  plays: ReadonlyArray<Play>,
  now: DateTime.Utc
): Followed {
  const { snapshot } = game
  const odds = snapshot.odds ?? had?.odds
  const lasting =
    had?.bigPlay !== undefined && DateTime.isLessThan(now, had.bigPlay.until) ? had.bigPlay : undefined
  const bigPlay = latestBigPlay(plays, now) ?? lasting
  const inPlay = snapshot.inPlay()
  const comingIntoPlay = inPlay && had?.inPlay === false
  const lastPlayAt = plays.length > 0 || had === undefined || comingIntoPlay ? now : had.lastPlayAt
  const stallAt = DateTime.addDuration(lastPlayAt, Classifier.stallAfter)
  const [moment, since, heldBack] = settled(had?.classification, momentOf(game, bigPlay, stallAt, now), now)

  const winProbabilities = game.plays
    .flatMap(({ homeWinProbability }) => (homeWinProbability === undefined ? [] : [homeWinProbability]))
    .slice(-swingPlays)
  const classification = Classification.of({ snapshot, odds, winProbabilities }, moment, since)
  const held = heldBack ? DateTime.addDuration(since, Classifier.momentHold) : undefined
  const stalling = snapshot.progress() === "live" && DateTime.isLessThan(now, stallAt) ? stallAt : undefined
  const expiry = Option.getOrUndefined(earliest([bigPlay?.until, held, stalling]))
  return { odds, bigPlay, lastPlayAt, inPlay, classification, expiry }
}

/** The newest big play among a take's new plays, lasting `bigPlayHold`; none for a backfill of many. */
function latestBigPlay(plays: ReadonlyArray<Play>, now: DateTime.Utc): Followed["bigPlay"] {
  if (plays.length > Slate.backfill) return undefined
  const until = DateTime.addDuration(now, Classifier.bigPlayHold)
  const found = plays
    .toReversed()
    .flatMap((play) =>
      Option.toArray(Option.map(Play.bigPlay(play), (kind) => ({ play: play.id, kind, until })))
    )
  return found[0]
}

/** The highest moment that holds of `game` at `now`, which stalls at `stallAt` without a new play. */
function momentOf(
  game: Game,
  bigPlay: Followed["bigPlay"],
  stallAt: DateTime.Utc,
  now: DateTime.Utc
): Moment {
  const { snapshot } = game
  const progress = snapshot.progress()
  if (progress === "upcoming") return { _tag: "Upcoming" }
  if (progress === "over") return { _tag: "Final" }
  if (bigPlay !== undefined) return { _tag: "BigPlay", play: bigPlay.play, kind: bigPlay.kind }

  const stakes = stakesOf(snapshot)
  const reason = breakReason(game, DateTime.isGreaterThanOrEqualTo(now, stallAt))
  if (reason === undefined) return stakes ?? { _tag: "Live" }
  const expectedEnd = DateTime.addDuration(now, BreakReason.typicalLength(reason, snapshot.league))
  return { _tag: "Break", reason, expectedEnd, ...(stakes === undefined ? {} : { during: stakes }) }
}

/** What is at stake in `snapshot`: the team with the ball in the red zone, else crunch time. */
function stakesOf(snapshot: GameSnapshot): Stakes | undefined {
  const { situation } = snapshot
  if (situation?.possession !== undefined && situation.yardLine !== undefined && situation.inRedZone())
    return { _tag: "ScoringThreat", team: situation.possession, yardsToGo: situation.yardLine }
  if (snapshot.inCrunchTime())
    return { _tag: "CrunchTime", margin: snapshot.margin(), secondsLeft: snapshot.secondsLeft() }
  return undefined
}

/**
 * Why a live game has stopped, if it has, the first that holds: halftime, a delay, its period ended, the two-minute
 * warning, a timeout, a review or an injury its latest play names, a score not yet kicked off from, the kickoff after
 * a score, a change of possession, or no new play for a while (`stalled`).
 */
function breakReason(game: Game, stalled: boolean): BreakReason | undefined {
  const { snapshot, plays } = game
  if (snapshot.status === "halftime") return "halftime"
  if (snapshot.status === "delayed") return "delay"
  const last = plays.at(-1)
  if (!snapshot.inPlay() || (last !== undefined && Play.guards.PeriodEnd(last))) return "periodEnd"
  if (last === undefined) return stalled ? "stall" : undefined
  if (Play.guards.Stoppage(last) && last.kind === "twoMinuteWarning") return "twoMinuteWarning"
  if (Play.guards.Timeout(last) || (Play.guards.Stoppage(last) && last.kind === "officialTimeout"))
    return "timeout"
  const stop = Option.getOrUndefined(Play.stopInText(last))
  if (stop !== undefined) return stop

  const scored = plays.findLastIndex(({ scoring }) => scoring)
  const kickedOff = plays.findLastIndex((play) => Play.guards.Kickoff(play))
  if (scored !== -1 && kickedOff <= scored) return "afterScore"
  if (Play.guards.Kickoff(last)) {
    const kickedOffBefore = plays.slice(0, -1).findLastIndex((play) => Play.guards.Kickoff(play))
    if (scored > kickedOffBefore) return "afterKickoff"
  }
  if (Play.changesPossession(last)) return "possessionChange"
  return stalled ? "stall" : undefined
}

/**
 * The moment to show, since when, and whether `candidate` was held back: the moment held, while it is the same kind or
 * outranks `candidate` and has held less than `momentHold`; otherwise `candidate`, from `now`. Leaving a break or
 * going not live never waits. A break for the same reason keeps its expected end; a new reason is a new break.
 */
function settled(
  had: Classification | undefined,
  candidate: Moment,
  now: DateTime.Utc
): readonly [Moment, DateTime.Utc, boolean] {
  if (had === undefined) return [candidate, now, false]
  const { moment } = had
  if (moment._tag === "Break" && candidate._tag === "Break")
    return moment.reason === candidate.reason
      ? [{ ...candidate, expectedEnd: moment.expectedEnd }, had.since, false]
      : [candidate, now, false]
  if (moment._tag === candidate._tag) return [candidate, had.since, false]

  const lower = Moment.precedence(candidate, moment) > 0
  const free = candidate._tag === "Upcoming" || candidate._tag === "Final" || moment._tag === "Break"
  const holding = DateTime.isLessThan(now, DateTime.addDuration(had.since, Classifier.momentHold))
  return lower && !free && holding ? [moment, had.since, true] : [candidate, now, false]
}

/** The earliest of `times` given. */
function earliest(times: ReadonlyArray<DateTime.Utc | undefined>): Option.Option<DateTime.Utc> {
  const given = times.filter((time) => time !== undefined)
  return Option.fromUndefinedOr(given.toSorted(DateTime.Order)[0])
}

/** How many of a game's latest plays with a win probability its swing is read from. */
const swingPlays = 3
