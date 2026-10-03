import { createServer } from "node:http"
import { join } from "node:path"
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Effect, FileSystem, Layer, Option } from "effect"
import { FetchHttpClient, HttpRouter, HttpStaticServer } from "effect/http"
import * as Database from "./database/Database.ts"
import * as HubServer from "./http/HubServer.ts"
import { Ingest } from "./ingest/Ingest.ts"
import * as EspnProvider from "./provider/espn/EspnProvider.ts"
import * as SqlChannelStore from "./source/SqlChannelStore.ts"
import * as YouTubeTv from "./source/YouTubeTv.ts"
import { StageSessions } from "./stage/StageSessions.ts"

const Hub = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port("SPORTAL_PORT").pipe(Config.withDefault(4400))
    const host = yield* Config.String("SPORTAL_HOST").pipe(Config.withDefault("127.0.0.1"))
    // The built web UI, served by the Hub outside development.
    const webRoot = yield* Config.String("SPORTAL_WEB_ROOT").pipe(Config.option)
    // Where the Hub keeps its database.
    const dataDir = yield* Config.String("SPORTAL_DATA_DIR").pipe(Config.withDefault(".sportal"))
    yield* (yield* FileSystem.FileSystem).makeDirectory(dataDir, { recursive: true })

    const routes = Option.match(webRoot, {
      onNone: () => HubServer.layer,
      onSome: (root) => Layer.mergeAll(HubServer.layer, HttpStaticServer.layer({ root, spa: true }))
    })

    return HttpRouter.serve(routes).pipe(
      Layer.provide(StageSessions.layer),
      Layer.provide(YouTubeTv.layer([])),
      Layer.provide(SqlChannelStore.layer),
      Layer.provide(Ingest.layer(["nfl", "fbs"])),
      Layer.provide(EspnProvider.layer),
      Layer.provide(Database.layer(join(dataDir, "sportal.sqlite"))),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(NodeHttpServer.layer(createServer, { port, host })),
      Layer.provide(NodeServices.layer)
    )
  })
)

Layer.launch(Hub).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
