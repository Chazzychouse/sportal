import { Array as Arr, Data, DateTime, Duration, Equal, Option } from "effect"
import type { Delivery, DeliverySource } from "./Delivery.ts"
import { type GameId, GameSnapshot } from "./Game.ts"
import { fromPlays, type GameEvent } from "./GameEvent.ts"
import { Play } from "./Play.ts"
import { Watchability } from "./Watchability.ts"

/** Where a live game is: upcoming, live (last updated at), stale (last updated at), or over. */
export type LiveGameState = Data.TaggedEnum<{
  Upcoming: object
  Live: { readonly updatedAt: DateTime.Utc }
  Stale: { readonly lastUpdatedAt: DateTime.Utc }
  Over: object
}>
export const LiveGameState = Data.taggedEnum<LiveGameState>()

/**
 * One game as the Hub follows it: its latest snapshot, the feed that gave it, its state, its plays, and its
 * watchability. Folded from deliveries.
 */
export class LiveGame extends Data.Class<{
  readonly snapshot: GameSnapshot
  readonly from: DeliverySource
  readonly state: LiveGameState
  /** In `Play.order`. */
  readonly plays: ReadonlyArray<Play>
  readonly watchability: Watchability
}> {
  /** A live game no snapshot has reached for this long is stale. */
  static readonly staleAfter = Duration.seconds(90)

  /** An upcoming game is current from this long before kickoff. */
  static readonly currentBefore = Duration.minutes(30)

  /** How long a stale game stays current, from its last update. */
  static readonly staleCurrentFor = Duration.minutes(30)

  /** A game's first snapshot, from feed `from`, always taken. */
  static start(snapshot: GameSnapshot, from: DeliverySource, now: DateTime.Utc): LiveGame {
    return new LiveGame({
      snapshot,
      from,
      state: stateOf(snapshot, now),
      plays: [],
      watchability: Watchability.initial(snapshot, now)
    })
  }

  /** Each listed game, in listed order, as the fold has it, or as listed when it has none. */
  static asFolded(
    listed: ReadonlyArray<GameSnapshot>,
    live: ReadonlyMap<GameId, LiveGame>
  ): ReadonlyArray<GameSnapshot> {
    return listed.map((game) =>
      Option.fromNullishOr(live.get(game.id)).pipe(
        Option.match({ onNone: () => game, onSome: (liveGame) => liveGame.snapshot })
      )
    )
  }

  /**
   * The live game after a `Snapshot` or `Plays` delivery at `now`, and what happened; none when nothing changes.
   *
   * A snapshot behind in game time is none. A poll at the same game time as a live game's pushed snapshot only
   * refreshes it: the push wins a tie, since the poll lags it. Once the game has plays, they decide the events they
   * cover (`fromPlays`), and a snapshot gives only the rest. A `Plays` delivery replaces the list.
   */
  take(
    delivery: Data.TaggedEnum.Value<Delivery, "Snapshot" | "Plays">,
    now: DateTime.Utc
  ): { readonly liveGame: Option.Option<LiveGame>; readonly events: ReadonlyArray<GameEvent> } {
    if (delivery._tag === "Plays") {
      const plays = delivery.plays.toSorted(Play.order)
      if (Equal.equals(plays, this.plays)) return { liveGame: Option.none(), events: [] }
      const events = Play.eventsSince(this.plays, plays, {
        home: this.snapshot.home.team.id,
        away: this.snapshot.away.team.id
      })
      return {
        liveGame: Option.some(
          new LiveGame({
            ...this,
            plays,
            watchability: this.watchability.next(this.snapshot, this.snapshot, events, now)
          })
        ),
        events
      }
    }
    const { snapshot, from } = delivery
    const order = GameSnapshot.gameTime(snapshot, this.snapshot)
    if (order < 0) return { liveGame: Option.none(), events: [] }
    if (order === 0 && from === "poll" && this.from === "push" && LiveGameState.$is("Live")(this.state)) {
      return {
        liveGame: Option.some(new LiveGame({ ...this, state: LiveGameState.Live({ updatedAt: now }) })),
        events: []
      }
    }
    const events = snapshot
      .eventsSince(this.snapshot)
      .filter((event) => this.plays.length === 0 || !fromPlays.has(event._tag))
    return {
      liveGame: Option.some(
        new LiveGame({
          snapshot,
          from,
          state: stateOf(snapshot, now),
          plays: this.plays,
          watchability: this.watchability.next(this.snapshot, snapshot, events, now)
        })
      ),
      events
    }
  }

  /**
   * The live game at `now` with nothing new: stale once its stale time has passed, its watchability judged again.
   * None when neither changes. Staleness is not a game event, so there are never events.
   */
  tick(now: DateTime.Utc): {
    readonly liveGame: Option.Option<LiveGame>
    readonly events: ReadonlyArray<GameEvent>
  } {
    const state = LiveGameState.$match(this.state, {
      Upcoming: () => this.state,
      Live: ({ updatedAt }) =>
        DateTime.isGreaterThanOrEqualTo(now, DateTime.addDuration(updatedAt, LiveGame.staleAfter))
          ? LiveGameState.Stale({ lastUpdatedAt: updatedAt })
          : this.state,
      Stale: () => this.state,
      Over: () => this.state
    })
    const watchability = this.watchability.at(this.snapshot, now)
    return {
      liveGame:
        Equal.equals(state, this.state) && Equal.equals(watchability, this.watchability)
          ? Option.none()
          : Option.some(new LiveGame({ ...this, state, watchability })),
      events: []
    }
  }

  /**
   * When `tick` may next change this live game, after `now`: the earlier of `staleAt` and, while it is live, the
   * watchability's `wakeAt`. None when only a delivery can change it.
   */
  wakeAt(now: DateTime.Utc): Option.Option<DateTime.Utc> {
    const watchability = LiveGameState.$is("Live")(this.state) ? this.watchability.wakeAt(now) : Option.none()
    return Arr.match(Arr.getSomes([this.staleAt(), watchability]), {
      onEmpty: Option.none<DateTime.Utc>,
      onNonEmpty: (instants) => Option.some(instants.reduce(DateTime.min))
    })
  }

  /** When a live game goes stale; none in every other state. */
  staleAt(): Option.Option<DateTime.Utc> {
    return LiveGameState.$match(this.state, {
      Upcoming: () => Option.none(),
      Live: ({ updatedAt }) => Option.some(DateTime.addDuration(updatedAt, LiveGame.staleAfter)),
      Stale: () => Option.none(),
      Over: () => Option.none()
    })
  }

  /** Live, stale for less than `staleCurrentFor`, or upcoming with kickoff within `currentBefore` of `now`. */
  isCurrent(now: DateTime.Utc): boolean {
    return LiveGameState.$match(this.state, {
      Upcoming: () =>
        DateTime.isLessThanOrEqualTo(
          this.snapshot.kickoff,
          DateTime.addDuration(now, LiveGame.currentBefore)
        ),
      Live: () => true,
      Stale: ({ lastUpdatedAt }) =>
        DateTime.isLessThan(now, DateTime.addDuration(lastUpdatedAt, LiveGame.staleCurrentFor)),
      Over: () => false
    })
  }

  /**
   * When `isCurrent` next changes with no snapshot, after `now`: an upcoming game's window opening or a stale game's
   * closing. None when only a snapshot can change it.
   */
  currencyChangesAt(now: DateTime.Utc): Option.Option<DateTime.Utc> {
    return LiveGameState.$match(this.state, {
      Upcoming: () => Option.some(DateTime.subtractDuration(this.snapshot.kickoff, LiveGame.currentBefore)),
      Live: () => Option.none(),
      Stale: ({ lastUpdatedAt }) =>
        Option.some(DateTime.addDuration(lastUpdatedAt, LiveGame.staleCurrentFor)),
      Over: () => Option.none()
    }).pipe(Option.filter((at) => DateTime.isLessThan(now, at)))
  }
}

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
