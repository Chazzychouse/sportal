import { NodeSocket } from "@effect/platform-node"
import { DateTime, Effect, Layer, Option } from "effect"
import { FeedLog } from "./feed-log/FeedLog.ts"
import { HubConfig } from "./HubConfig.ts"
import * as Ingest from "./Ingest.ts"
import * as Espn from "./provider/espn/Espn.ts"
import * as ScenarioClock from "./scenario/ScenarioClock.ts"
import * as ScenarioSource from "./scenario/ScenarioSource.ts"
import { Scenarios } from "./scenario/Scenarios.ts"
import { Board } from "./slate/Board.ts"
import { BoardTelemetry } from "./slate/BoardTelemetry.ts"
import * as YouTubeTv from "./source/youtube-tv/YouTubeTv.ts"

/** What the Hub plays: the live day from ESPN and YouTube TV, or a scenario in their place, on scenario time. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* HubConfig
    // Annotated so the compiler checks that a scenario provides everything the live day does.
    const chosen: Layer.Layer<
      Layer.Success<typeof live>,
      Layer.Error<typeof live> | Layer.Error<typeof scenario>,
      Layer.Services<typeof live> | Layer.Services<typeof scenario>
    > = Option.match(config.scenario, { onNone: () => live, onSome: () => scenario })
    return chosen
  })
)

// The Board is built once it has replayed the day's frames, so the Hub serves only after that. It and Ingest share one
// feed log and one provider: Ingest appends the provider's frames, and the Board follows the log through the provider's
// decode, telling its telemetry. Only the Board is provided onward: nothing outside the Hub's own layers needs the log.
const live = Layer.mergeAll(
  Ingest.layer.pipe(
    Layer.provideMerge(Board.layer),
    Layer.provide(BoardTelemetry.layer),
    Layer.provide(FeedLog.layerInDataDir),
    Layer.provide([
      Espn.layer.pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS)),
      DateTime.layerCurrentZoneLocal
    ])
  ),
  YouTubeTv.layer
)

// The scenario plays as the provider through the real Ingest, onto a feed log of its own, decoded as ESPN recorded it.
// Ingest and the Board share the scenario's clock; the rest of the Hub keeps the real one.
const scenario = Layer.mergeAll(
  Ingest.layer.pipe(
    Layer.provideMerge(Board.layer),
    Layer.provide(BoardTelemetry.layer),
    Layer.provide(FeedLog.layerMemory),
    Layer.provide([Espn.layerScenario.pipe(Layer.provide(Scenarios.layer)), DateTime.layerCurrentZoneLocal]),
    Layer.provide(ScenarioClock.layer)
  ),
  ScenarioSource.layer
)
