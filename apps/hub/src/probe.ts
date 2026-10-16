import { NodeRuntime, NodeSocket } from "@effect/platform-node"
import { HubApi } from "@sportal/api/HubApi"
import { Console, DateTime, Effect, Layer, Option, Stream } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { HubConfig } from "./HubConfig.ts"

// Asks a running Hub, on this machine at its port (`SPORTAL_PORT`, 4400 without it), for its health and its first answer
// to today's games over the socket, and prints both: a check that the Hub's API answers, without the web UI.

const probe = Effect.gen(function* () {
  const client = yield* RpcClient.make(HubApi)

  const health = yield* client.health()
  yield* Console.log(`health: version ${health.version}, started ${DateTime.formatIso(health.startedAt)}`)

  const first = yield* Stream.runHead(client.listLive({}))
  yield* Option.match(first, {
    onNone: () => Console.log("listLive: ended before its first answer"),
    onSome: ({ date, games }) =>
      Console.log(
        [
          `listLive: ${date}, ${games.length} games`,
          ...games.map(({ snapshot }) => `  ${snapshot.league} ${snapshot.matchup()}: ${snapshot.statusText}`)
        ].join("\n")
      )
  })
}).pipe(Effect.scoped, Effect.timeout("15 seconds"))

const protocol = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* HubConfig
    const url = `ws://127.0.0.1:${config.port}/api/socket`

    return RpcClient.layerProtocolSocket().pipe(
      Layer.provide([NodeSocket.layerWebSocket(url), RpcSerialization.layerJson])
    )
  })
).pipe(Layer.provide(HubConfig.layer))

probe.pipe(Effect.provide(protocol), NodeRuntime.runMain)
