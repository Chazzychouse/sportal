import { GameSnapshot } from "@sportal/domain/Game"
import type { GameEventKind } from "@sportal/domain/GameEvent"
import { Play } from "@sportal/domain/Play"
import { Array as Arr, Data, DateTime, Duration, Equal, Option } from "effect"
import type { Delivery, DeliverySource } from "./Delivery.ts"

/**
 * Where a live game is: upcoming, live (last updated at), holding (live, with a poll snapshot ahead of it held until
 * `until`), stale (last updated at), or over.
 */
export type LiveGameState = Data.TaggedEnum<{
  Upcoming: object
  Live: { readonly updatedAt: DateTime.Utc }
  /** Live, followed by the push, with a poll snapshot ahead of it held until `until`. */
  Holding: { readonly updatedAt: DateTime.Utc; readonly held: GameSnapshot; readonly until: DateTime.Utc }
  Stale: { readonly updatedAt: DateTime.Utc }
  Over: object
}>
export const LiveGameState = Data.taggedEnum<LiveGameState>()

/** One game as the Hub follows it: its latest snapshot, the feed that gave it, its state, and its plays. Built from deliveries. */
export class LiveGame extends Data.Class<{
  readonly snapshot: GameSnapshot
  readonly from: DeliverySource
  readonly state: LiveGameState
  /** In `Play.order`. */
  readonly plays: ReadonlyArray<Play>
}> {
  /** A live game no snapshot has reached for this long is stale. */
  static readonly staleAfter = Duration.seconds(90)

  /** An upcoming game is current from this long before kickoff. */
  static readonly currentBefore = Duration.minutes(30)

  /** How long a stale game stays current, from its last update. */
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
  static start(snapshot: GameSnapshot, from: DeliverySource, now: DateTime.Utc): LiveGame {
    return new LiveGame({
      snapshot,
      from,
      state: stateOf(snapshot, now),
      plays: []
    })
  }

  /**
   * The live game after a `Snapshot` or `Plays` delivery at `now`, and what happened; none when nothing changes.
   *
   * A snapshot's `outcome` is `taken`, `behind` (ignored), or `held`. A covered game takes a poll only ahead of it,
   * and only by holding it for `fallbackAfter`: a poll ahead of the held one replaces it, one equal to the game's
   * snapshot refreshes it, and any other is behind. A push applies unless behind in game time, and ends a hold unless
   * the held snapshot is still ahead of it; on any other game, so does a poll. An over game also takes a snapshot ahead
   * of its end (`GameSnapshot#isAheadOfOver`), and is live again. A snapshot gives the events of its
   * changes; a `Plays` delivery replaces the list and gives only the play events of its new plays.
   */
  take(
    delivery: Extract<Delivery, { readonly _tag: "Snapshot" }>,
    now: DateTime.Utc
  ): {
    readonly liveGame: Option.Option<LiveGame>
    readonly events: ReadonlyArray<GameEventKind>
    readonly outcome: TookOutcome
  }
  take(
    delivery: Extract<Delivery, { readonly _tag: "Plays" }>,
    now: DateTime.Utc
  ): { readonly liveGame: Option.Option<LiveGame>; readonly events: ReadonlyArray<GameEventKind> }
  take(delivery: Extract<Delivery, { readonly _tag: "Snapshot" | "Plays" }>, now: DateTime.Utc) {
    if (delivery._tag === "Plays") {
      const plays = delivery.plays.toSorted(Play.order)
      if (Equal.equals(plays, this.plays)) return { liveGame: Option.none(), events: [] }
      const events = Play.eventsSince(this.plays, plays)
      return { liveGame: Option.some(new LiveGame({ ...this, plays })), events }
    }
    const { snapshot, from } = delivery
    if (from === "poll" && this.isCovered()) return this.polledWhileCovered(snapshot, now)
    if (GameSnapshot.gameTime(snapshot, this.snapshot) < 0 && !this.resumedBy(snapshot)) return behind
    const state = stateOf(snapshot, now)
    const holdingStill =
      LiveGameState.$is("Holding")(this.state) &&
      LiveGameState.$is("Live")(state) &&
      this.state.held.isAheadOf(snapshot)
    const taken = holdingStill
      ? LiveGameState.Holding({ updatedAt: now, held: this.state.held, until: this.state.until })
      : state
    const liveGame = new LiveGame({ snapshot, from, state: taken, plays: this.plays })

    return { liveGame: Option.some(liveGame), events: snapshot.eventsSince(this.snapshot), outcome: "taken" }
  }

  /**
   * The live game at `now` with nothing new: a holding game falls back to its held snapshot at `until`, as a poll's,
   * saying its events; a live one goes stale once its stale time has passed. None when that changes nothing.
   */
  tick(now: DateTime.Utc): {
    readonly liveGame: Option.Option<LiveGame>
    readonly events: ReadonlyArray<GameEventKind>
    readonly fellBack: boolean
  } {
    const unchanged = { liveGame: Option.none(), events: [], fellBack: false }

    return LiveGameState.$match(this.state, {
      Holding: ({ held, until }) => {
        if (DateTime.isLessThan(now, until)) return unchanged
        const state = stateOf(held, now)
        const liveGame = new LiveGame({ ...this, snapshot: held, from: "poll", state })
        return { liveGame: Option.some(liveGame), events: held.eventsSince(this.snapshot), fellBack: true }
      },
      Live: ({ updatedAt }) => {
        if (DateTime.isLessThan(now, DateTime.addDuration(updatedAt, LiveGame.staleAfter))) return unchanged
        const stale = new LiveGame({ ...this, state: LiveGameState.Stale({ updatedAt }) })
        return { ...unchanged, liveGame: Option.some(stale) }
      },
      Upcoming: () => unchanged,
      Stale: () => unchanged,
      Over: () => unchanged
    })
  }

  /** Live or holding, its snapshot from the push. */
  isCovered(): boolean {
    return (
      (LiveGameState.$is("Live")(this.state) || LiveGameState.$is("Holding")(this.state)) &&
      this.from === "push"
    )
  }

  /**
   * When this live game next changes with no new frame, strictly after `now`: falling back, going stale, or entering or
   * leaving the live-feed window (`isCurrent`). None when only a delivery can change it.
   */
  dueAfter(now: DateTime.Utc): Option.Option<DateTime.Utc> {
    return LiveGameState.$match(this.state, {
      Upcoming: () => Option.some(DateTime.subtractDuration(this.snapshot.kickoff, LiveGame.currentBefore)),
      Live: ({ updatedAt }) => Option.some(DateTime.addDuration(updatedAt, LiveGame.staleAfter)),
      Holding: ({ until }) => Option.some(until),
      Stale: ({ updatedAt }) => Option.some(DateTime.addDuration(updatedAt, LiveGame.staleCurrentFor)),
      Over: () => Option.none()
    }).pipe(Option.filter((at) => DateTime.isLessThan(now, at)))
  }

  /** When a live, holding, or stale game was last updated; none for an upcoming or over game. */
  updatedAt(): Option.Option<DateTime.Utc> {
    return LiveGameState.$match(this.state, {
      Upcoming: () => Option.none(),
      Live: ({ updatedAt }) => Option.some(updatedAt),
      Holding: ({ updatedAt }) => Option.some(updatedAt),
      Stale: ({ updatedAt }) => Option.some(updatedAt),
      Over: () => Option.none()
    })
  }

  /** Live or holding, stale for less than `staleCurrentFor`, or upcoming with kickoff within `currentBefore` of `now`. */
  isCurrent(now: DateTime.Utc): boolean {
    return LiveGameState.$match(this.state, {
      Upcoming: () =>
        DateTime.isLessThanOrEqualTo(
          this.snapshot.kickoff,
          DateTime.addDuration(now, LiveGame.currentBefore)
        ),
      Live: () => true,
      Holding: () => true,
      Stale: ({ updatedAt }) =>
        DateTime.isLessThan(now, DateTime.addDuration(updatedAt, LiveGame.staleCurrentFor)),
      Over: () => false
    })
  }

  /** Over, and `snapshot` is ahead of its end: overtime after a spurious final, or a postponed game resuming. */
  private resumedBy(snapshot: GameSnapshot): boolean {
    return LiveGameState.$is("Over")(this.state) && snapshot.isAheadOfOver(this.snapshot)
  }

  /**
   * A covered game after a poll: held when ahead of what the game waits on (the held snapshot, or its own), a refresh
   * when equal to its snapshot, and behind otherwise.
   */
  private polledWhileCovered(
    snapshot: GameSnapshot,
    now: DateTime.Utc
  ): {
    readonly liveGame: Option.Option<LiveGame>
    readonly events: ReadonlyArray<GameEventKind>
    readonly outcome: TookOutcome
  } {
    const holding = LiveGameState.$is("Holding")(this.state) ? Option.some(this.state) : Option.none()
    const waitingOn = Option.match(holding, { onNone: () => this.snapshot, onSome: ({ held }) => held })
    if (snapshot.isAheadOf(waitingOn)) {
      const until = Option.match(holding, {
        onNone: () => DateTime.addDuration(now, LiveGame.fallbackAfter),
        onSome: ({ until }) => until
      })
      const state = LiveGameState.Holding({ updatedAt: now, held: snapshot, until })
      return { liveGame: Option.some(new LiveGame({ ...this, state })), events: [], outcome: "held" }
    }
    if (snapshot.isAheadOf(this.snapshot) || this.snapshot.isAheadOf(snapshot)) return behind
    const state = Option.match(holding, {
      onNone: () => LiveGameState.Live({ updatedAt: now }),
      onSome: ({ held, until }) => LiveGameState.Holding({ updatedAt: now, held, until })
    })
    return { liveGame: Option.some(new LiveGame({ ...this, state })), events: [], outcome: "taken" }
  }
}

/** What taking a snapshot did: taken, ignored as behind, or held by a covered game. */
export type TookOutcome = "taken" | "behind" | "held"

/** A snapshot behind the game: nothing changes. */
const behind: {
  readonly liveGame: Option.Option<LiveGame>
  readonly events: ReadonlyArray<GameEventKind>
  readonly outcome: "behind"
} = { liveGame: Option.none(), events: [], outcome: "behind" }

function stateOf(snapshot: GameSnapshot, now: DateTime.Utc): LiveGameState {
  switch (snapshot.progress()) {
    case "upcoming":
      return LiveGameState.Upcoming()
    case "live":
      return LiveGameState.Live({ updatedAt: now })
    case "over":
      return LiveGameState.Over()
  }
}
