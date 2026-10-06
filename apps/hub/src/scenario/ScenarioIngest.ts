import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Delivery } from "@sportal/domain/Delivery"
import { LeagueId } from "@sportal/domain/League"
import { Scenario } from "@sportal/domain/Scenario"
import { scenarios } from "@sportal/domain/scenarios/Scenarios"
import { DateTime, Duration, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { Ingest } from "../ingest/Ingest.ts"
import { LiveGames } from "../LiveGames.ts"

/**
 * A scenario as the feed: at each of its frames' times since the Hub started, each league's slate is taken as a
 * `Listing`. That is scenario time when the Hub runs on the scenario clock. Nothing is logged. `name` is a written
 * scenario's, or a recorded slice's in `from`.
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
        Effect.forEach(
          scenario.frames,
          ({ at }) =>
            Effect.gen(function* () {
              const elapsed = Duration.millis(at)
              yield* Effect.sleep(
                Duration.max(
                  DateTime.distance(yield* DateTime.now, DateTime.addDuration(start, elapsed)),
                  Duration.zero
                )
              )
              const slate = scenario.slateAt(start, elapsed)
              const now = yield* DateTime.now
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
            }),
          { discard: true }
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
