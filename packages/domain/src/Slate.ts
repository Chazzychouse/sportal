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
        () => ({ listed: this.listed, ...ticked }),
        (acc, delivery) => applied(acc, delivery, frame.at)
      )
    )
  }

  /** Ticks every game due after `reached` and at or before `now`, with no frame: `seq` stays as it was. */
  tick(now: DateTime.Utc): Effect.Effect<Taken> {
    return this.advance(now, Option.none(), (ticked) => Effect.succeed({ listed: this.listed, ...ticked }))
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
        return plays.length === 0 ? [] : [[id, plays.slice(-recentPlayCount)] as const]
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
    then: (ticked: Advanced) => Effect.Effect<Listed>
  ): Effect.Effect<Taken> {
    const from = Option.getOrElse(this.reached, () => at)
    return tickTo({ live: this.live, finished: this.finished, events: [], observations: [] }, from, at).pipe(
      Effect.flatMap(then),
      Effect.map((step) => ({
        next: new Slate({
          seq: Option.orElse(seq, () => this.seq),
          listed: step.listed,
          live: step.live,
          finished: step.finished,
          reached: Option.some(DateTime.max(from, at))
        }),
        events: step.events,
        observations: step.observations
      }))
    )
  }
}

/** How many of a game's plays `recentPlays` keeps: its last ten. */
const recentPlayCount = 10

/** What one take or tick did: the next slate, the game events it said, and what telemetry tells of it. */
export type Taken = {
  readonly next: Slate
  readonly events: ReadonlyArray<GameEvent>
  readonly observations: ReadonlyArray<SlateObservation>
}

/**
 * Every current game's live game, each game seen to finish, and the events and observations advancing the slate has
 * made so far.
 */
type Advanced = {
  readonly live: ReadonlyMap<GameId, LiveGame>
  readonly finished: ReadonlyMap<GameId, GameSnapshot>
  readonly events: ReadonlyArray<GameEvent>
  readonly observations: ReadonlyArray<SlateObservation>
}

/** `Advanced`, with each league's last listing. */
type Listed = Advanced & { readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>> }

/**
 * Ticks, in wake order, every game due after `from` and at or before `at`, each at its own wake instant; games due at
 * the same instant tick together.
 */
function tickTo(advanced: Advanced, from: DateTime.Utc, at: DateTime.Utc): Effect.Effect<Advanced> {
  return Option.match(
    Option.filter(dueAfter(advanced.live, from), (due) => DateTime.isLessThanOrEqualTo(due, at)),
    {
      onNone: () => Effect.succeed(advanced),
      onSome: (due) =>
        Effect.reduce(
          [...advanced.live.values()].filter((liveGame) =>
            Option.exists(liveGame.dueAfter(from), (instant) => DateTime.Equivalence(instant, due))
          ),
          () => advanced,
          (acc, liveGame) =>
            guarded(acc, liveGame.snapshot, "a tick", () => {
              const step = liveGame.tick(due)
              const fellBack = Option.filter(step.liveGame, () => step.fellBack).pipe(
                Option.map((after) =>
                  SlateObservation.Took({
                    snapshot: after.snapshot,
                    from: after.from,
                    outcome: "fellBack",
                    had: Option.some(liveGame.snapshot)
                  })
                )
              )
              return settled(
                { ...acc, observations: [...acc.observations, ...Option.toArray(fellBack)] },
                liveGame.snapshot.id,
                due,
                Option.some(liveGame),
                step
              )
            })
        ).pipe(Effect.flatMap((ticked) => tickTo(ticked, due, at)))
    }
  )
}

/** The earliest instant after `from` at which a live game changes with no new frame. */
function dueAfter(live: ReadonlyMap<GameId, LiveGame>, from: DateTime.Utc): Option.Option<DateTime.Utc> {
  return LiveGame.earliest([...live.values()].map((liveGame) => liveGame.dueAfter(from)))
}

function applied(step: Listed, delivery: Delivery, at: DateTime.Utc): Effect.Effect<Listed> {
  const { listed } = step
  return Delivery.match(delivery, {
    Listing: ({ league, games }) =>
      Effect.reduce(
        games,
        (): Advanced => step,
        (acc, snapshot) => snapshotTaken(acc, snapshot, "poll", at)
      ).pipe(
        Effect.map((after) => {
          const relisted = new Map(listed).set(league, games)
          return { ...after, listed: relisted, finished: stillListed(after.finished, relisted) }
        })
      ),
    Snapshot: ({ snapshot, from }) =>
      snapshotTaken(step, snapshot, from, at).pipe(Effect.map((after) => ({ ...after, listed }))),
    Plays: (plays) =>
      Option.match(Option.fromNullishOr(step.live.get(plays.game)), {
        onNone: () =>
          Effect.succeed({
            ...step,
            observations: [...step.observations, SlateObservation.Dropped({ game: plays.game })]
          }),
        onSome: (liveGame) =>
          guarded(step, liveGame.snapshot, "a delivery", () =>
            settled(step, plays.game, at, Option.some(liveGame), liveGame.take(plays, at))
          ).pipe(Effect.map((after) => ({ ...after, listed })))
      })
  })
}

