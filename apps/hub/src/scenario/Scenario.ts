import { GameSnapshot } from "@sportal/domain/Game"
import { DateTime, Duration, Schema } from "effect"
import { ScenarioScript } from "./ScenarioScript.ts"

/**
 * A written scenario: a timeline of game snapshots for several games that a Hub can play as its provider. Its
 * instants are as written; `slateAt` moves them to when it is played.
 */
export class Scenario extends Schema.Class<Scenario>("sportal/Scenario")({
  name: Schema.String,
  /** When the scenario starts, as written or recorded. */
  origin: Schema.DateTimeUtcFromString,
  /** The whole slate `at` milliseconds after the scenario starts, in order of `at`, the first at 0. */
  frames: Schema.Array(Schema.Struct({ at: Schema.Int, slate: Schema.Array(GameSnapshot) }))
}) {
  /** `ScenarioScript.build`'s script, as its slate at each step. */
  static build(...written: Parameters<typeof ScenarioScript.build>): Scenario {
    const script = ScenarioScript.build(...written)
    return new Scenario({
      name: script.name,
      origin: script.origin,
      frames: script.steps.map(({ at, slate }) => ({ at, slate }))
    })
  }

  /**
   * The slate `elapsed` after the scenario started at `start`: the latest frame by then, held after the last,
   * with every instant moved by the time from the scenario's origin to `start`.
   */
  slateAt(start: DateTime.Utc, elapsed: Duration.Duration): ReadonlyArray<GameSnapshot> {
    const at = Duration.toMillis(elapsed)
    const frame = this.frames.findLast((candidate) => candidate.at <= at) ?? this.frames[0]
    if (frame === undefined) return []
    const shift = DateTime.toEpochMillis(start) - DateTime.toEpochMillis(this.origin)
    return frame.slate.map(
      (game) =>
        new GameSnapshot({
          ...game,
          kickoff: DateTime.add(game.kickoff, { milliseconds: shift })
        })
    )
  }
}
