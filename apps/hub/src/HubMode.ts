import { NodeSocket } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { Director } from "./Director.ts"
import { HubConfig } from "./HubConfig.ts"
import * as Espn from "./provider/espn/Espn.ts"
import * as ScenarioClock from "./scenario/ScenarioClock.ts"
import * as ScenarioSource from "./scenario/ScenarioSource.ts"
import { Scenarios } from "./scenario/Scenarios.ts"
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

// The Director takes what ESPN decodes, against YouTube TV.
const live = Director.layer.pipe(
  Layer.provide(Espn.layer.pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS))),
  Layer.provideMerge(YouTubeTv.layer)
)

// The scenario plays as the provider, decoded as ESPN recorded it. Its frames play on the clock of the Director that
// runs them, so the Director runs on the scenario's clock; the rest of the Hub keeps the real one.
const scenario = Director.layer.pipe(
  Layer.provide(Espn.layerScenario.pipe(Layer.provide(Scenarios.layer))),
  Layer.provide(ScenarioClock.layer),
  Layer.provideMerge(ScenarioSource.layer)
)
