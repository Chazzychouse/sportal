import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import type { Play } from "@sportal/domain/Play"
import { Context, Data, type DateTime, type Effect, type Schedule, Schema } from "effect"
import { GameDay } from "../corpus/GameDay.ts"

/** A provider's archive of finished games, kept as fetched under the corpus's `archive/`. */
export class Archive extends Context.Service<
  Archive,
  {
    /** The final games of `league` on `date`, fetching what is not archived yet; a game it cannot use is skipped and logged. */
    games(league: LeagueId, date: GameDay): Effect.Effect<ReadonlyArray<ArchivedGame>, ArchiveFetchFailed>
    /** The same from what is archived only, fetching nothing: what a rebuild reads. */
    archived(league: LeagueId, date: GameDay): Effect.Effect<ReadonlyArray<ArchivedGame>, ArchiveFetchFailed>
    /** Between two fetches. */
    readonly pacing: Schedule.Schedule<unknown>
  }
>()("sportal/hub/provider/Archive") {}

/** A finished game as a provider's archive gives it: as scheduled, as final, and its plays with when each was run. */
export class ArchivedGame extends Data.Class<{
  /** The scoreboard's event, its status set to scheduled. */
  readonly scheduled: GameSnapshot
  readonly final: GameSnapshot
  readonly plays: ReadonlyArray<ArchivedPlay>
}> {}

/** A play of an archived game, with the wallclock instant it was run at. */
export interface ArchivedPlay {
  readonly play: Play
  readonly wallclock: DateTime.Utc
}

/**
 * The archive could not give `league`'s games on `date` (or one game of them): a fetch did not connect or was answered
 * with a server error after its retries (`Unreachable`), was refused (`Refused`), or gave what does not read
 * (`Unreadable`); or, reading the archive only, a file is not archived (`NotArchived`).
 */
export class ArchiveFetchFailed extends Schema.TaggedError<ArchiveFetchFailed>()("ArchiveFetchFailed", {
  league: LeagueId,
  date: GameDay,
  game: Schema.optional(GameId),
  reason: Schema.Literals(["Unreachable", "Refused", "Unreadable", "NotArchived"]),
  cause: Schema.Defect()
}) {
  override get message() {
    const what = `${this.league} ${this.date}${this.game === undefined ? "" : ` game ${this.game}`}`
    return {
      Unreachable: `The archive could not reach ${what}`,
      Refused: `The archive was refused ${what}`,
      Unreadable: `The archive's ${what} does not read`,
      NotArchived: `The archive does not have ${what}`
    }[this.reason]
  }
}
