import { Data, DateTime, Duration, Option } from "effect"
import { Classification } from "./Classification.ts"
import type { Game, GameId, Odds } from "./Game.ts"
import { type BreakReason, Moment } from "./Moment.ts"
import { type BigPlayKind, Play, type PlayId } from "./Play.ts"
import { Slate, SlateChange } from "./Slate.ts"

/**
 * The fold that classifies the slate's games, one step per take and per expiry. It keeps per game what the slate
 * does not: the pregame line once the scoreboard drops it, a big play while it lasts, and the moment shown and since
 * when, which holds `momentHold` before a lower one replaces it. Pure.
 */
export class Classifier extends Data.Class<{ readonly games: ReadonlyMap<GameId, Followed> }> {
  static readonly empty: Classifier = new Classifier({ games: new Map() })

  /** How long a big play holds its game's moment. */
  static readonly bigPlayHold = Duration.seconds(60)

  /** How long a moment holds before a lower one may replace it. */
  static readonly momentHold = Duration.seconds(20)

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
  const [moment, since, heldBack] = settled(had?.classification, momentOf(game, bigPlay), now)

  const winProbabilities = game.plays
    .flatMap(({ homeWinProbability }) => (homeWinProbability === undefined ? [] : [homeWinProbability]))
    .slice(-swingPlays)
  const classification = Classification.of({ snapshot, odds, winProbabilities }, moment, since)
  const held = heldBack ? DateTime.addDuration(since, Classifier.momentHold) : undefined
  const expiry = Option.getOrUndefined(earliest([bigPlay?.until, held]))
  return { odds, bigPlay, classification, expiry }
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

/** The highest moment that holds of `game`. */
function momentOf(game: Game, bigPlay: Followed["bigPlay"]): Moment {
  const { snapshot } = game
  const progress = snapshot.progress()
  if (progress === "upcoming") return { _tag: "Upcoming" }
  if (progress === "over") return { _tag: "Final" }
  if (snapshot.status === "halftime") return { _tag: "Break", reason: "halftime" }
  if (snapshot.status === "delayed") return { _tag: "Break", reason: "delay" }

  const { situation } = snapshot
  if (situation?.possession !== undefined && situation.yardLine !== undefined && situation.inRedZone())
    return { _tag: "ScoringThreat", team: situation.possession, yardsToGo: situation.yardLine }
  if (snapshot.inCrunchTime())
    return { _tag: "CrunchTime", margin: snapshot.margin(), secondsLeft: snapshot.secondsLeft() }
  if (bigPlay !== undefined) return { _tag: "BigPlay", play: bigPlay.play, kind: bigPlay.kind }

  const reason = breakReason(game)
  return reason === undefined ? { _tag: "Live" } : { _tag: "Break", reason }
}

/** Why a live game in play has stopped, if it has: its period ended, a timeout, or a score not yet kicked off from. */
function breakReason(game: Game): BreakReason | undefined {
  const { snapshot, plays } = game
  const last = plays.at(-1)
  if (!snapshot.inPlay() || (last !== undefined && Play.guards.PeriodEnd(last))) return "periodEnd"
  if (last === undefined) return undefined
  if (Play.guards.Timeout(last) || (Play.guards.Stoppage(last) && last.kind !== "coinToss")) return "timeout"

  const scored = plays.findLastIndex(({ scoring }) => scoring)
  const kickedOff = plays.findLastIndex((play) => Play.guards.Kickoff(play))
  return scored !== -1 && kickedOff <= scored ? "afterScore" : undefined
}

/**
 * The moment to show, since when, and whether `candidate` was held back: the moment held, while it is the same kind or
 * outranks `candidate` and has held less than `momentHold`; otherwise `candidate`, from `now`. Not live never waits.
 */
function settled(
  had: Classification | undefined,
  candidate: Moment,
  now: DateTime.Utc
): readonly [Moment, DateTime.Utc, boolean] {
  if (had === undefined) return [candidate, now, false]
  if (had.moment._tag === candidate._tag) return [candidate, had.since, false]

  const lower = Moment.precedence(candidate, had.moment) > 0
  const notLive = candidate._tag === "Upcoming" || candidate._tag === "Final"
  const holding = DateTime.isLessThan(now, DateTime.addDuration(had.since, Classifier.momentHold))
  return lower && !notLive && holding ? [had.moment, had.since, true] : [candidate, now, false]
}

/** The earliest of `times` given. */
function earliest(times: ReadonlyArray<DateTime.Utc | undefined>): Option.Option<DateTime.Utc> {
  const given = times.filter((time) => time !== undefined)
  return Option.fromUndefinedOr(given.toSorted(DateTime.Order)[0])
}

/** How many of a game's latest plays with a win probability its swing is read from. */
const swingPlays = 3
