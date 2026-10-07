import { NodeSocket } from "@effect/platform-node"
import { DateTime, Effect, Layer, Option } from "effect"
import * as Database from "./Database.ts"
import { FeedLog } from "./feed-log/FeedLog.ts"
import { HubConfig } from "./HubConfig.ts"
import * as Ingest from "./Ingest.ts"
import { LiveSlate } from "./LiveSlate.ts"
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

// The LiveSlate is built once it has replayed the day's frames, so the Hub serves only after that. It and Ingest share one
// feed log: Ingest appends to it, and the LiveSlate follows it. Only the LiveSlate is provided onward: nothing outside the
// Hub's own layers needs the log.
const live = Layer.mergeAll(
  Ingest.layer.pipe(
    Layer.provideMerge(LiveSlate.layer),
    Layer.provide(FeedLog.layerInDataDir),
    Layer.provide([
      Espn.layer.pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS)),
      DateTime.layerCurrentZoneLocal
    ])
  ),
  YouTubeTv.layer
)

// A scenario's feed log: in memory, or on the file `SPORTAL_SCENARIO_FEED_LOG` names in the data directory. Never on the
// game day's `feed.sqlite`.
const scenarioFeedLog = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* HubConfig

    return Option.match(config.scenarioFeedLog, {
      onNone: () => FeedLog.layerMemory,
      onSome: (name) => FeedLog.layer.pipe(Layer.provide(Database.layerFile(name)), Layer.orDie)
    })
  })
)

// The scenario plays as the provider through the real Ingest, onto a feed log of its own, decoded as ESPN recorded it.
// Ingest and the LiveSlate share the scenario's clock; the rest of the Hub keeps the real one.
const scenario = Layer.mergeAll(
  Ingest.layer.pipe(
    Layer.provideMerge(LiveSlate.layer),
    Layer.provide(scenarioFeedLog),
    Layer.provide([Espn.layerScenario.pipe(Layer.provide(Scenarios.layer)), DateTime.layerCurrentZoneLocal]),
    Layer.provide(ScenarioClock.layer)
  ),
  ScenarioSource.layer
)
