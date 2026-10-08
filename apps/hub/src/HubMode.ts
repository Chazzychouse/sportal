import { NodeSocket } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { HubConfig } from "./HubConfig.ts"
import * as Espn from "./provider/espn/Espn.ts"
import * as ScenarioClock from "./scenario/ScenarioClock.ts"
import * as ScenarioSource from "./scenario/ScenarioSource.ts"
import { Scenarios } from "./scenario/Scenarios.ts"
import { Board } from "./slate/Board.ts"
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

// The Board takes what ESPN decodes.
const live = Layer.mergeAll(
  Board.layer.pipe(Layer.provide(Espn.layer.pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS)))),
  YouTubeTv.layer
)

// The scenario plays as the provider, decoded as ESPN recorded it. The provider and the Board share the scenario's
// clock; the rest of the Hub keeps the real one.
const scenario = Layer.mergeAll(
  Board.layer.pipe(
    Layer.provide(Espn.layerScenario.pipe(Layer.provide(Scenarios.layer))),
    Layer.provide(ScenarioClock.layer)
  ),
  ScenarioSource.layer
)
