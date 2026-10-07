import type { Cause, DateTime, Option } from "effect"
import { Data } from "effect"
import type { DeliverySource } from "./Delivery.ts"
import type { GameId, GameSnapshot } from "./Game.ts"
import type { LiveGame, TookOutcome } from "./LiveGame.ts"

/** What one take or tick did to one game, for telemetry only. */
export type SlateObservation = Data.TaggedEnum<{
  /**
   * A snapshot was taken, ignored as behind, or held by a covered game; or a held one fell back, applying as the
   * poll's once the push had not caught it up for `LiveGame.fallbackAfter`. A snapshot equal to a finished game's
   * final is not observed at all: every poll of a game still listed repeats it.
   */
  Took: {
    readonly snapshot: GameSnapshot
    readonly from: DeliverySource
    readonly outcome: TookOutcome | "fellBack"
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
