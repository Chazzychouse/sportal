import { Data, DateTime, Duration, Option } from "effect"
import { GameSnapshot } from "./Game.ts"

/** Where a live game is: upcoming, live (last updated at), stale (last updated at), or over. */
export type LiveGameState = Data.TaggedEnum<{
  Upcoming: object
  Live: { readonly updatedAt: DateTime.Utc }
  Stale: { readonly lastUpdatedAt: DateTime.Utc }
  Over: object
}>
export const LiveGameState = Data.taggedEnum<LiveGameState>()

/** One game as the Hub follows it: its latest snapshot and its state. */
export class LiveGame extends Data.Class<{ readonly snapshot: GameSnapshot; readonly state: LiveGameState }> {
  /** A live game no snapshot has reached for this long is stale. */
  static readonly staleAfter = Duration.seconds(90)

  /** An upcoming game is current from this long before kickoff. */
  static readonly currentBefore = Duration.minutes(30)

  /** How long a stale game stays current, from its last update, before its actor may stop. */
  static readonly staleCurrentFor = Duration.minutes(30)

  /** A game's first snapshot, always taken. */
  static start(snapshot: GameSnapshot, now: DateTime.Utc): LiveGame {
    return new LiveGame({ snapshot, state: stateOf(snapshot, now) })
  }

  /** The live game after `snapshot` arrives at `now`, or none when it is behind in game time. */
  receive(snapshot: GameSnapshot, now: DateTime.Utc): Option.Option<LiveGame> {
    return GameSnapshot.gameTime(snapshot, this.snapshot) < 0
      ? Option.none()
      : Option.some(LiveGame.start(snapshot, now))
  }

  /** The live game once `now` has passed its stale time, or none when nothing changes. */
  tick(now: DateTime.Utc): Option.Option<LiveGame> {
    return LiveGameState.$match(this.state, {
      Upcoming: () => Option.none(),
      Live: ({ updatedAt }) =>
        DateTime.isGreaterThanOrEqualTo(now, DateTime.addDuration(updatedAt, LiveGame.staleAfter))
          ? Option.some(
              new LiveGame({
                snapshot: this.snapshot,
                state: LiveGameState.Stale({ lastUpdatedAt: updatedAt })
              })
            )
          : Option.none(),
      Stale: () => Option.none(),
      Over: () => Option.none()
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
