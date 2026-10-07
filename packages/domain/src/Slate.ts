import { Cause, Data, DateTime, Effect, Equal, Option } from "effect"
import { Delivery, type DeliverySource } from "./Delivery.ts"
import type { GameId, GameSnapshot } from "./Game.ts"
import { GameEvent, type GameEventKind } from "./GameEvent.ts"
import type { LeagueId } from "./League.ts"
import { LiveGame, LiveGameState, type TookOutcome } from "./LiveGame.ts"
import type { RecentPlays } from "./RecentPlays.ts"
import { SlateObservation } from "./SlateObservation.ts"

/**
 * The slate: the last frame's `seq`, each league's last listing, every current game's live game, taken from push and
 * poll deliveries in arrival order, each game it saw finish, and `reached`, the instant it has ticked to: every wake
 * time at or before it has been ticked.
 */
export class Slate extends Data.Class<{
  readonly seq: Option.Option<number>
  readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly live: ReadonlyMap<GameId, LiveGame>
  /**
   * Each game the slate stopped as over, as its final snapshot, while a league's last listing names it: a snapshot of
   * one not ahead of its end (`GameSnapshot#isAheadOfOver`) is behind, so a poll lagging the push does not start it
   * again, while overtime after a spurious final, or a postponed game resuming, does.
   */
  readonly finished: ReadonlyMap<GameId, GameSnapshot>
  readonly reached: Option.Option<DateTime.Utc>
}> {
  static readonly empty: Slate = new Slate({
    seq: Option.none(),
    listed: new Map(),
    live: new Map(),
    finished: new Map(),
    reached: Option.none()
  })

  /** How many of a game's plays `recentPlays` keeps: its last ten. */
  private static readonly recentPlayCount = 10

  /** The start of the game day `now` is in: 04:00 local, the day before when `now` is earlier. */
  static dayStart(now: DateTime.Zoned): DateTime.Utc {
    const today = DateTime.setParts(now, { hour: 4, minute: 0, second: 0, millisecond: 0 })
    return DateTime.toUtc(DateTime.isLessThan(now, today) ? DateTime.subtract(today, { days: 1 }) : today)
  }

  /**
   * Takes one frame: ticks every game due after `reached` and at or before `at`, then applies each of its deliveries in
   * order, and sets `seq` to the frame's, even when it has no deliveries. A tick never goes back. A game whose take or
   * tick raises a defect keeps its last good live game and observes `Raised`.
   */
  take(frame: {
    readonly deliveries: ReadonlyArray<Delivery>
    readonly at: DateTime.Utc
    readonly seq: number
  }): Effect.Effect<Taken> {
    return this.advance(frame.at, Option.some(frame.seq), (ticked) =>
      Effect.reduce(
        frame.deliveries,
        () => ticked,
        (advancing, delivery) => applied(advancing, delivery, frame.at)
      )
    )
  }

  /** Ticks every game due after `reached` and at or before `now`, with no frame: `seq` stays as it was. */
  tick(now: DateTime.Utc): Effect.Effect<Taken> {
    return this.advance(now, Option.none(), Effect.succeed)
  }

  /** The earliest instant after `reached` at which a live game changes with no new frame. */
  earliestDue(): Option.Option<DateTime.Utc> {
    return Option.flatMap(this.reached, (from) => dueAfter(this.live, from))
  }

  /** Each listed game in `leagues`, leagues in order, as the slate has it. */
  games(leagues: ReadonlyArray<LeagueId>): ReadonlyArray<GameSnapshot> {
    return leagues.flatMap((league) => asHeld(this.listed.get(league) ?? [], this))
  }

  /** The last `recentPlayCount` plays of each of `games` that has plays in `live`. */
  recentPlays(games: ReadonlyArray<GameSnapshot>): RecentPlays {
    return Object.fromEntries(
      games.flatMap(({ id }) => {
        const plays = this.live.get(id)?.plays ?? []
        return plays.length === 0 ? [] : [[id, plays.slice(-Slate.recentPlayCount)] as const]
      })
    )
  }

  /** Every listed game as the slate has it, then live games no listing holds. */
  everyGame(): ReadonlyArray<GameSnapshot> {
    const listed = [...this.listed.values()].flatMap((games) => asHeld(games, this))
    const unlisted = [...this.live.values()]
      .map(({ snapshot }) => snapshot)
      .filter((snapshot) => !listed.some(({ id }) => id === snapshot.id))
    return [...listed, ...unlisted]
  }

  /**
   * Whether `that` publishes the same: a take or tick that changed nothing hands back the same maps. `seq` and `reached`
   * are ignored, since moving only them changes no game.
   */
  publishesSameAs(that: Slate): boolean {
    return this.live === that.live && this.listed === that.listed && this.finished === that.finished
  }

  /** Ticks to `at`, then runs `then` on what the ticks left, as frame `seq` (none keeps the last). */
  private advance(
    at: DateTime.Utc,
    seq: Option.Option<number>,
    then: (ticked: Advancing) => Effect.Effect<Advancing>
  ): Effect.Effect<Taken> {
    const from = Option.getOrElse(this.reached, () => at)
    const reached = Option.some(DateTime.max(from, at))
    const lastSeq = Option.orElse(seq, () => this.seq)
    const start = new Advancing({
      listed: this.listed,
      live: this.live,
      finished: this.finished,
      events: [],
      observations: []
    })

    return tickTo(start, from, at).pipe(
      Effect.flatMap(then),
      Effect.map(({ listed, live, finished, events, observations }) => ({
        next: new Slate({ seq: lastSeq, listed, live, finished, reached }),
        events,
        observations
      }))
    )
  }
}

