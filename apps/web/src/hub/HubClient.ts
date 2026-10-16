import type { DisplayId } from "@sportal/api/DisplayId"
import type { DisplayOffline } from "@sportal/api/DisplayOffline"
import type { GuideUnreadable } from "@sportal/api/GuideUnreadable"
import { Context, Effect, Layer, type Schema } from "effect"
import type { RpcClientError } from "effect/rpc"
import { HubSocket } from "./HubSocket.ts"

/** This client's requests and writes to the Hub, over the Hub socket. */
export class HubClient extends Context.Service<
  HubClient,
  {
    /** Passes a guide the shell read to the Hub. What it changes arrives on the live queries. */
    readonly sendGuide: (
      guide: string
    ) => Effect.Effect<void, GuideUnreadable | RpcClientError.RpcClientError>
    /** The addresses a Remote on the home network can reach the Hub's machine at. */
    readonly addresses: Effect.Effect<ReadonlyArray<string>, RpcClientError.RpcClientError>
    /** Tells the Hub this Display's report, for its Remotes. */
    readonly report: (
      id: DisplayId,
      report: Schema.Json
    ) => Effect.Effect<void, DisplayOffline | RpcClientError.RpcClientError>
    /** Sends one input to the Display `id`, from a Remote. */
    readonly send: (
      id: DisplayId,
      input: Schema.Json
    ) => Effect.Effect<void, DisplayOffline | RpcClientError.RpcClientError>
  }
>()("sportal/web/hub/HubClient") {
  static readonly layer: Layer.Layer<HubClient, never, HubSocket> = Layer.effect(
    HubClient,
    Effect.gen(function* () {
      const { client } = yield* HubSocket

      const sendGuide = Effect.fn("HubClient.sendGuide")(function* (guide: string) {
        yield* client.readGuide({ guide })
      })
      const addresses = client.addresses()
      const report = Effect.fn("HubClient.report")(function* (id: DisplayId, json: Schema.Json) {
        yield* client.report({ display: id, report: json })
      })
      const send = Effect.fn("HubClient.send")(function* (id: DisplayId, input: Schema.Json) {
        yield* client.send({ display: id, input })
      })
      return HubClient.of({ sendGuide, addresses, report, send })
    })
  )

  /** A Hub client whose calls are `fakes`; each one not given does nothing, and `addresses` lists none. */
  static layerTest(fakes: Partial<HubClient["Service"]> = {}): Layer.Layer<HubClient> {
    return Layer.succeed(
      HubClient,
      HubClient.of({
        sendGuide: () => Effect.void,
        addresses: Effect.succeed([]),
        report: () => Effect.void,
        send: () => Effect.void,
        ...fakes
      })
    )
  }
}
