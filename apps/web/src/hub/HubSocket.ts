import { HubApi } from "@sportal/api/HubApi"
import { Context, Data, DateTime, Effect, Layer, Option, Schedule, Stream, SubscriptionRef } from "effect"
import { type Rpc, RpcClient, RpcClientError, type RpcGroup, RpcSerialization, RpcTest } from "effect/rpc"
import { Socket } from "effect/socket"

/**
 * The web UI's one WebSocket to the Hub, at `/api/socket` on the page's host: the whole `HubApi` goes over it, every
 * request and every live query, however many views ask. It opens with the web runtime, and the RPC client opens it again once
 * lost: after half a second, then half as long again each time, up to 5 seconds.
 */
export class HubSocket extends Context.Service<
  HubSocket,
  {
    /** The typed client of `HubApi`, for a request; one sent while the socket is down fails with `RpcClientError`. */
    readonly client: HubApiClient
    /** Whether the socket is up: now, then each change. */
    readonly connection: Stream.Stream<Connection>
    /**
     * The stream `query` asks the Hub for, while the socket is connected: ended when it is lost, and asked again each
     * time it connects, so the Hub's first answer to each asking replaces what came before. A query the Hub refuses,
     * such as a game it has not listed yet, is logged and asked again every 10 seconds while it is read.
     */
    readonly live: <A, E>(query: (client: HubApiClient) => Stream.Stream<A, E>) => Stream.Stream<A>
  }
>()("sportal/web/hub/HubSocket") {
  static readonly layer: Layer.Layer<HubSocket> = Layer.effect(
    HubSocket,
    Effect.gen(function* () {
      const connection = yield* SubscriptionRef.make<Connection>(Connection.Connecting())
      const hooks = {
        onConnect: SubscriptionRef.set(connection, Connection.Connected()),
        onDisconnect: lost(connection)
      }
      const protocol = yield* RpcClient.makeProtocolSocket().pipe(
        Effect.provideService(RpcClient.ConnectionHooks, hooks)
      )
      const client = yield* RpcClient.make(HubApi).pipe(Effect.provideService(RpcClient.Protocol, protocol))

      return HubSocket.of(over(client, connection))
    })
  ).pipe(
    Layer.provide([Socket.layerWebSocket(Effect.sync(socketUrl)), RpcSerialization.layerJson]),
    Layer.provide(Socket.layerWebSocketConstructorGlobal)
  )

  /** A socket whose connection is `connection`, the test's to set, and whose queries `handlers` answer in memory. */
  static layerTest(
    connection: SubscriptionRef.SubscriptionRef<Connection>,
    handlers: Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof HubApi>>>
  ): Layer.Layer<HubSocket> {
    return Layer.effect(
      HubSocket,
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(HubApi)

        return HubSocket.of(over(client, connection))
      })
    ).pipe(Layer.provide(handlers))
  }
}

/** The typed client of the Hub's API, which each request and live query is asked through. */
export type HubApiClient = RpcClient.FromGroup<typeof HubApi, RpcClientError.RpcClientError>

/** Whether the Hub socket is up: not connected yet, connected, or lost at an instant and reconnecting. */
export type Connection = Data.TaggedEnum<{
  Connecting: object
  Connected: object
  Lost: { readonly since: DateTime.Utc }
}>
export const Connection = Data.taggedEnum<Connection>()

/**
 * Marks a connected socket lost, now. The client calls it after every attempt, a failed open included: one that was
 * never up stays connecting, and one already lost keeps its instant, publishing nothing.
 */
function lost(connection: SubscriptionRef.SubscriptionRef<Connection>) {
  return Effect.flatMap(DateTime.now, (since) =>
    SubscriptionRef.updateSome(connection, (current) =>
      Connection.$is("Connected")(current) ? Option.some(Connection.Lost({ since })) : Option.none()
    )
  )
}

/** The socket's service over `client`, asking each query while `connection` is connected. */
function over(
  client: HubApiClient,
  connection: SubscriptionRef.SubscriptionRef<Connection>
): HubSocket["Service"] {
  const changes = SubscriptionRef.changes(connection)
  return {
    client,
    connection: changes,
    live: (query) =>
      changes.pipe(
        Stream.switchMap((current) =>
          Connection.$is("Connected")(current) ? asked(query(client)) : Stream.empty
        )
      )
  }
}

/**
 * A live query asked while the socket is up: it ends quietly when the socket is lost, which the connection shows, and
 * a refusal is logged and asked again 10 seconds later.
 */
function asked<A, E>(answers: Stream.Stream<A, E>): Stream.Stream<A> {
  return answers.pipe(
    Stream.catchIf(
      (error) => error instanceof RpcClientError.RpcClientError,
      () => Stream.empty
    ),
    Stream.tapError((refused) =>
      Effect.logWarning("The Hub refused a live query; asking again in 10 s", refused)
    ),
    Stream.retry(Schedule.spaced("10 seconds")),
    // A spaced schedule never ends, so the retry never gives up and fails.
    Stream.orDie
  )
}

/** `/api/socket` on the host this page came from, the dev server's proxy included, as a WebSocket address. */
function socketUrl(): string {
  const url = new URL("/api/socket", location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.href
}
