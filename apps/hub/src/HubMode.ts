import { NodeSocket } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { FeedLog } from "./feed/FeedLog.ts"
import { HubConfig } from "./HubConfig.ts"
import { Ingest } from "./ingest/Ingest.ts"
import { LiveGames } from "./LiveGames.ts"
import * as EspnProvider from "./provider/espn/EspnProvider.ts"
import * as FastCast from "./provider/espn/FastCast.ts"
import { Slate } from "./Slate.ts"
import * as ScenarioClock from "./scenario/ScenarioClock.ts"
import * as ScenarioIngest from "./scenario/ScenarioIngest.ts"
import * as ScenarioSource from "./scenario/ScenarioSource.ts"
import * as SqlChannelStore from "./source/SqlChannelStore.ts"
import * as YouTubeTv from "./source/youtube-tv/YouTubeTv.ts"

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

// Ingest is built once it has replayed the day's frames into the fold, so the Hub serves only after that.
function live() {
  return Layer.mergeAll(
    Layer.mergeAll(
      Slate.layer,
      Ingest.layer(leagues).pipe(
        Layer.provide([
          EspnProvider.layer,
          FastCast.layer.pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS)),
          FeedLog.inDataDir
        ])
      )
    ).pipe(Layer.provide(LiveGames.layer)),
    YouTubeTv.layer.pipe(Layer.provide(SqlChannelStore.layer))
  )
}

// The fold, the scenario, and the Slate share one clock; the rest of the Hub keeps the real one.
function scripted(name: string, speed: number) {
  return Layer.mergeAll(
    Layer.mergeAll(Slate.layer, ScenarioIngest.layer(name)).pipe(
      Layer.provide(LiveGames.layer),
      Layer.provide(ScenarioClock.layer(speed))
    ),
    ScenarioSource.layer
  )
}
