import { Cause, Data, DateTime, Effect, Option } from "effect"
import { Delivery, type DeliverySource } from "./Delivery.ts"
import type { GameId, GameSnapshot } from "./Game.ts"
import { GameEvent, type GameEventKind } from "./GameEvent.ts"
import type { LeagueId } from "./League.ts"
import { LiveGame } from "./LiveGame.ts"
import type { RecentPlays } from "./RecentPlays.ts"

/**
 * The slate: the last frame's `seq`, each league's last listing, every current game's live game, taken from push and
 * poll deliveries in arrival order, and `reached`, the instant it has ticked to: every wake time at or before it has
 * been ticked.
 */
export class Slate extends Data.Class<{
  readonly seq: Option.Option<number>
  readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly live: ReadonlyMap<GameId, LiveGame>
  readonly reached: Option.Option<DateTime.Utc>
}> {
  static readonly empty: Slate = new Slate({
    seq: Option.none(),
    listed: new Map(),
    live: new Map(),
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
    return leagues.flatMap((league) => asFolded(this.listed.get(league) ?? [], this.live))
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
    const listed = [...this.listed.values()].flatMap((games) => asFolded(games, this.live))
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
    return this.live === that.live && this.listed === that.listed
  }

  /** Ticks to `at`, then runs `then` on what the ticks left, as frame `seq` (none keeps the last). */
  private advance(
    at: DateTime.Utc,
    seq: Option.Option<number>,
    then: (ticked: Advanced) => Effect.Effect<Folded>
  ): Effect.Effect<Taken> {
    const from = Option.getOrElse(this.reached, () => at)
    return tickTo({ live: this.live, events: [], observations: [] }, from, at).pipe(
      Effect.flatMap(then),
      Effect.map((folded) => ({
        next: new Slate({
          seq: Option.orElse(seq, () => this.seq),
          listed: folded.listed,
          live: folded.live,
          reached: Option.some(DateTime.max(from, at))
        }),
        events: folded.events,
        observations: folded.observations
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

/** What one take or tick did to one game, for telemetry only. */
export type SlateObservation = Data.TaggedEnum<{
  /** A snapshot was taken, ignored as behind, or kept (a tied poll that refreshed a pushed snapshot). */
  Took: {
    readonly snapshot: GameSnapshot
    readonly from: DeliverySource
    readonly outcome: "taken" | "behind" | "kept"
    readonly had: Option.Option<GameSnapshot>
  }
  Started: { readonly liveGame: LiveGame; readonly at: DateTime.Utc }
  Changed: { readonly before: LiveGame; readonly after: LiveGame; readonly at: DateTime.Utc }
  Stopped: { readonly liveGame: LiveGame; readonly at: DateTime.Utc }
  Dropped: { readonly game: GameId }
  /** A game's take or tick raised a defect; the game kept its last good live game. `snapshot` is the one at hand. */
  Raised: { readonly snapshot: GameSnapshot; readonly cause: Cause.Cause<never>; readonly by: string }
}>
export const SlateObservation = Data.taggedEnum<SlateObservation>()

/** Every current game's live game, and the events and observations advancing the slate has made so far. */
type Advanced = {
  readonly live: ReadonlyMap<GameId, LiveGame>
  readonly events: ReadonlyArray<GameEvent>
  readonly observations: ReadonlyArray<SlateObservation>
}

/** `Advanced`, with each league's last listing. */
type Folded = Advanced & { readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>> }

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
            guarded(acc, liveGame.snapshot, "a tick", () =>
              settled(acc, liveGame.snapshot.id, due, Option.some(liveGame), { liveGame: liveGame.tick(due) })
            )
        ).pipe(Effect.flatMap((ticked) => tickTo(ticked, due, at)))
    }
  )
}

/** The earliest instant after `from` at which a live game changes with no new frame. */
function dueAfter(live: ReadonlyMap<GameId, LiveGame>, from: DateTime.Utc): Option.Option<DateTime.Utc> {
  return LiveGame.earliest([...live.values()].map((liveGame) => liveGame.dueAfter(from)))
}

function applied(folded: Folded, delivery: Delivery, at: DateTime.Utc): Effect.Effect<Folded> {
  const { listed } = folded
  return Delivery.match(delivery, {
    Listing: ({ league, games }) =>
      Effect.reduce(
        games,
        (): Advanced => folded,
        (acc, snapshot) => snapshotTaken(acc, snapshot, "poll", at)
      ).pipe(Effect.map((after) => ({ ...after, listed: new Map(listed).set(league, games) }))),
    Snapshot: ({ snapshot, from }) =>
      snapshotTaken(folded, snapshot, from, at).pipe(Effect.map((after) => ({ ...after, listed }))),
    Plays: (plays) =>
      Option.match(Option.fromNullishOr(folded.live.get(plays.game)), {
        onNone: () =>
          Effect.succeed({
            ...folded,
            observations: [...folded.observations, SlateObservation.Dropped({ game: plays.game })]
          }),
        onSome: (liveGame) =>
          guarded(folded, liveGame.snapshot, "a delivery", () =>
            settled(folded, plays.game, at, Option.some(liveGame), liveGame.take(plays, at))
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
    const current = Option.fromNullishOr(advanced.live.get(snapshot.id))
    const step = Option.match(current, {
      onNone: () => ({ liveGame: Option.some(LiveGame.start(snapshot, from, at)) }),
      onSome: (liveGame) => liveGame.take(Delivery.cases.Snapshot.make({ snapshot, from }), at)
    })
    const took = SlateObservation.Took({
      snapshot,
      from,
      outcome: Option.match(step.liveGame, {
        onNone: () => "behind",
        onSome: (liveGame) => (liveGame.snapshot === snapshot ? "taken" : "kept")
      }),
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
 * game, if any, while it is current, and lets it go once it is not. A game that was never held and is not current is
 * not held, and nothing is reported of it.
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
            events,
            observations
          }
        }
        if (Option.isNone(current)) return advanced
        return {
          live: new Map([...advanced.live].filter(([game]) => game !== id)),
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

/** Each listed game, in listed order, as the slate has it, or as listed when it has none. */
function asFolded(
  listed: ReadonlyArray<GameSnapshot>,
  live: ReadonlyMap<GameId, LiveGame>
): ReadonlyArray<GameSnapshot> {
  return listed.map((game) =>
    Option.fromNullishOr(live.get(game.id)).pipe(
      Option.match({ onNone: () => game, onSome: (liveGame) => liveGame.snapshot })
    )
  )
}
