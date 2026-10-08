import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { GameEvent, type GameEventKind } from "@sportal/domain/GameEvent"
import type { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import type { RecentPlays } from "@sportal/domain/RecentPlays"
import { Cause, Data, DateTime, Effect, Equal, Option } from "effect"
import { Acknowledgement } from "./Acknowledgement.ts"
import { Delivery, type DeliverySource } from "./Delivery.ts"
import { SlateObservation } from "./SlateObservation.ts"

/**
 * The slate: each league's last listing, every current game as its snapshot, its plays and its acknowledgement, taken
 * from push and poll deliveries in arrival order, each game it saw finish, the last frame's `seq`, and `reached`, the
 * instant it has ticked to: every wake time at or before it has been ticked.
 */
export class Slate extends Data.Class<{
  readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  /** Each current game, as the slate has it. */
  readonly games: ReadonlyMap<GameId, GameSnapshot>
  /** Each current game's plays, in `Play.order`. */
  readonly plays: ReadonlyMap<GameId, ReadonlyArray<Play>>
  /** Each current game's acknowledgement: the same games as `games`. */
  readonly acknowledged: ReadonlyMap<GameId, Acknowledgement>
  /**
   * Each game the slate stopped as over, as its final snapshot, while a league's last listing names it: a snapshot of
   * one not ahead of its end (`GameSnapshot#isAheadOfOver`) is behind, so a poll lagging the push does not start it
   * again, while overtime after a spurious final, or a postponed game resuming, does.
   */
  readonly finished: ReadonlyMap<GameId, GameSnapshot>
  readonly seq: Option.Option<number>
  readonly reached: Option.Option<DateTime.Utc>
}> {
  static readonly empty: Slate = new Slate({
    listed: new Map(),
    games: new Map(),
    plays: new Map(),
    acknowledged: new Map(),
    finished: new Map(),
    seq: Option.none(),
    reached: Option.none()
  })

  /** How many of a game's plays `recentPlays` keeps: its last ten. */
  private static readonly recentPlayCount = 10

  /**
   * Takes one frame: ticks every game due after `reached` and at or before `at`, then applies each of its deliveries in
   * order, and sets `seq` to the frame's, even when it has no deliveries. A tick never goes back. A game whose take or
   * tick raises a defect keeps what it had and observes `Raised`.
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

  /** The earliest instant after `reached` at which a current game changes, or its state turns, with no new frame. */
  earliestDue(): Option.Option<DateTime.Utc> {
    return Option.flatMap(this.reached, (from) => dueAfter(this, from))
  }

  /** Game `id`'s state at `reached`; none when the slate does not hold it. */
  state(id: GameId) {
    return Option.flatMap(this.reached, (at) =>
      Option.map(heldIn(this, id), ({ snapshot, acknowledgement }) => acknowledgement.state(snapshot, at))
    )
  }

  /** Each game the slate holds that is current at `now`. */
  current(now: DateTime.Utc): ReadonlyArray<GameSnapshot> {
    return everyHeld(this)
      .filter(({ snapshot, acknowledgement }) => acknowledgement.isCurrent(snapshot, now))
      .map(({ snapshot }) => snapshot)
  }

  /** Each listed game in `leagues`, leagues in order, as the slate has it. */
  listedGames(leagues: ReadonlyArray<LeagueId>): ReadonlyArray<GameSnapshot> {
    return leagues.flatMap((league) => asHeld(this.listed.get(league) ?? [], this))
  }

  /** The last `recentPlayCount` plays of each of `games` that has plays. */
  recentPlays(games: ReadonlyArray<GameSnapshot>): RecentPlays {
    return Object.fromEntries(
      games.flatMap(({ id }) => {
        const plays = this.plays.get(id) ?? []
        return plays.length === 0 ? [] : [[id, plays.slice(-Slate.recentPlayCount)] as const]
      })
    )
  }

  /** Every listed game as the slate has it, then current games no listing holds. */
  everyGame(): ReadonlyArray<GameSnapshot> {
    const listed = [...this.listed.values()].flatMap((games) => asHeld(games, this))
    const unlisted = [...this.games.values()].filter(
      (snapshot) => !listed.some(({ id }) => id === snapshot.id)
    )
    return [...listed, ...unlisted]
  }

  /**
   * Whether `that` publishes the same: a take or tick that changed nothing hands back the same maps, and leaves each game
   * in the same state. `seq` and `reached` alone are ignored, since moving only them changes no game.
   */
  publishesSameAs(that: Slate): boolean {
    return (
      this.listed === that.listed &&
      this.games === that.games &&
      this.plays === that.plays &&
      this.acknowledged === that.acknowledged &&
      this.finished === that.finished &&
      [...this.games.keys()].every((id) => Equal.equals(this.state(id), that.state(id)))
    )
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
      games: this.games,
      plays: this.plays,
      acknowledged: this.acknowledged,
      finished: this.finished,
      events: [],
      observations: []
    })

    return tickTo(start, from, at).pipe(
      Effect.flatMap(then),
      Effect.map(({ listed, games, plays, acknowledged, finished, events, observations }) => ({
        next: new Slate({ listed, games, plays, acknowledged, finished, seq: lastSeq, reached }),
        events,
        observations
      }))
    )
  }
}

