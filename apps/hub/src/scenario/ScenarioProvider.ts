import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Scenario } from "@sportal/domain/Scenario"
import { scenarios } from "@sportal/domain/scenarios/Scenarios"
import { DateTime, Duration, Effect, FileSystem, Layer, Schema } from "effect"
import { Provider } from "../provider/Provider.ts"

/**
 * A scenario as the provider: each league's slate is the scenario's at the time since the Hub started, which is
 * scenario time when the Hub runs on the scenario clock. `name` is a written scenario's, or a recorded slice's
 * in `from`.
 */
export const layer = (name: string, from: string = folder) =>
  Layer.effect(
    Provider,
    Effect.gen(function* () {
      const scenario = yield* load(name, from)
      const start = yield* DateTime.now
      yield* Effect.logInfo(`ScenarioProvider: playing ${scenario.name}, ${scenario.frames.length} frames`)
      return Provider.of({
        slate: (league) =>
          DateTime.now.pipe(
            Effect.map((now) =>
              scenario
                .slateAt(start, Duration.millis(DateTime.toEpochMillis(now) - DateTime.toEpochMillis(start)))
                .filter((game) => game.league === league)
            )
          )
      })
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
