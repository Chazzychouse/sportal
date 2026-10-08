import { GameSnapshot } from "@sportal/domain/Game"
import type { GameEventKind } from "@sportal/domain/GameEvent"
import { Array as Arr, Data, DateTime, Duration, Match, Option } from "effect"
import type { DeliverySource } from "./Delivery.ts"
import type { TookOutcome } from "./SlateObservation.ts"

/**
 * The Hub's acknowledgement of a game's latest word: which feed gave the snapshot the slate shows, when, and a poll held
 * back while the push covers the game. Never on the wire.
 *
 * Every state the game is in is derived from its snapshot, this, and `now` (`state`): upcoming, live, holding (a poll
 * held), stale (live and unheard for `staleAfter`), or over.
 */
export class Acknowledgement extends Data.Class<{
  readonly from: DeliverySource
  readonly heardAt: DateTime.Utc
  /** A poll snapshot ahead of a covered game, held until `until`, when it applies unless the push has caught up. */
  readonly held: Option.Option<{ readonly snapshot: GameSnapshot; readonly until: DateTime.Utc }>
}> {
  /** A live game no snapshot has reached for this long is stale. */
  static readonly staleAfter = Duration.seconds(90)

  /** An upcoming game is current from this long before kickoff. */
  static readonly currentBefore = Duration.minutes(30)

  /** How long a stale game stays current, from when it was last heard. */
  static readonly staleCurrentFor = Duration.minutes(30)

  /**
   * How long a covered game holds a poll snapshot ahead of it before the poll's applies: the push leads the
   * scoreboard on most plays, so a poll ahead of it this long means the push is stuck.
   */
  static readonly fallbackAfter = Duration.seconds(15)

  /** The earliest of `instants`; none when none is given. The one place optional instants are combined. */
  static earliest(instants: Iterable<Option.Option<DateTime.Utc>>): Option.Option<DateTime.Utc> {
    return Arr.match(Arr.getSomes(instants), {
      onEmpty: Option.none<DateTime.Utc>,
      onNonEmpty: (some) => Option.some(some.reduce(DateTime.min))
    })
  }

  /** A game's first snapshot, from feed `from`, always taken. */
  static first(from: DeliverySource, now: DateTime.Utc): Acknowledgement {
    return new Acknowledgement({ from, heardAt: now, held: Option.none() })
  }

  /**
   * Game `game` after a snapshot delivered at `now`, and what happened; none when nothing changes.
   *
   * The `outcome` is `taken`, `behind` (ignored), or `held`. A covered game takes a poll only ahead of it, and only by
   * holding it for `fallbackAfter`: a poll ahead of the held one replaces it, one equal to the game's snapshot
   * refreshes it, and any other is behind. A push applies unless behind in game time, and ends a hold unless the held
   * snapshot is still ahead of it; on any other game, so does a poll. An over game also takes a snapshot ahead of its
   * end (`GameSnapshot#isAheadOfOver`), and is live again. A snapshot taken gives the events of its changes.
   */
  took(
    game: GameSnapshot,
    delivery: { readonly snapshot: GameSnapshot; readonly from: DeliverySource },
    now: DateTime.Utc
  ): {
    readonly next: Option.Option<{
      readonly snapshot: GameSnapshot
      readonly acknowledgement: Acknowledgement
    }>
    readonly events: ReadonlyArray<GameEventKind>
    readonly outcome: TookOutcome
  } {
    const { snapshot, from } = delivery
    if (from === "poll" && this.covers(game, now)) return this.polledWhileCovered(game, snapshot, now)
    if (GameSnapshot.gameTime(snapshot, game) < 0 && !resumedBy(game, snapshot)) return behind

    const held = Option.filter(
      this.held,
      (held) => snapshot.progress() === "live" && held.snapshot.isAheadOf(snapshot)
    )
    const acknowledgement = new Acknowledgement({ from, heardAt: now, held })
    return {
      next: Option.some({ snapshot, acknowledgement }),
      events: snapshot.eventsSince(game),
      outcome: "taken"
    }
  }

  /**
   * Game `game` at `now` with nothing new: a held snapshot falls back at `until`, as a poll's, saying its events. None
   * when that changes nothing; going stale changes nothing stored, since `state` derives it.
   */
  ticked(
    game: GameSnapshot,
    now: DateTime.Utc
  ): Omit<ReturnType<Acknowledgement["took"]>, "outcome"> & { readonly fellBack: boolean } {
    const due = Option.filter(this.held, ({ until }) => DateTime.isGreaterThanOrEqualTo(now, until))

    return Option.match(due, {
      onNone: () => ({ next: Option.none(), events: [], fellBack: false }),
      onSome: ({ snapshot }) => ({
        // The held snapshot applies as the poll's, heard now: the push is no longer followed, and nothing is held.
        next: Option.some({ snapshot, acknowledgement: Acknowledgement.first("poll", now) }),
        events: snapshot.eventsSince(game),
        fellBack: true
      })
    })
  }

  /** Live or holding at `now`, its snapshot from the push. */
  covers(game: GameSnapshot, now: DateTime.Utc): boolean {
    const state = this.state(game, now)
    return (state === "Live" || state === "Holding") && this.from === "push"
  }

  /**
   * The next instant strictly after `now` at which game `game` changes with no new delivery: falling back, going
   * stale, or entering or leaving the live-feed window (`isCurrent`). None when only a delivery can change it.
   */
  dueAfter(game: GameSnapshot, now: DateTime.Utc): Option.Option<DateTime.Utc> {
    const deadlines = Match.value(game.progress()).pipe(
      Match.when("upcoming", () => [
        Option.some(DateTime.subtractDuration(game.kickoff, Acknowledgement.currentBefore))
      ]),
      Match.when("live", () => [
        Option.map(this.held, ({ until }) => until),
        Option.some(DateTime.addDuration(this.heardAt, Acknowledgement.staleAfter)),
        Option.some(DateTime.addDuration(this.heardAt, Acknowledgement.staleCurrentFor))
      ]),
      Match.when("over", () => []),
      Match.exhaustive
    )
    return Acknowledgement.earliest(
      deadlines.map((deadline) => Option.filter(deadline, (at) => DateTime.isLessThan(now, at)))
    )
  }

  /** When game `game` was last heard while it is live; none while it is upcoming or over. */
  updatedAt(game: GameSnapshot): Option.Option<DateTime.Utc> {
    return game.progress() === "live" ? Option.some(this.heardAt) : Option.none()
  }

  /** Live or holding, stale for less than `staleCurrentFor`, or upcoming with kickoff within `currentBefore` of `now`. */
  isCurrent(game: GameSnapshot, now: DateTime.Utc): boolean {
    return Match.value(this.state(game, now)).pipe(
      Match.when("Upcoming", () => game.isLiveOrKicksOffWithin(Acknowledgement.currentBefore, now)),
      Match.when("Live", () => true),
      Match.when("Holding", () => true),
      Match.when("Stale", () =>
        DateTime.isLessThan(now, DateTime.addDuration(this.heardAt, Acknowledgement.staleCurrentFor))
      ),
      Match.when("Over", () => false),
      Match.exhaustive
    )
  }

  /**
   * Where game `game` is at `now`: its progress, and while it is live, holding when a poll is held, stale when it has
   * not been heard for `staleAfter`, and live otherwise. Derived, never stored; its values are the game-state gauge's
   * labels.
   */
  state(game: GameSnapshot, now: DateTime.Utc): "Upcoming" | "Live" | "Holding" | "Stale" | "Over" {
    const unheard = DateTime.isGreaterThanOrEqualTo(
      now,
      DateTime.addDuration(this.heardAt, Acknowledgement.staleAfter)
    )
    return Match.value(game.progress()).pipe(
      Match.when("upcoming", () => "Upcoming" as const),
      Match.when("live", () =>
        Option.match(this.held, {
          onSome: () => "Holding" as const,
          onNone: () => (unheard ? ("Stale" as const) : ("Live" as const))
        })
      ),
      Match.when("over", () => "Over" as const),
      Match.exhaustive
    )
  }

  /**
   * A covered game after a poll: held when ahead of what the game waits on (the held snapshot, or its own), a refresh
   * when equal to its snapshot, and behind otherwise.
   */
  private polledWhileCovered(
    game: GameSnapshot,
    snapshot: GameSnapshot,
    now: DateTime.Utc
  ): ReturnType<Acknowledgement["took"]> {
    const waitingOn = Option.match(this.held, { onNone: () => game, onSome: (held) => held.snapshot })
    if (snapshot.isAheadOf(waitingOn)) {
      const until = Option.match(this.held, {
        onNone: () => DateTime.addDuration(now, Acknowledgement.fallbackAfter),
        onSome: (held) => held.until
      })
      const acknowledgement = new Acknowledgement({
        ...this,
        heardAt: now,
        held: Option.some({ snapshot, until })
      })
      return { next: Option.some({ snapshot: game, acknowledgement }), events: [], outcome: "held" }
    }
    if (snapshot.isAheadOf(game) || game.isAheadOf(snapshot)) return behind

    const acknowledgement = new Acknowledgement({ ...this, heardAt: now })
    return { next: Option.some({ snapshot: game, acknowledgement }), events: [], outcome: "taken" }
  }
}

/** A snapshot behind the game: nothing changes. */
const behind: ReturnType<Acknowledgement["took"]> = { next: Option.none(), events: [], outcome: "behind" }

/** Over, and `snapshot` is ahead of its end: overtime after a spurious final, or a postponed game resuming. */
function resumedBy(game: GameSnapshot, snapshot: GameSnapshot): boolean {
  return game.progress() === "over" && snapshot.isAheadOfOver(game)
}