/** What one take or tick did: the next slate, the game events it said, and what telemetry tells of it. */
export type Taken = {
  readonly next: Slate
  readonly events: ReadonlyArray<GameEvent>
  readonly observations: ReadonlyArray<SlateObservation>
}

/** A take or tick under way: what the slate holds so far, and what it has said. */
class Advancing extends Data.Class<{
  readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly live: ReadonlyMap<GameId, LiveGame>
  readonly finished: ReadonlyMap<GameId, GameSnapshot>
  readonly events: ReadonlyArray<GameEvent>
  readonly observations: ReadonlyArray<SlateObservation>
}> {
  observe(observation: SlateObservation): Advancing {
    return new Advancing({ ...this, observations: [...this.observations, observation] })
  }

  /** Says `events` of game `id`, stamped with the game and `at`. */
  say(id: GameId, at: DateTime.Utc, events: ReadonlyArray<GameEventKind>): Advancing {
    const said = events.map((what) => new GameEvent({ game: id, at, what }))
    return new Advancing({ ...this, events: [...this.events, ...said] })
  }

  /** Lists `games` as `league`'s last listing, and forgets each finished game no listing names any more. */
  relist(league: LeagueId, games: ReadonlyArray<GameSnapshot>): Advancing {
    const listed = new Map(this.listed).set(league, games)
    const finished = stillListed(this.finished, listed)
    return new Advancing({ ...this, listed, finished })
  }

  /**
   * Game `id` after a step at `at` from `current` (none for a game the slate does not hold): holds the step's new live
   * game, if any, while it is current, and lets it go once it is not, remembering it as finished when it is over. A game
   * that was never held and is not current is not held, and nothing is said of it.
   */
  settle(
    id: GameId,
    at: DateTime.Utc,
    current: Option.Option<LiveGame>,
    step: { readonly liveGame: Option.Option<LiveGame>; readonly events: ReadonlyArray<GameEventKind> }
  ): Advancing {
    const gameStep = gameStepOf(current, step, at)
    const said = this.say(id, at, step.events)

    return GameStep.$match(gameStep, {
      Started: ({ after }) => said.hold(id, after).observe(SlateObservation.Started({ liveGame: after, at })),
      Changed: ({ before, after }) =>
        said.hold(id, after).observe(SlateObservation.Changed({ before, after, at })),
      Kept: () => said,
      Stopped: ({ before, after, changed }) => {
        const observed = changed ? said.observe(SlateObservation.Changed({ before, after, at })) : said
        return observed.release(id, after).observe(SlateObservation.Stopped({ liveGame: after, at }))
      },
      Unheld: (): Advancing => this
    })
  }

  /** Runs one game's pure step; a defect keeps what came before and reports it with the snapshot at hand. */
  guard(
    snapshot: GameSnapshot,
    by: string,
    step: (advancing: Advancing) => Advancing
  ): Effect.Effect<Advancing> {
    return Effect.sync(() => step(this)).pipe(
      Effect.catchDefect((defect) =>
        Effect.succeed(this.observe(SlateObservation.Raised({ snapshot, cause: Cause.die(defect), by })))
      )
    )
  }

  private hold(id: GameId, liveGame: LiveGame): Advancing {
    return new Advancing({ ...this, live: new Map(this.live).set(id, liveGame) })
  }

  /** Lets game `id` go, remembering it as finished when `after` is over. */
  private release(id: GameId, after: LiveGame): Advancing {
    const live = new Map([...this.live].filter(([game]) => game !== id))
    const finished = LiveGameState.$is("Over")(after.state)
      ? new Map(this.finished).set(id, after.snapshot)
      : this.finished
    return new Advancing({ ...this, live, finished })
  }
}

