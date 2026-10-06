import { Cause, Data, DateTime, Effect, Equal, Option } from "effect"
import { Delivery, type DeliverySource } from "./Delivery.ts"
import type { GameId, GameSnapshot } from "./Game.ts"
import type { GameEvent } from "./GameEvent.ts"
import type { LeagueId } from "./League.ts"
import { LiveGame } from "./LiveGame.ts"

/**
 * The fold of every delivery, in order: the last frame's `seq`, each league's last listing, every current game's live
 * game, and `reached`, the instant it has ticked to: every wake time at or before it has been ticked.
 */
export class LiveGames extends Data.Class<{
  readonly seq: Option.Option<number>
  readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly live: ReadonlyMap<GameId, LiveGame>
  readonly reached: Option.Option<DateTime.Utc>
}> {
  static readonly empty: LiveGames = new LiveGames({
    seq: Option.none(),
    listed: new Map(),
    live: new Map(),
    reached: Option.none()
  })

  /**
   * Ticks every game due after `reached` and at or before `at`, then applies `delivery` if any, as frame `seq`
   * (none keeps the last). A tick never goes back. A step that raises a defect keeps the game's last good live game
   * and reports `Raised`.
   */
  step(
    delivery: Option.Option<Delivery>,
    at: DateTime.Utc,
    seq: Option.Option<number>
  ): Effect.Effect<{ readonly next: LiveGames; readonly reports: ReadonlyArray<FoldReport> }> {
    const from = Option.getOrElse(this.reached, () => at)
    return tickTo({ live: this.live, reports: [] }, from, at).pipe(
      Effect.flatMap((ticked) =>
        Option.match(delivery, {
          onNone: () => Effect.succeed({ listed: this.listed, ...ticked }),
          onSome: (delivery) => applied(this.listed, ticked, delivery, at)
        })
      ),
      Effect.map((stepped) => ({
        next: new LiveGames({
          seq: Option.orElse(seq, () => this.seq),
          listed: stepped.listed,
          live: stepped.live,
          reached: Option.some(DateTime.max(from, at))
        }),
        reports: stepped.reports
      }))
    )
  }

  /** The earliest instant after `reached` at which a live game changes with no new frame. */
  earliestDue(): Option.Option<DateTime.Utc> {
    return Option.flatMap(this.reached, (from) => dueAfter(this.live, from))
  }

  /** Each listed game in `leagues`, leagues in order, as the fold has it. */
  slate(leagues: ReadonlyArray<LeagueId>): ReadonlyArray<GameSnapshot> {
    return leagues.flatMap((league) => asFolded(this.listed.get(league) ?? [], this.live))
  }

  /** Every listed game as the fold has it, then live games no listing holds. */
  games(): ReadonlyArray<GameSnapshot> {
    const listed = [...this.listed.values()].flatMap((games) => asFolded(games, this.live))
    const unlisted = [...this.live.values()]
      .map(({ snapshot }) => snapshot)
      .filter((snapshot) => !listed.some(({ id }) => id === snapshot.id))
    return [...listed, ...unlisted]
  }

  /** Whether `that` publishes the same: a step that changed nothing hands back the same maps. `reached` is ignored. */
  publishesSameAs(that: LiveGames): boolean {
    return this.live === that.live && this.listed === that.listed && Equal.equals(this.seq, that.seq)
  }
}

/** What one step did to one game, for telemetry to tell. */
export type FoldReport = Data.TaggedEnum<{
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
  Happened: { readonly snapshot: GameSnapshot; readonly event: GameEvent }
  Dropped: { readonly game: GameId }
  /** A step raised a defect; the game kept its last good live game. `snapshot` is the one at hand. */
  Raised: { readonly snapshot: GameSnapshot; readonly cause: Cause.Cause<never>; readonly by: string }
}>
export const FoldReport = Data.taggedEnum<FoldReport>()

/** Every current game's live game, and what the steps so far did. */
type Stepped = { readonly live: ReadonlyMap<GameId, LiveGame>; readonly reports: ReadonlyArray<FoldReport> }

/**
 * Ticks, in wake order, every game due after `from` and at or before `at`, each at its own wake instant; games due at
 * the same instant tick together.
 */
