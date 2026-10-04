import { Effect, Layer, Option } from "effect"
import { GameActors } from "./GameActors.ts"
import { HubConfig } from "./HubConfig.ts"
import { Ingest } from "./ingest/Ingest.ts"
import * as EspnProvider from "./provider/espn/EspnProvider.ts"
import * as ScenarioClock from "./scenario/ScenarioClock.ts"
import * as ScenarioProvider from "./scenario/ScenarioProvider.ts"
import * as ScenarioSource from "./scenario/ScenarioSource.ts"
import * as SqlChannelStore from "./source/SqlChannelStore.ts"
import * as YouTubeTv from "./source/youtube-tv/YouTubeTv.ts"
import { Watch } from "./watch/Watch.ts"

/** What the Hub plays: the live day from ESPN and YouTube TV, or a scenario in their place, on scenario time. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { scenario, scenarioSpeed } = yield* HubConfig
    // Annotated so the compiler checks that a scenario provides everything the live day does.
    const chosen: Layer.Layer<
      Layer.Success<ReturnType<typeof live>>,
      Layer.Error<ReturnType<typeof live>> | Layer.Error<ReturnType<typeof scripted>>,
      Layer.Services<ReturnType<typeof live>> | Layer.Services<ReturnType<typeof scripted>>
    > = Option.match(scenario, { onNone: live, onSome: (name) => scripted(name, scenarioSpeed) })
    return chosen
  })
)

const leagues = ["nfl", "fbs"] as const

function live() {
  return Layer.mergeAll(
    Watch.layer.pipe(
      Layer.provideMerge(Ingest.layer(leagues).pipe(Layer.provide([EspnProvider.layer, GameActors.layer])))
    ),
    YouTubeTv.layer.pipe(Layer.provide(SqlChannelStore.layer))
  )
}

// Ingest, the game actors, the scenario, and Watch share one clock; the rest of the Hub keeps the real one.
function scripted(name: string, speed: number) {
  return Layer.mergeAll(
    Watch.layer.pipe(
      Layer.provideMerge(
        Ingest.layer(leagues).pipe(Layer.provide([ScenarioProvider.layer(name), GameActors.layer]))
      ),
      Layer.provide(ScenarioClock.layer(speed))
    ),
    ScenarioSource.layer
  )
}
