import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Deferred, Effect, Layer, Queue, Ref, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"
import type { Frame } from "../../feed/Frame.ts"
import { LiveFeed, type LiveFeedError } from "../LiveFeed.ts"
import * as FastCast from "./FastCast.ts"

describe("FastCast", () => {
  it.effect("a socket FastCast closes cleanly fails with Closed, so Ingest subscribes again", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { ended } = yield* nflFrames(server)
      yield* settled
      yield* Effect.sync(() => server.close(1000))

      assert.strictEqual((yield* Effect.flip(Deferred.await(ended))).reason, "Closed")
    })
  )

  it.effect("FastCast's own heartbeats keep the socket open; 45 s without any frame fails with Silent", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { ended } = yield* nflFrames(server)
      yield* settled
      assert.deepStrictEqual(server.sent(), [
        { op: "C" },
        { op: "S", sid: "sid-1", tc: "event-football-nfl" }
      ])

      // FastCast sends `B` after 10 s of nothing else; a gap of 20 s was seen live.
      yield* TestClock.adjust("20 seconds")
      yield* Effect.sync(() => server.send({ op: "B" }))
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

  it.effect("each socket text is a message frame, and an H is followed by its checkpoint", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* settled
      yield* Effect.sync(() => server.send(checkpointMessage(7)))
      yield* settled

      assert.deepStrictEqual(
        (yield* Ref.get(frames)).map(({ channel, kind, sourceId, body }) => ({
          channel,
          kind,
          sourceId,
          body: kind === "checkpoint" ? body : decodeSent(body).op
        })),
        [
          { channel: "socket", kind: "message", sourceId: undefined, body: "C" },
          { channel: "event-football-nfl", kind: "message", sourceId: undefined, body: "S" },
          { channel: "event-football-nfl", kind: "message", sourceId: 7, body: "H" },
          { channel: "event-football-nfl", kind: "checkpoint", sourceId: 7, body: checkpointBody }
        ]
      )
      assert.isTrue((yield* Ref.get(frames)).every((frame) => frame.feed === "fastcast"))
    })
  )

  it.effect("a patch's frame carries its mid and the time FastCast sent it", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* settled
      yield* Effect.sync(() => server.send(patchMessage(8)))
      yield* settled
      const patch = (yield* Ref.get(frames)).at(-1)

      assert.strictEqual(patch?.sourceId, 8)
      assert.strictEqual(patch?.sentAt?.epochMilliseconds, 1791136341731)
    })
  )

  it.effect("a newly wanted game subscribes its game topic once", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { wanted } = yield* nflFrames(server)
      yield* settled
      const gameTopics = () => server.sent().flatMap((frame) => (frame.tc?.startsWith("gp-") ? [frame] : []))

      yield* Queue.offer(wanted, [nflGame("401872971")])
      yield* settled
      assert.deepStrictEqual(gameTopics(), [{ op: "S", sid: "sid-1", tc: "gp-football-nfl-401872971" }])

      yield* Queue.offer(wanted, [nflGame("401872971")])
      yield* settled
      assert.strictEqual(gameTopics().length, 1, "the same game wanted again sends none")

      yield* Queue.offer(wanted, [nflGame("401872971"), nflGame("401872972")])
      yield* settled
      assert.deepStrictEqual(
        gameTopics().map((frame) => frame.tc),
        ["gp-football-nfl-401872971", "gp-football-nfl-401872972"]
      )
    })
  )

  it.effect("a missed message on a topic subscribes to that topic again, for a fresh checkpoint", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      yield* nflFrames(server)
      yield* settled
      yield* Effect.sync(() => server.send(checkpointMessage(7)))
      yield* settled
      yield* Effect.sync(() => {
        server.send(patchMessage(8))
        server.send(patchMessage(10))
        server.send(patchMessage(11))
      })
      yield* settled

      assert.deepStrictEqual(
        server.sent().filter((frame) => frame.op === "S"),
        [
          { op: "S", sid: "sid-1", tc: "event-football-nfl" },
          { op: "S", sid: "sid-1", tc: "event-football-nfl" }
        ]
      )
    })
  )

  it.effect("games, until Ingest takes frames, are the pushed games of each message", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const games = yield* Ref.make<ReadonlyArray<ReadonlyArray<GameSnapshot>>>([])
      yield* LiveFeed.use((feed) =>
        feed.games(["nfl"]).pipe(Stream.runForEach((batch) => Ref.update(games, (all) => [...all, batch])))
      ).pipe(Effect.provide(fastCast(server)), Effect.forkChild({ startImmediately: true }))
      yield* settled
      yield* Effect.sync(() => server.send(checkpointMessage(7)))
      yield* settled

      assert.deepStrictEqual(
        (yield* Ref.get(games)).map((batch) => batch.length),
        [16]
      )
    })
  )
})

