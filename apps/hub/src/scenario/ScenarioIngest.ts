import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Delivery } from "@sportal/domain/Delivery"
import { LeagueId } from "@sportal/domain/League"
import { Array as Arr, DateTime, Duration, Effect, FileSystem, Layer, Option, Schema } from "effect"
import * as Cadence from "../ingest/Cadence.ts"
import { Ingest } from "../ingest/Ingest.ts"
import { LiveGames } from "../LiveGames.ts"
import { Scenario } from "./Scenario.ts"
import { scenarios } from "./written/Scenarios.ts"

/**
 * A scenario as the feed: each league's slate at the time since the Hub started is taken as a `Listing`, on the poll
 * Cadence over the fold as live Ingest polls, and also at each of the scenario's frames' times, so a change lands
 * when it was written. That is scenario time when the Hub runs on the scenario clock. Nothing is logged. `name` is a
 * written scenario's, or a recorded slice's in `from`.
 */
export const layer = (name: string, from: string = folder) =>
  Layer.effect(
    Ingest,
    Effect.gen(function* () {
      const scenario = yield* load(name, from)
      const liveGames = yield* LiveGames
      const start = yield* DateTime.now
      yield* Effect.logInfo(`ScenarioIngest: playing ${scenario.name}, ${scenario.frames.length} frames`)
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const now = yield* DateTime.now
            const elapsed = DateTime.distance(start, now)
            const slate = scenario.slateAt(start, elapsed)
            yield* Effect.forEach(
              LeagueId.literals,
              (league) =>
                liveGames.take(
                  Delivery.Listing({ league, games: slate.filter((game) => game.league === league) }),
                  now,
                  Option.none()
                ),
              { discard: true }
            )
            const cadence = Cadence.interval((yield* liveGames.latest).slate(LeagueId.literals), now, false)
            const nextFrame = Arr.findFirst(scenario.frames, ({ at }) => at > Duration.toMillis(elapsed))
            yield* Effect.sleep(
              Option.match(nextFrame, {
                onNone: () => cadence,
                onSome: ({ at }) => Duration.min(cadence, Duration.subtract(Duration.millis(at), elapsed))
              })
            )
          })
        )
      )
      return Ingest.of({})
    })
  )

/** Where recorded slices are kept: `fixtures/scenarios/` at the repository's root. */
export const folder = fileURLToPath(new URL("../../../../fixtures/scenarios/", import.meta.url))

/** A written scenario by name, or else a slice in `from`. Only a listed name is read, so no name reaches a path. */
function load(name: string, from: string) {
  return Effect.gen(function* () {
    const written = scenarios.get(name)
    if (written !== undefined) return written
    const fs = yield* FileSystem.FileSystem
    const recorded = (yield* fs.exists(from))
      ? (yield* fs.readDirectory(from))
          .filter((file) => file.endsWith(".json"))
          .map((file) => file.slice(0, -".json".length))
      : []
    if (!recorded.includes(name))
      return yield* Effect.fail(new ScenarioUnknown({ name, known: [...scenarios.keys(), ...recorded] }))
    return yield* fs.readFileString(join(from, `${name}.json`)).pipe(Effect.flatMap(decodeScenario))
  })
}

/** `SPORTAL_SCENARIO` names neither a written scenario nor a recorded slice. */
class ScenarioUnknown extends Schema.TaggedError<ScenarioUnknown>()("ScenarioUnknown", {
  name: Schema.String,
  known: Schema.Array(Schema.String)
}) {
  override get message() {
    return `No scenario named "${this.name}". Known: ${this.known.join(", ")}`
  }
}

const decodeScenario = Schema.decodeEffect(Schema.fromJsonString(Scenario))
