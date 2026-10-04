import { createServer } from "node:http"
import { join } from "node:path"
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Option } from "effect"
import { FetchHttpClient, HttpRouter, HttpStaticServer } from "effect/http"
import * as Database from "./database/Database.ts"
import { HubConfig } from "./HubConfig.ts"
import * as HubServer from "./http/HubServer.ts"
import { Ingest } from "./ingest/Ingest.ts"
import * as EspnProvider from "./provider/espn/EspnProvider.ts"
import * as ScenarioClock from "./scenario/ScenarioClock.ts"
import * as ScenarioProvider from "./scenario/ScenarioProvider.ts"
import * as ScenarioSource from "./scenario/ScenarioSource.ts"
import * as SqlChannelStore from "./source/SqlChannelStore.ts"
import * as YouTubeTv from "./source/youtube-tv/YouTubeTv.ts"
import { StageSessions } from "./stage/StageSessions.ts"
import { Watch } from "./watch/Watch.ts"

const Hub = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* HubConfig
    yield* (yield* FileSystem.FileSystem).makeDirectory(config.dataDir, { recursive: true })

    const routes = Option.match(config.webRoot, {
      onNone: () => HubServer.layer,
      onSome: (root) => Layer.mergeAll(HubServer.layer, HttpStaticServer.layer({ root, spa: true }))
    })

    // A scenario plays a game day in place of ESPN and YouTube TV. Only Ingest, Watch, and the scenario run on scenario
    // time; the rest of the Hub keeps the real clock.
    const leagues = ["nfl", "fbs"] as const
    const live = Layer.mergeAll(
      Watch.layer.pipe(Layer.provideMerge(Ingest.layer(leagues).pipe(Layer.provide(EspnProvider.layer)))),
      YouTubeTv.layer.pipe(Layer.provide(SqlChannelStore.layer))
    )
    const scripted = (name: string) =>
      Layer.mergeAll(
        // One clock for Ingest, the scenario, and Watch, so they share scenario time.
        Watch.layer.pipe(
          Layer.provideMerge(Ingest.layer(leagues).pipe(Layer.provide(ScenarioProvider.layer(name)))),
          Layer.provide(ScenarioClock.layer(config.scenarioSpeed))
        ),
        ScenarioSource.layer
      )
    type Scripted = ReturnType<typeof scripted>
    // Typed so the compiler checks that the scenario layers provide everything the live ones do.
    const games: Layer.Layer<
      Layer.Success<typeof live>,
      Layer.Error<typeof live> | Layer.Error<Scripted>,
      Layer.Services<typeof live> | Layer.Services<Scripted>
    > = Option.match(config.scenario, { onNone: () => live, onSome: scripted })

    return HttpRouter.serve(routes).pipe(
      Layer.provide(StageSessions.layer),
      Layer.provide(games),
      Layer.provide(Database.layer(join(config.dataDir, "sportal.sqlite"))),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(NodeHttpServer.layer(createServer, { port: config.port, host: config.host })),
      Layer.provide(NodeServices.layer)
    )
  })
).pipe(Layer.provide(HubConfig.layer))

Layer.launch(Hub).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