/** What one step did to one game's place in the slate. */
type GameStep = Data.TaggedEnum<{
  /** Not held before, current now: held and observed as started. */
  Started: { readonly after: LiveGame }
  /** Held, still current, and the step made a new live game: held and observed as changed. */
  Changed: { readonly before: LiveGame; readonly after: LiveGame }
  /** Held, still current, and the step made nothing new: only its events are said. */
  Kept: { readonly before: LiveGame }
  /**
   * Held, no longer current: let go and observed as stopped, after a change when the step made a new live game
   * (`after` is then the new one, else the held one).
   */
  Stopped: { readonly before: LiveGame; readonly after: LiveGame; readonly changed: boolean }
  /** Not held, not current: nothing happens, nothing is said. */
  Unheld: object
}>
const GameStep = Data.taggedEnum<GameStep>()

/** What the slate holds after one of a frame's deliveries, received at `at`. */
function applied(advancing: Advancing, delivery: Delivery, at: DateTime.Utc): Effect.Effect<Advancing> {
  return Delivery.match(delivery, {
    Listing: ({ league, games }) =>
      Effect.reduce(
        games,
        () => advancing,
        (acc, snapshot) => snapshotTaken(acc, snapshot, "poll", at)
      ).pipe(Effect.map((taken) => taken.relist(league, games))),
    Snapshot: ({ snapshot, from }) => snapshotTaken(advancing, snapshot, from, at),
    Plays: (plays) =>
      Option.match(Option.fromNullishOr(advancing.live.get(plays.game)), {
        onNone: () => Effect.succeed(advancing.observe(SlateObservation.Dropped({ game: plays.game }))),
        onSome: (liveGame) =>
          advancing.guard(liveGame.snapshot, "a delivery", (guarded) =>
            guarded.settle(plays.game, at, Option.some(liveGame), liveGame.take(plays, at))
          )
      })
  })
}

/** The earliest instant after `from` at which a live game changes with no new frame. */
function dueAfter(live: ReadonlyMap<GameId, LiveGame>, from: DateTime.Utc): Option.Option<DateTime.Utc> {
  return LiveGame.earliest([...live.values()].map((liveGame) => liveGame.dueAfter(from)))
}

/** Each listed game, in listed order, as the slate has it (live, or as its final once finished), or as listed. */
function asHeld(
  listed: ReadonlyArray<GameSnapshot>,
  {
    live,
    finished
  }: { readonly live: ReadonlyMap<GameId, LiveGame>; readonly finished: ReadonlyMap<GameId, GameSnapshot> }
): ReadonlyArray<GameSnapshot> {
  return listed.map((game) => live.get(game.id)?.snapshot ?? finished.get(game.id) ?? game)
}

/**
 * Ticks, in wake order, every game due after `from` and at or before `at`, each at its own wake instant; games due at
 * the same instant tick together.
 */
function tickTo(advancing: Advancing, from: DateTime.Utc, at: DateTime.Utc): Effect.Effect<Advancing> {
  const due = Option.filter(dueAfter(advancing.live, from), (instant) =>
    DateTime.isLessThanOrEqualTo(instant, at)
  )

  return Option.match(due, {
    onNone: () => Effect.succeed(advancing),
    onSome: (due) => {
      const dueNow = [...advancing.live.values()].filter((liveGame) =>
        Option.exists(liveGame.dueAfter(from), (instant) => DateTime.Equivalence(instant, due))
      )
      return Effect.reduce(
        dueNow,
        () => advancing,
        (acc, liveGame) => acc.guard(liveGame.snapshot, "a tick", (guarded) => ticked(guarded, liveGame, due))
      ).pipe(Effect.flatMap((after) => tickTo(after, due, at)))
    }
  })
}

