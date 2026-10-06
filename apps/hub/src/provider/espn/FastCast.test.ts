import { assert, describe, it } from "@effect/vitest"
import type { GameSnapshot } from "@sportal/domain/Game"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"
import { LiveFeed, type LiveFeedError } from "../LiveFeed.ts"
import * as FastCast from "./FastCast.ts"

describe("FastCast", () => {
  it.effect("a socket FastCast closes cleanly fails with Closed, so Ingest subscribes again", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const ended = yield* nflGames(server)
      yield* TestClock.adjust(0)
      yield* Effect.sync(() => server.close(1000))

      assert.strictEqual((yield* Effect.flip(Deferred.await(ended))).reason, "Closed")
    })
  )

  it.effect("FastCast's own heartbeats keep the socket open; 45 s without any frame fails with Silent", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const ended = yield* nflGames(server)
      yield* TestClock.adjust(0)
      assert.deepStrictEqual(server.sent(), [
        { op: "C" },
        { op: "S", sid: "sid-1", tc: "event-football-nfl" }
      ])

      // FastCast sends `B` after 10 s of nothing else; a gap of 20 s was seen live.
      yield* TestClock.adjust("20 seconds")
      yield* Effect.sync(() => server.heartbeat())
      yield* TestClock.adjust("40 seconds")
      assert.isFalse(yield* Deferred.isDone(ended))

      yield* TestClock.adjust("5 seconds")
      assert.strictEqual((yield* Effect.flip(Deferred.await(ended))).reason, "Silent")
      assert.isFalse(
        server.sent().some((frame) => frame.op === "B"),
        "the client never heartbeats"
      )
    })
  )
})

/** Collects the NFL games of FastCast over `server` in a fiber of its own, completing the result with how it ended. */
function nflGames(server: ReturnType<typeof fakeServer>) {
  return Effect.gen(function* () {
    const ended = yield* Deferred.make<ReadonlyArray<ReadonlyArray<GameSnapshot>>, LiveFeedError>()
    yield* LiveFeed.use((feed) => feed.games(["nfl"]).pipe(Stream.runCollect)).pipe(
      Deferred.into(ended),
      Effect.forkChild({ startImmediately: true })
    )
    return ended
  }).pipe(
    Effect.provide(
      FastCast.layer.pipe(
        Layer.provide([
          Layer.succeed(HttpClient.HttpClient, websocketHost),
          Layer.succeed(Socket.WebSocketConstructor, () => server.socket)
        ])
      )
    )
  )
}

const websocketHost = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify({ ip: "fastcast.test", securePort: 443, token: "token" }))
    )
  )
)

/**
 * One open socket that answers the handshake as FastCast does, recording each frame the client sends; the test sends
 * heartbeats and closes it.
 */
function fakeServer() {
  const listeners = new Set<{
    readonly type: string
    readonly listener: (event: Socket.WebSocketEvent) => void
  }>()
  const frames: Array<typeof Frame.Type> = []
  const emit = (type: string, event: Socket.WebSocketEvent) =>
    [...listeners]
      .filter((entry) => entry.type === type)
      .forEach((entry) => {
        entry.listener(event)
      })
  const message = (data: object) => emit("message", { data: JSON.stringify(data) })
  const socket: Socket.WebSocketLike = {
    readyState: 1,
    addEventListener: (type, listener) => {
      listeners.add({ type, listener })
    },
    removeEventListener: (type, listener) =>
      [...listeners]
        .filter((entry) => entry.type === type && entry.listener === listener)
        .forEach((entry) => {
          listeners.delete(entry)
        }),
    close: () => {},
    send: (data) => {
      const frame = decodeFrame(String(data))
      frames.push(frame)
      if (frame.op === "C") message({ hbi: 30, rc: 200, sid: "sid-1", op: "C" })
      if (frame.op === "S") message({ rc: 200, sid: frame.sid, tc: frame.tc, op: "S" })
    }
  }
  return {
    socket,
    sent: () => [...frames],
    heartbeat: () => message({ op: "B" }),
    close: (code: number) => emit("close", { code, reason: "" })
  }
}

const Frame = Schema.Struct({
  op: Schema.String,
  sid: Schema.optionalKey(Schema.String),
  tc: Schema.optionalKey(Schema.String)
})

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame))