/**
 * Runs FastCast's frames for the NFL over `server` in a fiber of its own, collecting them into `frames` and completing
 * `ended` with how it ended. `wanted` takes the current games.
 */
function nflFrames(server: ReturnType<typeof fakeServer>) {
  return Effect.gen(function* () {
    const ended = yield* Deferred.make<void, LiveFeedError>()
    const frames = yield* Ref.make<ReadonlyArray<Omit<Frame, "seq">>>([])
    const wanted = yield* Queue.unbounded<ReadonlyArray<GameSnapshot>>()
    yield* LiveFeed.use((feed) =>
      feed
        .frames(["nfl"], Stream.fromQueue(wanted))
        .pipe(Stream.runForEach((frame) => Ref.update(frames, (all) => [...all, frame])))
    ).pipe(Deferred.into(ended), Effect.forkChild({ startImmediately: true }))
    return { ended, frames, wanted }
  }).pipe(Effect.provide(fastCast(server)))
}

function fastCast(server: ReturnType<typeof fakeServer>) {
  return FastCast.layer.pipe(
    Layer.provide([
      Layer.succeed(HttpClient.HttpClient, espn),
      Layer.succeed(Socket.WebSocketConstructor, () => server.socket)
    ])
  )
}

// Lets every fiber of the feed run: a frame passes through several before it is collected.
const settled = Effect.repeat(Effect.yieldNow, { times: 50 })

function nflGame(id: string) {
  return snapshot({ id: GameId.make(id), league: "nfl", status: "live" })
}

function checkpointMessage(mid: number) {
  return { op: "H", tc: "event-football-nfl", mid, pl: `https://checkpoint.test/${mid}` }
}

function patchMessage(mid: number) {
  return { op: "P", tc: "event-football-nfl", mid, pl: JSON.stringify({ ts: 1791136341731, pl: [] }) }
}

const checkpointBody = readFileSync(
  new URL("./fixtures/nfl-fastcast-checkpoint-2026-10-04T1752Z.json", import.meta.url),
  "utf8"
)

// FastCast's host lookup, and any checkpoint, which is the recorded one.
const espn = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(
        request.url.includes("websockethost")
          ? JSON.stringify({ ip: "fastcast.test", securePort: 443, token: "token" })
          : checkpointBody
      )
    )
  )
)

/**
 * One open socket that answers the handshake and each subscription as FastCast does, recording each frame the client
 * sends; the test sends the rest and closes it.
 */
function fakeServer() {
  const listeners = new Set<{
    readonly type: string
    readonly listener: (event: Socket.WebSocketEvent) => void
  }>()
  const frames: Array<typeof Sent.Type> = []
  const emit = (type: string, event: Socket.WebSocketEvent) =>
    [...listeners]
      .filter((entry) => entry.type === type)
      .forEach((entry) => {
        entry.listener(event)
      })
  const send = (data: object) => emit("message", { data: JSON.stringify(data) })
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
      const frame = decodeSent(String(data))
      frames.push(frame)
      if (frame.op === "C") send({ hbi: 30, rc: 200, sid: "sid-1", op: "C" })
      if (frame.op === "S") send({ rc: 200, sid: frame.sid, tc: frame.tc, op: "S" })
    }
  }
  return {
    socket,
    sent: () => [...frames],
    send,
    close: (code: number) => emit("close", { code, reason: "" })
  }
}

const Sent = Schema.Struct({
  op: Schema.String,
  sid: Schema.optionalKey(Schema.String),
  tc: Schema.optionalKey(Schema.String)
})

const decodeSent = Schema.decodeUnknownSync(Schema.fromJsonString(Sent))