/** `finished` less the games no listing in `listed` names; itself when it loses none. */
function stillListed(
  finished: ReadonlyMap<GameId, GameSnapshot>,
  listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
): ReadonlyMap<GameId, GameSnapshot> {
  const named = new Set([...listed.values()].flatMap((games) => games.map(({ id }) => id)))
  return [...finished.keys()].every((id) => named.has(id))
    ? finished
    : new Map([...finished].filter(([id]) => named.has(id)))
}

/**
 * What a step did to a game's place: `current` is the live game the slate holds (none when it holds none), and the
 * step's new live game, if any, replaces it.
 */
function gameStepOf(
  current: Option.Option<LiveGame>,
  step: { readonly liveGame: Option.Option<LiveGame> },
  at: DateTime.Utc
): GameStep {
  return Option.match(current, {
    onNone: () =>
      Option.match(step.liveGame, {
        onNone: () => GameStep.Unheld(),
        onSome: (after) => (after.isCurrent(at) ? GameStep.Started({ after }) : GameStep.Unheld())
      }),
    onSome: (before) => {
      const after = Option.getOrElse(step.liveGame, () => before)
      const changed = Option.isSome(step.liveGame)

      if (!after.isCurrent(at)) return GameStep.Stopped({ before, after, changed })
      return changed ? GameStep.Changed({ before, after }) : GameStep.Kept({ before })
    }
  })
}

/**
 * A snapshot taken by the slate: a repeat of a finished game's final is not observed, one behind it is observed as
 * behind, and any other is taken by the game's live game, or starts one.
 */
function snapshotTaken(
  advancing: Advancing,
  snapshot: GameSnapshot,
  from: DeliverySource,
  at: DateTime.Utc
): Effect.Effect<Advancing> {
  return advancing.guard(snapshot, "a delivery", (guarded) => {
    const final = Option.fromNullishOr(guarded.finished.get(snapshot.id))
    // Every poll of a finished game still listed repeats its final; only a different one is worth observing.
    if (Option.exists(final, (over) => Equal.equals(snapshot, over))) return guarded
    if (Option.isSome(final) && !snapshot.isAheadOfOver(final.value)) {
      return guarded.observe(SlateObservation.Took({ snapshot, from, outcome: "behind", had: final }))
    }

    // A finished game is taken as the over game it was, so a correction ahead of its final says what it changed.
    const current = Option.orElse(Option.fromNullishOr(guarded.live.get(snapshot.id)), () =>
      Option.map(final, (over) => LiveGame.start(over, from, at))
    )
    const step = Option.match(current, {
      onNone: (): {
        readonly liveGame: Option.Option<LiveGame>
        readonly events: ReadonlyArray<GameEventKind>
        readonly outcome: TookOutcome
      } => ({ liveGame: Option.some(LiveGame.start(snapshot, from, at)), events: [], outcome: "taken" }),
      onSome: (liveGame) => liveGame.take(Delivery.cases.Snapshot.make({ snapshot, from }), at)
    })
    const had = Option.map(current, (liveGame) => liveGame.snapshot)
    const took = SlateObservation.Took({ snapshot, from, outcome: step.outcome, had })

    return guarded.observe(took).settle(snapshot.id, at, current, step)
  })
}

/** A game's tick at its wake instant `due`: a fall back is observed as a take of the held snapshot, as the poll's. */
function ticked(advancing: Advancing, liveGame: LiveGame, due: DateTime.Utc): Advancing {
  const step = liveGame.tick(due)
  const fellBack = Option.filter(step.liveGame, () => step.fellBack)
  const observed = Option.match(fellBack, {
    onNone: () => advancing,
    onSome: (after) =>
      advancing.observe(
        SlateObservation.Took({
          snapshot: after.snapshot,
          from: after.from,
          outcome: "fellBack",
          had: Option.some(liveGame.snapshot)
        })
      )
  })

  return observed.settle(liveGame.snapshot.id, due, Option.some(liveGame), step)
}
