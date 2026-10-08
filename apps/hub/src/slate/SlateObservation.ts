import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import type { Cause, DateTime, Option } from "effect"
import { Data } from "effect"
import type { Acknowledgement } from "./Acknowledgement.ts"
import type { DeliverySource } from "./Delivery.ts"

/** What one take or tick did to one game, for telemetry only. */
export type SlateObservation = Data.TaggedEnum<{
  /**
   * A snapshot was taken, ignored as behind, or held by a covered game; or a held one fell back, applying as the
   * poll's once the push had not caught it up for `Acknowledgement.fallbackAfter`. A snapshot equal to a finished game's
   * final is not observed at all: every poll of a game still listed repeats it.
   */
  Took: {
    readonly snapshot: GameSnapshot
    readonly from: DeliverySource
    readonly outcome: TookOutcome | "fellBack"
    readonly had: Option.Option<GameSnapshot>
  }
  Started: {
    readonly after: Held
    readonly at: DateTime.Utc
  }
  /**
   * `before` as it stood at `since` (the instant of a delivery, or a tick's last wake), and `after` at `at`. A game
   * whose state only turned, as a live game going stale does, is the same before and after.
   */
  Changed: {
    readonly before: Held
    readonly after: Held
    readonly since: DateTime.Utc
    readonly at: DateTime.Utc
  }
  Stopped: {
    readonly after: Held
    readonly at: DateTime.Utc
  }
  Dropped: { readonly game: GameId }
  /** A game's take or tick raised a defect; the game kept what it had. `snapshot` is the one at hand. */
  Raised: { readonly snapshot: GameSnapshot; readonly cause: Cause.Cause<never>; readonly by: string }
}>
export const SlateObservation = Data.taggedEnum<SlateObservation>()

/** What taking a snapshot did: taken, ignored as behind, or held by a covered game. */
export type TookOutcome = "taken" | "behind" | "held"

/** A game as the slate holds it: its snapshot and its acknowledgement. */
type Held = Option.Option.Value<ReturnType<Acknowledgement["took"]>["next"]>