function snapshotTaken(
  advanced: Advanced,
  snapshot: GameSnapshot,
  from: DeliverySource,
  at: DateTime.Utc
): Effect.Effect<Advanced> {
  return guarded(advanced, snapshot, "a delivery", () => {
    const final = Option.fromNullishOr(advanced.finished.get(snapshot.id))
    // Every poll of a finished game still listed repeats its final; only a different one is worth observing.
    if (Option.exists(final, (over) => Equal.equals(snapshot, over))) return advanced
    if (Option.isSome(final) && !snapshot.isAheadOfOver(final.value)) {
      const ignored = SlateObservation.Took({ snapshot, from, outcome: "behind", had: final })
      return { ...advanced, observations: [...advanced.observations, ignored] }
    }
    // A finished game is taken as the over game it was, so a correction ahead of its final says what it changed.
    const current = Option.orElse(Option.fromNullishOr(advanced.live.get(snapshot.id)), () =>
      Option.map(final, (over) => LiveGame.start(over, from, at))
    )
    const step = Option.match(current, {
      onNone: (): { readonly liveGame: Option.Option<LiveGame>; readonly outcome: TookOutcome } => ({
        liveGame: Option.some(LiveGame.start(snapshot, from, at)),
        outcome: "taken"
      }),
      onSome: (liveGame) => liveGame.take(Delivery.cases.Snapshot.make({ snapshot, from }), at)
    })
    const took = SlateObservation.Took({
      snapshot,
      from,
      outcome: step.outcome,
      had: Option.map(current, (liveGame) => liveGame.snapshot)
    })
    return settled(
      { ...advanced, observations: [...advanced.observations, took] },
      snapshot.id,
      at,
      current,
      step
    )
  })
}

/**
 * Game `id` after a step at `at` from `current` (none for a game the slate does not hold): holds the step's new live
 * game, if any, while it is current, and lets it go once it is not, remembering it as finished when it is over. A game
 * that was never held and is not current is not held, and nothing is reported of it.
 */
function settled(
  advanced: Advanced,
  id: GameId,
  at: DateTime.Utc,
  current: Option.Option<LiveGame>,
  step: { readonly liveGame: Option.Option<LiveGame>; readonly events?: ReadonlyArray<GameEventKind> }
): Advanced {
  return Option.match(
    Option.orElse(step.liveGame, () => current),
    {
      onNone: () => advanced,
      onSome: (after) => {
        const observations = [
          ...advanced.observations,
          ...Option.match(step.liveGame, {
            onNone: () => [],
            onSome: () =>
              Option.match(current, {
                onNone: () => [SlateObservation.Started({ liveGame: after, at })],
                onSome: (before) => [SlateObservation.Changed({ before, after, at })]
              })
          })
        ]
        const events = [
          ...advanced.events,
          ...(step.events ?? []).map((what) => new GameEvent({ game: id, at, what }))
        ]
        if (after.isCurrent(at)) {
          return {
            live: Option.isSome(step.liveGame) ? new Map(advanced.live).set(id, after) : advanced.live,
            finished: advanced.finished,
            events,
            observations
          }
        }
        if (Option.isNone(current)) return advanced
        return {
          live: new Map([...advanced.live].filter(([game]) => game !== id)),
          finished: LiveGameState.$is("Over")(after.state)
            ? new Map(advanced.finished).set(id, after.snapshot)
            : advanced.finished,
          events,
          observations: [...observations, SlateObservation.Stopped({ liveGame: after, at })]
        }
      }
    }
  )
}

/** Runs one game's pure step; a defect keeps what came before and reports it with the snapshot at hand. */
function guarded(
  advanced: Advanced,
  snapshot: GameSnapshot,
  by: string,
  step: () => Advanced
): Effect.Effect<Advanced> {
  return Effect.sync(step).pipe(
    Effect.catchDefect((defect) =>
      Effect.succeed({
        ...advanced,
        observations: [
          ...advanced.observations,
          SlateObservation.Raised({ snapshot, cause: Cause.die(defect), by })
        ]
      })
    )
  )
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
