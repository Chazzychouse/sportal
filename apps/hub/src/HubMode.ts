import { NodeSocket } from "@effect/platform-node"
import { DateTime, Effect, Layer, Option } from "effect"
import { FeedLog } from "./FeedLog.ts"
import { GameHistory } from "./GameHistory.ts"
import { HubConfig } from "./HubConfig.ts"
import * as Ingest from "./ingest/Ingest.ts"
import { LiveGames } from "./LiveGames.ts"
import * as EspnDecode from "./provider/espn/EspnDecode.ts"
import * as EspnProvider from "./provider/espn/EspnProvider.ts"
import { Slate } from "./Slate.ts"
import { RecordedScenarios } from "./scenario/RecordedScenarios.ts"
import * as ScenarioClock from "./scenario/ScenarioClock.ts"
import * as ScenarioProvider from "./scenario/ScenarioProvider.ts"
import * as ScenarioSource from "./scenario/ScenarioSource.ts"
import { ChannelStore } from "./source/ChannelStore.ts"
import * as YouTubeTv from "./source/youtube-tv/YouTubeTv.ts"

/** What the Hub plays: the live day from ESPN and YouTube TV, or a scenario in their place, on scenario time. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { scenario } = yield* HubConfig
    // Annotated so the compiler checks that a scenario provides everything the live day does.
    const chosen: Layer.Layer<
      Layer.Success<ReturnType<typeof live>>,
      Layer.Error<ReturnType<typeof live>> | Layer.Error<ReturnType<typeof scripted>>,
      Layer.Services<ReturnType<typeof live>> | Layer.Services<ReturnType<typeof scripted>>
    > = Option.match(scenario, { onNone: live, onSome: scripted })
    return chosen
  })
)

// Ingest is built once it has replayed the day's frames into the fold, so the Hub serves only after that.
function live() {
  return Layer.mergeAll(
    Layer.mergeAll(
      Slate.layer,
      // Nothing reads the history yet; it only follows the fold.
      Layer.effectDiscard(Layer.build(GameHistory.layer)),
      Ingest.layer.pipe(
        Layer.provide([
          EspnProvider.layer.pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS)),
          FeedLog.inDataDir,
          DateTime.layerCurrentZoneLocal
        ])
      )
    ).pipe(Layer.provide(LiveGames.layer)),
    YouTubeTv.layer.pipe(Layer.provide(ChannelStore.layer))
  )
}

// The scenario plays as the provider through the real Ingest, onto a feed log of its own. Ingest, the fold, and the
// Slate share the scenario's clock; the rest of the Hub keeps the real one. The game history stays out of a scenario.
function scripted() {
  return Layer.mergeAll(
    Layer.mergeAll(
      Slate.layer,
      Ingest.layer.pipe(
        Layer.provide([
          ScenarioProvider.layer.pipe(Layer.provide([RecordedScenarios.layer, EspnDecode.layer])),
          FeedLog.forScenario,
          DateTime.layerCurrentZoneLocal
        ])
      )
    ).pipe(Layer.provide(LiveGames.layer), Layer.provide(ScenarioClock.layer)),
    ScenarioSource.layer
  )
}