function tickTo(stepped: Stepped, from: DateTime.Utc, at: DateTime.Utc): Effect.Effect<Stepped> {
  return Option.match(
    Option.filter(dueAfter(stepped.live, from), (due) => DateTime.isLessThanOrEqualTo(due, at)),
    {
      onNone: () => Effect.succeed(stepped),
      onSome: (due) =>
        Effect.reduce(
          [...stepped.live.values()].filter((liveGame) =>
            Option.exists(liveGame.dueAfter(from), (instant) => DateTime.Equivalence(instant, due))
          ),
          () => stepped,
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

function applied(
  listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>,
  stepped: Stepped,
  delivery: Delivery,
  at: DateTime.Utc
): Effect.Effect<Stepped & { readonly listed: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>> }> {
  return Delivery.match(delivery, {
    Listing: ({ league, games }) =>
      Effect.reduce(
        games,
        () => stepped,
        (acc, snapshot) => snapshotTaken(acc, snapshot, "poll", at)
      ).pipe(Effect.map((after) => ({ ...after, listed: new Map(listed).set(league, games) }))),
    Snapshot: ({ snapshot, from }) =>
      snapshotTaken(stepped, snapshot, from, at).pipe(Effect.map((after) => ({ ...after, listed }))),
    Plays: (plays) =>
      Option.match(Option.fromNullishOr(stepped.live.get(plays.game)), {
        onNone: () =>
          Effect.succeed({
            ...stepped,
            listed,
            reports: [...stepped.reports, FoldReport.Dropped({ game: plays.game })]
          }),
        onSome: (liveGame) =>
          guarded(stepped, liveGame.snapshot, "a delivery", () =>
            settled(stepped, plays.game, at, Option.some(liveGame), liveGame.take(plays, at))
          ).pipe(Effect.map((after) => ({ ...after, listed })))
      })
  })
}

function snapshotTaken(
  stepped: Stepped,
  snapshot: GameSnapshot,
  from: DeliverySource,
  at: DateTime.Utc
): Effect.Effect<Stepped> {
  return guarded(stepped, snapshot, "a delivery", () => {
    const current = Option.fromNullishOr(stepped.live.get(snapshot.id))
    const step = Option.match(current, {
      onNone: () => ({ liveGame: Option.some(LiveGame.start(snapshot, from, at)) }),
      onSome: (liveGame) => liveGame.take(Delivery.cases.Snapshot.make({ snapshot, from }), at)
    })
    const took = FoldReport.Took({
      snapshot,
      from,
      outcome: Option.match(step.liveGame, {
        onNone: () => "behind",
        onSome: (liveGame) => (liveGame.snapshot === snapshot ? "taken" : "kept")
      }),
      had: Option.map(current, (liveGame) => liveGame.snapshot)
    })
    return settled({ ...stepped, reports: [...stepped.reports, took] }, snapshot.id, at, current, step)
  })
}

/**
 * Game `id` after a step at `at` from `current` (none for a game the fold does not hold): holds the step's new live
 * game, if any, while it is current, and lets it go once it is not. A game that was never held and is not current is
 * not held, and nothing is reported of it.
 */
function settled(
  stepped: Stepped,
  id: GameId,
  at: DateTime.Utc,
  current: Option.Option<LiveGame>,
  step: { readonly liveGame: Option.Option<LiveGame>; readonly events?: ReadonlyArray<GameEvent> }
): Stepped {
  return Option.match(
    Option.orElse(step.liveGame, () => current),
    {
      onNone: () => stepped,
      onSome: (after) => {
        const reports = [
          ...stepped.reports,
          ...Option.match(step.liveGame, {
            onNone: () => [],
            onSome: () =>
              Option.match(current, {
                onNone: () => [FoldReport.Started({ liveGame: after, at })],
                onSome: (before) => [FoldReport.Changed({ before, after, at })]
              })
          }),
          ...(step.events ?? []).map((event) => FoldReport.Happened({ snapshot: after.snapshot, event }))
        ]
        if (after.isCurrent(at)) {
          return {
            live: Option.isSome(step.liveGame) ? new Map(stepped.live).set(id, after) : stepped.live,
            reports
          }
        }
        if (Option.isNone(current)) return stepped
        return {
          live: new Map([...stepped.live].filter(([game]) => game !== id)),
          reports: [...reports, FoldReport.Stopped({ liveGame: after, at })]
        }
      }
    }
  )
}

/** Runs one game's pure step; a defect keeps what came before and reports it with the snapshot at hand. */
function guarded(
  stepped: Stepped,
  snapshot: GameSnapshot,
  by: string,
  step: () => Stepped
): Effect.Effect<Stepped> {
  return Effect.sync(step).pipe(
    Effect.catchDefect((defect) =>
      Effect.succeed({
        ...stepped,
        reports: [...stepped.reports, FoldReport.Raised({ snapshot, cause: Cause.die(defect), by })]
      })
    )
  )
}

/** Each listed game, in listed order, as the fold has it, or as listed when it has none. */
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