/** What one take or tick did: the next slate, the game events it said, and what telemetry tells of it. */
export interface Taken {
  readonly next: Slate
  readonly events: ReadonlyArray<GameEvent>
  readonly observations: ReadonlyArray<SlateObservation>
}

/** A game as the slate holds it: its snapshot and its acknowledgement. */
type Held = Option.Option.Value<ReturnType<Acknowledgement["took"]>["next"]>

/**
 * A take or tick under way: what the slate holds so far, and what it has said. `games`, `plays` and `acknowledged` hold
 * the same games, and only `hold` and `release` write them.
 */
class Advancing extends Data.Class<{
  readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly games: ReadonlyMap<GameId, GameSnapshot>
  readonly plays: ReadonlyMap<GameId, ReadonlyArray<Play>>
  readonly acknowledged: ReadonlyMap<GameId, Acknowledgement>
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

  /** Game `id`'s plays so far, in `Play.order`; none for a game the slate does not hold. */
  playsOf(id: GameId): ReadonlyArray<Play> {
    return this.plays.get(id) ?? []
  }

  /**
   * Game `id` after a step at `at` from `current` (none for a game the slate does not hold), as it stood at `since`:
   * holds the step's next game, if any, with `plays`, while it is current, and lets it go once it is not, remembering it
   * as finished when it is over. A game whose state only turned is observed as changed, and held as it was. A game that
   * was never held and is not current is not held, and nothing is said of it.
   */
  settle(
    id: GameId,
    instants: { readonly since: DateTime.Utc; readonly at: DateTime.Utc },
    current: Option.Option<Held>,
    step: Pick<ReturnType<Acknowledgement["took"]>, "next" | "events">,
    plays: ReadonlyArray<Play>
  ): Advancing {
    const { since, at } = instants
    const gameStep = gameStepOf(current, step, instants)
    const said = this.say(id, at, step.events)

    return GameStep.$match(gameStep, {
      Started: ({ after }) => said.hold(id, after, plays).observe(SlateObservation.Started({ after, at })),
      Changed: ({ before, after }) =>
        said.hold(id, after, plays).observe(SlateObservation.Changed({ before, after, since, at })),
      Turned: ({ game }) => said.observe(SlateObservation.Changed({ before: game, after: game, since, at })),
      Kept: () => said,
      Stopped: ({ before, after, changed }) => {
        const observed = changed ? said.observe(SlateObservation.Changed({ before, after, since, at })) : said
        return observed.release(id, after).observe(SlateObservation.Stopped({ after, at }))
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

  private hold(id: GameId, { snapshot, acknowledgement }: Held, plays: ReadonlyArray<Play>): Advancing {
    return new Advancing({
      ...this,
      games: new Map(this.games).set(id, snapshot),
      plays: new Map(this.plays).set(id, plays),
      acknowledged: new Map(this.acknowledged).set(id, acknowledgement)
    })
  }

  /** Lets game `id` go, with its plays, remembering it as finished when `after` is over. */
  private release(id: GameId, after: Held): Advancing {
    const finished =
      after.snapshot.progress() === "over" ? new Map(this.finished).set(id, after.snapshot) : this.finished
    return new Advancing({
      ...this,
      games: without(this.games, id),
      plays: without(this.plays, id),
      acknowledged: without(this.acknowledged, id),
      finished
    })
  }
}

/** What one step did to one game's place in the slate. */
type GameStep = Data.TaggedEnum<{
  /** Not held before, current now: held and observed as started. */
  Started: { readonly after: Held }
  /** Held, still current, and the step made a next game: held and observed as changed. */
  Changed: { readonly before: Held; readonly after: Held }
  /** Held, still current, the step made nothing new, but its state turned (it went stale): observed as changed. */
  Turned: { readonly game: Held }
  /** Held, still current, its state as it was, and the step made nothing new: only its events are said. */
  Kept: { readonly before: Held }
  /**
   * Held, no longer current: let go and observed as stopped, after a change when the step made a next game (`after` is
   * then the next one, else the held one).
   */
  Stopped: { readonly before: Held; readonly after: Held; readonly changed: boolean }
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
    Plays: ({ game, plays }) =>
      Option.match(heldIn(advancing, game), {
        onNone: () => Effect.succeed(advancing.observe(SlateObservation.Dropped({ game }))),
        onSome: (held) =>
          advancing.guard(held.snapshot, "a delivery", (guarded) => playsTaken(guarded, held, plays, at))
      })
  })
}

/**
 * Game `held` once its whole list of plays is `plays`, at `at`: the list replaced, in `Play.order`, saying only the new
 * plays' events; nothing for an equal list. Plays are not acknowledged: the game's acknowledgement stays as it was.
 */
function playsTaken(
  advancing: Advancing,
  held: Held,
  plays: ReadonlyArray<Play>,
  at: DateTime.Utc
): Advancing {
  const id = held.snapshot.id
  const had = advancing.playsOf(id)
  const changed = Option.liftPredicate(plays.toSorted(Play.order), (sorted) => !Equal.equals(sorted, had))
  const step = Option.match(changed, {
    onNone: () => ({ next: Option.none<Held>(), events: [] }),
    onSome: (sorted) => ({ next: Option.some(held), events: Play.eventsSince(had, sorted) })
  })

  return advancing.settle(
    id,
    { since: at, at },
    Option.some(held),
    step,
    Option.getOrElse(changed, () => had)
  )
}

/** The earliest instant after `from` at which a game `holding` holds changes, or its state turns, with no new frame. */
function dueAfter(
  holding: Pick<Slate, "games" | "acknowledged">,
  from: DateTime.Utc
): Option.Option<DateTime.Utc> {
  return Acknowledgement.earliest(
    everyHeld(holding).map(({ snapshot, acknowledgement }) => acknowledgement.dueAfter(snapshot, from))
  )
}

/** Every game `holding` holds, in the order it first held them. */
function everyHeld(holding: Pick<Slate, "games" | "acknowledged">): ReadonlyArray<Held> {
  return [...holding.acknowledged.keys()].flatMap((id) => Option.toArray(heldIn(holding, id)))
}

/** Game `id` as `holding` holds it; none when it holds none. */
function heldIn(holding: Pick<Slate, "games" | "acknowledged">, id: GameId): Option.Option<Held> {
  return Option.all({
    snapshot: Option.fromNullishOr(holding.games.get(id)),
    acknowledgement: Option.fromNullishOr(holding.acknowledged.get(id))
  })
}

/** Each listed game, in listed order, as the slate has it (current, or as its final once finished), or as listed. */
function asHeld(
  listed: ReadonlyArray<GameSnapshot>,
  { games, finished }: Pick<Slate, "games" | "finished">
): ReadonlyArray<GameSnapshot> {
  return listed.map((game) => games.get(game.id) ?? finished.get(game.id) ?? game)
}

/**
 * Ticks, in wake order, every game due after `from` and at or before `at`, each at its own wake instant; games due at
 * the same instant tick together.
 */
function tickTo(advancing: Advancing, from: DateTime.Utc, at: DateTime.Utc): Effect.Effect<Advancing> {
  const due = Option.filter(dueAfter(advancing, from), (instant) => DateTime.isLessThanOrEqualTo(instant, at))

  return Option.match(due, {
    onNone: () => Effect.succeed(advancing),
    onSome: (due) => {
      const dueNow = everyHeld(advancing).filter(({ snapshot, acknowledgement }) =>
        Option.exists(acknowledgement.dueAfter(snapshot, from), (instant) =>
          DateTime.Equivalence(instant, due)
        )
      )
      return Effect.reduce(
        dueNow,
        () => advancing,
        (acc, held) =>
          acc.guard(held.snapshot, "a tick", (guarded) => ticked(guarded, held, { since: from, at: due }))
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

function without<A>(map: ReadonlyMap<GameId, A>, id: GameId): ReadonlyMap<GameId, A> {
  return new Map([...map].filter(([game]) => game !== id))
}

/**
 * What a step did to a game's place: `current` is the game the slate holds (none when it holds none), as it stood at
 * `since`, and the step's next game, if any, replaces it at `at`.
 */
function gameStepOf(
  current: Option.Option<Held>,
  step: Pick<ReturnType<Acknowledgement["took"]>, "next">,
  { since, at }: { readonly since: DateTime.Utc; readonly at: DateTime.Utc }
): GameStep {
  return Option.match(current, {
    onNone: () =>
      Option.match(step.next, {
        onNone: () => GameStep.Unheld(),
        onSome: (after) =>
          after.acknowledgement.isCurrent(after.snapshot, at)
            ? GameStep.Started({ after })
            : GameStep.Unheld()
      }),
    onSome: (before) => {
      const after = Option.getOrElse(step.next, () => before)
      if (!after.acknowledgement.isCurrent(after.snapshot, at)) {
        return GameStep.Stopped({ before, after, changed: Option.isSome(step.next) })
      }

      const turned =
        before.acknowledgement.state(before.snapshot, since) !==
        before.acknowledgement.state(before.snapshot, at)
      return Option.match(step.next, {
        onSome: (after) => GameStep.Changed({ before, after }),
        onNone: () => (turned ? GameStep.Turned({ game: before }) : GameStep.Kept({ before }))
      })
    }
  })
}

/**
 * A snapshot taken by the slate: a repeat of a finished game's final is not observed, one behind it is observed as
 * behind, and any other is taken by the game's acknowledgement, or starts one.
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
    const current = Option.orElse(heldIn(guarded, snapshot.id), () =>
      Option.map(
        final,
        (over): Held => ({ snapshot: over, acknowledgement: Acknowledgement.first(from, at) })
      )
    )
    const step = Option.match(current, {
      onNone: (): ReturnType<Acknowledgement["took"]> => ({
        next: Option.some({ snapshot, acknowledgement: Acknowledgement.first(from, at) }),
        events: [],
        outcome: "taken"
      }),
      onSome: (held) => held.acknowledgement.took(held.snapshot, { snapshot, from }, at)
    })
    const had = Option.map(current, (held) => held.snapshot)
    const took = SlateObservation.Took({ snapshot, from, outcome: step.outcome, had })

    return guarded
      .observe(took)
      .settle(snapshot.id, { since: at, at }, current, step, guarded.playsOf(snapshot.id))
  })
}

/**
 * Game `held`'s tick at its wake instant `at`, as it stood at the last wake `since`: a fall back is observed as a take
 * of the held snapshot, as the poll's.
 */
function ticked(
  advancing: Advancing,
  held: Held,
  instants: { readonly since: DateTime.Utc; readonly at: DateTime.Utc }
): Advancing {
  const id = held.snapshot.id
  const step = held.acknowledgement.ticked(held.snapshot, instants.at)
  const fellBack = Option.filter(step.next, () => step.fellBack)
  const observed = Option.match(fellBack, {
    onNone: () => advancing,
    onSome: (after) =>
      advancing.observe(
        SlateObservation.Took({
          snapshot: after.snapshot,
          from: after.acknowledgement.from,
          outcome: "fellBack",
          had: Option.some(held.snapshot)
        })
      )
  })

  return observed.settle(id, instants, Option.some(held), step, advancing.playsOf(id))
}
