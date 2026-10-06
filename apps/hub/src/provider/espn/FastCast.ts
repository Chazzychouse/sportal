import type { LeagueId } from "@sportal/domain/League"
import { Channel, Effect, Layer, Metric, Option, Queue, Result, Schema, Sink, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { LiveFeed, LiveFeedError } from "../LiveFeed.ts"
import * as FastCastDocument from "./FastCastDocument.ts"
import * as FastCastPayload from "./FastCastPayload.ts"

/** ESPN FastCast as the live feed: one socket subscribed to each league's scoreboard topic. */
export const layer: Layer.Layer<LiveFeed, never, HttpClient.HttpClient | Socket.WebSocketConstructor> =
  Layer.effect(
    LiveFeed,
    Effect.gen(function* () {
      const provide = Stream.provideContext(
        yield* Effect.context<HttpClient.HttpClient | Socket.WebSocketConstructor>()
      )
      return LiveFeed.of({
        games: (leagues) => provide(FastCastDocument.batches(leagues, provide(messages(leagues))))
      })
    })
  )

/** Every message after the handshake, failing when the socket closes, ends, or goes quiet. */
function messages(
  leagues: ReadonlyArray<LeagueId>
): Stream.Stream<
  typeof FastCastPayload.Message.Type,
  LiveFeedError,
  HttpClient.HttpClient | Socket.WebSocketConstructor
> {
  return Stream.unwrap(connect(leagues)).pipe(
    Stream.concat(Stream.fail(new LiveFeedError({ reason: "Closed", cause: "FastCast ended the stream" }))),
    Stream.timeoutOrElse({ duration: silence, orElse: () => Stream.fail(silent()) })
  )
}

/** Opens the socket and subscribes to each league's topic, returning the messages that follow. */
function connect(leagues: ReadonlyArray<LeagueId>) {
  const topics = leagues.map(FastCastDocument.topic)
  return Effect.gen(function* () {
    const host = yield* websocketHost
    const outgoing = yield* Queue.unbounded<string>()
    yield* Queue.offer(outgoing, JSON.stringify({ op: "C" }))
    const socket = yield* Socket.makeWebSocket(
      `wss://${host.ip}:${host.securePort}/FastcastService/pubsub/profiles/12000?TrafficManager-Token=${encodeURIComponent(host.token)}`
    )
    const [first, rest] = yield* Channel.fromQueueArray(outgoing).pipe(
      Channel.pipeTo(Socket.toChannelString(socket)),
      Stream.fromChannel,
      Stream.mapError((cause) => new LiveFeedError({ reason: "Closed", cause })),
      Stream.filterMapEffect(decoded),
      // One message per chunk, so peeling the first leaves the rest of its frame batch in the stream.
      Stream.rechunk(1),
      Stream.peel(Sink.head()),
      Effect.timeoutOrElse({ duration: silence, orElse: () => Effect.fail(silent()) })
    )
    const sid = yield* Option.match(first, {
      onNone: () =>
        Effect.fail(new LiveFeedError({ reason: "Closed", cause: "FastCast closed before connecting" })),
      onSome: (message) =>
        message.op === "C"
          ? Effect.succeed(message.sid)
          : Effect.fail(new LiveFeedError({ reason: "Refused", cause: `FastCast opened with ${message.op}` }))
    })
    yield* Queue.offerAll(
      outgoing,
      topics.map((tc) => JSON.stringify({ op: "S", sid, tc }))
    )
    yield* Metric.update(connected, 1)
    yield* Effect.addFinalizer(() => Metric.update(connected, 0))
    yield* Metric.update(connects, 1)
    yield* Effect.logInfo(`FastCast: connected to ${host.ip}, subscribed to ${topics.join(", ")}`)
    return rest
  }).pipe(Effect.withSpan("FastCast.connect", { attributes: { "sportal.topics": topics } }))
}

// FastCast sends `B` itself after 10 s without another frame (it answers a client's `B` with an error, so the client
// never sends one); live, a subscribed socket went at most 20 s between frames.
const silence = "45 seconds"

function silent(): LiveFeedError {
  return new LiveFeedError({ reason: "Silent", cause: `No FastCast message for ${silence}` })
}

const websocketHost = HttpClient.get("https://fastcast.semfs.engsvc.go.com/public/websockethost").pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.flatMap(HttpClientResponse.schemaBodyJson(FastCastPayload.Host)),
  Effect.mapError((cause) => new LiveFeedError({ reason: "Refused", cause }))
)

/** A frame as a message; a frame of an op FastCast is not known to send is skipped, a known one that fails is not. */
function decoded(
  frame: string
): Effect.Effect<Result.Result<typeof FastCastPayload.Message.Type, string>, LiveFeedError> {
  return decodeFrame(frame).pipe(
    Effect.map(Result.succeed),
    Effect.catch((cause) =>
      Option.isSome(decodeKnownOp(frame))
        ? Effect.fail(new LiveFeedError({ reason: "Unapplicable", cause }))
        : Effect.logDebug("FastCast: skipped a frame of an unknown op", frame).pipe(
            Effect.as(Result.fail(frame))
          )
    )
  )
}

const decodeFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(FastCastPayload.Message))

const decodeKnownOp = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union(FastCastPayload.Message.members.map((member) => Schema.Struct({ op: member.fields.op })))
  )
)

const connected = Metric.gauge("sportal_live_feed_connected", {
  description: "Whether the live feed is subscribed (1) or not (0)"
})

const connects = Metric.counter("sportal_live_feed_connects", {
  description: "Times the live feed connected and subscribed",
  incremental: true
})
