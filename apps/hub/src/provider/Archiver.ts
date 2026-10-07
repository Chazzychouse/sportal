import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { GameDay } from "@sportal/domain/GameDay"
import { LeagueId } from "@sportal/domain/League"
import type { Play } from "@sportal/domain/Play"
import { Context, Data, type DateTime, type Effect, type Schedule, Schema } from "effect"

/** A provider's archiver of finished games: what it fetches it keeps, as fetched, under the corpus's `archive/`. */
export class Archiver extends Context.Service<
  Archiver,
  {
    /** The final games of `league` on `date`, fetching what is not archived yet; a game it cannot use is skipped and logged. */
    games(league: LeagueId, date: GameDay): Effect.Effect<ReadonlyArray<GameArchive>, ArchiveFetchFailed>
    /** The same from what is archived only, fetching nothing: what a rebuild reads. */
    archived(league: LeagueId, date: GameDay): Effect.Effect<ReadonlyArray<GameArchive>, ArchiveFetchFailed>
    /** Between two fetches. */
    readonly pacing: Schedule.Schedule<unknown>
  }
>()("sportal/hub/provider/Archiver") {}

/** A finished game's entry in the archive: as scheduled, as final, and its plays with when each was run. */
export class GameArchive extends Data.Class<{
  /** The scoreboard's event, its status set to scheduled. */
  readonly scheduled: GameSnapshot
  readonly final: GameSnapshot
  readonly plays: ReadonlyArray<PlayArchive>
}> {}

/** A play of an archived game, with the wallclock instant it was run at. */
export interface PlayArchive {
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
