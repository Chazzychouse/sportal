import { Array as Arr, Data, DateTime, Duration, Equal, Option } from "effect"
import type { Delivery, DeliverySource } from "./Delivery.ts"
import { GameSnapshot } from "./Game.ts"
import type { GameEvent } from "./GameEvent.ts"
import { Play } from "./Play.ts"

/** Where a live game is: upcoming, live (last updated at), stale (last updated at), or over. */
export type LiveGameState = Data.TaggedEnum<{
  Upcoming: object
  Live: { readonly updatedAt: DateTime.Utc }
  Stale: { readonly updatedAt: DateTime.Utc }
  Over: object
}>
export const LiveGameState = Data.taggedEnum<LiveGameState>()

/** One game as the Hub follows it: its latest snapshot, the feed that gave it, its state, and its plays. Folded from deliveries. */
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
   * A snapshot behind in game time is none. A poll at the same game time as a live game's pushed snapshot only
   * refreshes it: the push wins a tie, since the poll lags it. Once the game has plays, they decide the events they
   * cover (`fromPlays`), and a snapshot gives only the rest. A `Plays` delivery replaces the list.
   */
  take(
    delivery: Extract<Delivery, { readonly _tag: "Snapshot" | "Plays" }>,
    now: DateTime.Utc
  ): { readonly liveGame: Option.Option<LiveGame>; readonly events: ReadonlyArray<GameEvent> } {
    if (delivery._tag === "Plays") {
      const plays = delivery.plays.toSorted(Play.order)
      if (Equal.equals(plays, this.plays)) return { liveGame: Option.none(), events: [] }
      const events = Play.eventsSince(this.plays, plays, {
        home: this.snapshot.home.team.id,
        away: this.snapshot.away.team.id
      })
      return { liveGame: Option.some(new LiveGame({ ...this, plays })), events }
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
          plays: this.plays
        })
      ),
      events
    }
  }

  /** The live game at `now` with nothing new: stale once its stale time has passed. None when that changes nothing. */
  tick(now: DateTime.Utc): Option.Option<LiveGame> {
    return LiveGameState.$is("Live")(this.state) &&
      DateTime.isGreaterThanOrEqualTo(now, DateTime.addDuration(this.state.updatedAt, LiveGame.staleAfter))
      ? Option.some(
          new LiveGame({ ...this, state: LiveGameState.Stale({ updatedAt: this.state.updatedAt }) })
        )
      : Option.none()
  }

  /**
   * When this live game next changes with no new frame, strictly after `now`: going stale, or entering or leaving the
   * live-feed window (`isCurrent`). None when only a delivery can change it.
   */
  dueAfter(now: DateTime.Utc): Option.Option<DateTime.Utc> {
    return LiveGameState.$match(this.state, {
      Upcoming: () => Option.some(DateTime.subtractDuration(this.snapshot.kickoff, LiveGame.currentBefore)),
      Live: ({ updatedAt }) => Option.some(DateTime.addDuration(updatedAt, LiveGame.staleAfter)),
      Stale: ({ updatedAt }) => Option.some(DateTime.addDuration(updatedAt, LiveGame.staleCurrentFor)),
      Over: () => Option.none()
    }).pipe(Option.filter((at) => DateTime.isLessThan(now, at)))
  }

  /** When a live or stale game was last updated; none for an upcoming or over game. */
  updatedAt(): Option.Option<DateTime.Utc> {
    return LiveGameState.$match(this.state, {
      Upcoming: () => Option.none(),
      Live: ({ updatedAt }) => Option.some(updatedAt),
      Stale: ({ updatedAt }) => Option.some(updatedAt),
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
      Stale: ({ updatedAt }) =>
        DateTime.isLessThan(now, DateTime.addDuration(updatedAt, LiveGame.staleCurrentFor)),
      Over: () => false
    })
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

/** The tags a game's plays decide once it has any; its snapshots decide them only before. */
const fromPlays: ReadonlySet<GameEvent["_tag"]> = new Set([
  "ScoreChanged",
  "Turnover",
  "PossessionChanged",
  "TimeoutTaken",
  "PeriodEnded",
  "FourthDown",
  "Played",
  "BigPlay",
  "Sack"
])
