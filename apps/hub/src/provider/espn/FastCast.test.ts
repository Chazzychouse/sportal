import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Deferred, Effect, Layer, Queue, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"
import type { FeedFrame } from "../../Frame.ts"
import { counted, recordingLogs, withMetrics } from "../../TestTelemetry.ts"
import type { ProviderError } from "../Provider.ts"
import * as FastCast from "./FastCast.ts"

describe("FastCast", () => {
  it.effect("a socket FastCast closes cleanly fails with Closed, so Ingest subscribes again", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { ended } = yield* nflFrames(server)
      yield* server.sent.until(subscribed("event-football-nfl", 1))
      yield* Effect.sync(() => server.close(1000))

      assert.strictEqual((yield* Effect.flip(Deferred.await(ended))).reason, "Closed")
    })
  )

  it.effect("FastCast's own heartbeats keep the socket open; 45 s without any frame fails with Silent", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { ended, frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      assert.deepStrictEqual(server.sent.all(), [
        { op: "C" },
        { op: "S", sid: "sid-1", tc: "event-football-nfl" }
      ])

      // FastCast sends `B` after 10 s of nothing else; a gap of 20 s was seen live.
      yield* TestClock.adjust("20 seconds")
      yield* Effect.sync(() => server.send({ op: "B" }))
      yield* frames.until(atLeast(3))
      yield* TestClock.adjust("40 seconds")
      assert.isFalse(yield* Deferred.isDone(ended))

      yield* TestClock.adjust("5 seconds")
      assert.strictEqual((yield* Effect.flip(Deferred.await(ended))).reason, "Silent")
      assert.isFalse(
        server.sent.all().some((frame) => frame.op === "B"),
        "the client never heartbeats"
      )
    })
  )

  it.effect("each socket text is a message frame, and an H is followed by its checkpoint", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(checkpointMessage(7)))
      const received = yield* frames.until(atLeast(4))

      assert.deepStrictEqual(
        received.map(({ channel, kind, sourceId, body }) => ({
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
      assert.isTrue(received.every((frame) => frame.feed === "fastcast"))
    })
  )

  it.effect("a patch's frame carries its mid and the time FastCast sent it", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(patchMessage(8)))
      const patch = (yield* frames.until(atLeast(3))).at(-1)

      assert.strictEqual(patch?.sourceId, 8)
      assert.strictEqual(patch?.sentAt?.epochMilliseconds, 1791136341731)
    })
  )

  it.effect("a newly wanted game subscribes its game topic once", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { wanted } = yield* nflFrames(server)
      const gameTopics = () =>
        server.sent.all().flatMap((frame) => (frame.tc?.startsWith("gp-") ? [frame] : []))

      yield* Queue.offer(wanted, [nflGame("401872971")])
      yield* server.sent.until(subscribed("gp-football-nfl-401872971", 1))
      assert.deepStrictEqual(gameTopics(), [{ op: "S", sid: "sid-1", tc: "gp-football-nfl-401872971" }])

      // Wanted changes are taken in order, so once the third has subscribed, the second has sent all it would.
      yield* Queue.offer(wanted, [nflGame("401872971")])
      yield* Queue.offer(wanted, [nflGame("401872971"), nflGame("401872972")])
      yield* server.sent.until(subscribed("gp-football-nfl-401872972", 1))
      assert.deepStrictEqual(
        gameTopics().map((frame) => frame.tc),
        ["gp-football-nfl-401872971", "gp-football-nfl-401872972"],
        "the same game wanted again sends none"
      )
    })
  )

  it.effect(
    "a checkpoint that does not load is counted, keeps the socket and the other topics, and subscribes again after 30 s",
    () =>
      Effect.gen(function* () {
        const { logs, layer } = recordingLogs()
        const server = fakeServer()
        const missing = "gp-football-nfl-401872971"
        const other = "gp-football-nfl-401872972"
        const { ended, frames, wanted } = yield* nflFrames(server).pipe(Effect.provide(layer))
        yield* Queue.offer(wanted, [nflGame("401872971"), nflGame("401872972")])
        yield* server.sent.until(subscribed(other, 1))
        yield* Effect.sync(() => {
          server.send({ op: "H", tc: missing, mid: 5, pl: "https://checkpoint.test/missing" })
          server.send({ op: "H", tc: other, mid: 9, pl: "https://checkpoint.test/9" })
          server.send({ ...patchMessage(10), tc: other })
          server.send(checkpointMessage(7))
        })
        const received = yield* frames.until((all) =>
          all.some((frame) => frame.channel === "event-football-nfl" && frame.kind === "checkpoint")
        )

        assert.deepStrictEqual(
          received.flatMap(({ channel, kind, sourceId }) =>
            channel.startsWith("gp-") ? [[channel, kind, sourceId]] : []
          ),
          [
            [missing, "message", undefined],
            [other, "message", undefined],
            [missing, "message", 5],
            [other, "message", 9],
            [other, "checkpoint", 9],
            [other, "message", 10]
          ]
        )
        assert.isFalse(yield* Deferred.isDone(ended))
        assert.strictEqual(yield* counted("sportal_live_feed_checkpoint_failures", { league: "nfl" }), 1)
        assert.isTrue(logs.some((log) => log.level === "Warn" && log.annotations.topic === missing))
        assert.lengthOf(
          server.sent.all().filter((frame) => frame.op === "S" && frame.tc === missing),
          1
        )

        yield* TestClock.adjust("30 seconds")
        yield* server.sent.until(subscribed(missing, 2))
        assert.isFalse(yield* Deferred.isDone(ended))
      }).pipe(withMetrics)
  )

  it.effect(
    "a topic its decoder resyncs is subscribed to again, only while it is followed on this socket",
    () =>
      Effect.gen(function* () {
        const server = fakeServer()
        const { frames, resync } = yield* nflFrames(server)
        yield* frames.until(atLeast(2))
        yield* Effect.sync(() => server.send(checkpointMessage(7)))
        yield* frames.until(atLeast(4))

        yield* Queue.offer(resync, "gp-football-nfl-401872971")
        yield* Queue.offer(resync, "event-football-nfl")
        yield* server.sent.until(subscribed("event-football-nfl", 2))
        // Waiting for its checkpoint already: a second resync asks for nothing more.
        yield* Queue.offer(resync, "event-football-nfl")
        yield* Effect.sync(() => server.send(checkpointMessage(20)))
        yield* frames.until((all) =>
          all.some((frame) => frame.kind === "checkpoint" && frame.sourceId === 20)
        )

        assert.deepStrictEqual(
          server.sent.all().filter((frame) => frame.op === "S"),
          [
            { op: "S", sid: "sid-1", tc: "event-football-nfl" },
            { op: "S", sid: "sid-1", tc: "event-football-nfl" }
          ]
        )
      })
  )

  it.effect("a checkpoint that hangs fails after 20 s, and its topic is subscribed to again 30 s later", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { ended, frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() =>
        server.send({ op: "H", tc: "event-football-nfl", mid: 7, pl: "https://checkpoint.test/hang" })
      )
      yield* TestClock.adjust("19 seconds")
      assert.lengthOf(yield* frames.until(atLeast(2)), 2, "the H waits for its checkpoint")

      yield* TestClock.adjust("1 second")
      yield* frames.until(atLeast(3))
      assert.strictEqual(yield* counted("sportal_live_feed_checkpoint_failures", { league: "nfl" }), 1)
      yield* TestClock.adjust("30 seconds")
      yield* server.sent.until(subscribed("event-football-nfl", 2))
      assert.isFalse(yield* Deferred.isDone(ended))
    }).pipe(withMetrics)
  )

  it.effect("a topic whose checkpoints keep failing has one subscription pending at a time", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => {
        server.send(missingCheckpoint(5))
        server.send(missingCheckpoint(6))
      })
      yield* frames.until(atLeast(4))
      yield* TestClock.adjust("30 seconds")
      yield* server.sent.until(subscribed("event-football-nfl", 2))
      yield* TestClock.adjust("30 seconds")

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S"),
        2
      )
    })
  )

  it.effect("after five checkpoint failures in a row a topic is not subscribed to again, said once", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
      const server = fakeServer()
      const { frames } = yield* nflFrames(server).pipe(Effect.provide(layer))
      yield* frames.until(atLeast(2))
      yield* Effect.forEach(
        [1, 2, 3, 4],
        (failure) =>
          Effect.sync(() => server.send(missingCheckpoint(failure))).pipe(
            Effect.andThen(frames.until((all) => all.some((frame) => frame.sourceId === failure))),
            Effect.andThen(TestClock.adjust("30 seconds")),
            Effect.andThen(server.sent.until(subscribed("event-football-nfl", failure + 1)))
          ),
        { discard: true }
      )
      yield* Effect.sync(() => server.send(missingCheckpoint(5)))
      yield* frames.until((all) => all.some((frame) => frame.sourceId === 5))
      yield* TestClock.adjust("30 seconds")

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S"),
        5
      )
      const gaveUp = logs.filter((log) => log.message.includes("not subscribing to it again"))
      assert.lengthOf(gaveUp, 1)
      assert.strictEqual(gaveUp[0]?.level, "Warn")
    })
  )
})

/**
 * Runs FastCast's push for the NFL over `server` in a fiber of its own, collecting them into `frames` and completing
 * `ended` with how it ended. `wanted` takes the current games, and `resync` the topics their decoder resyncs.
 */
function nflFrames(server: ReturnType<typeof fakeServer>) {
  return Effect.gen(function* () {
    const ended = yield* Deferred.make<void, ProviderError>()
    const frames = watched<FeedFrame>()
    const wanted = yield* Queue.unbounded<ReadonlyArray<GameSnapshot>>()
    const resync = yield* Queue.unbounded<string>()
    yield* FastCast.push(["nfl"], Stream.fromQueue(wanted), Stream.fromQueue(resync)).pipe(
      Stream.runForEach((frame) => Effect.sync(() => frames.add(frame))),
      Deferred.into(ended),
      Effect.forkChild({ startImmediately: true })
    )
    return { ended, frames, wanted, resync }
  }).pipe(Effect.provide(fastCast(server)))
}

/**
 * Values as they arrive, and `until`, which waits for the first moment they satisfy a condition and gives them as
 * they are then.
 */
function watched<A>() {
  const values: Array<A> = []
  const waiting = new Set<{
    readonly satisfied: (all: ReadonlyArray<A>) => boolean
    readonly done: Deferred.Deferred<void>
  }>()
  return {
    add: (value: A) => {
      values.push(value)
      ;[...waiting]
        .filter((waiter) => waiter.satisfied(values))
        .forEach((waiter) => {
          waiting.delete(waiter)
          Deferred.doneUnsafe(waiter.done, Effect.void)
        })
    },
    all: (): ReadonlyArray<A> => [...values],
    until: (satisfied: (all: ReadonlyArray<A>) => boolean): Effect.Effect<ReadonlyArray<A>> =>
      Effect.suspend(() => {
        if (satisfied(values)) return Effect.succeed([...values])
        const done = Deferred.makeUnsafe<void>()
        waiting.add({ satisfied, done })
        return Deferred.await(done).pipe(Effect.map(() => [...values]))
      })
  }
}

function atLeast(count: number) {
  return (all: ReadonlyArray<unknown>) => all.length >= count
}

function subscribed(tc: string, times: number) {
  return (sent: ReadonlyArray<typeof Sent.Type>) =>
    sent.filter((frame) => frame.op === "S" && frame.tc === tc).length >= times
}

function fastCast(server: ReturnType<typeof fakeServer>) {
  return Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, espn),
    Layer.succeed(Socket.WebSocketConstructor, () => server.socket)
  )
}

function nflGame(id: string) {
  return snapshot({ id: GameId.make(id), league: "nfl", status: "live" })
}

function checkpointMessage(mid: number) {
  return { op: "H", tc: "event-football-nfl", mid, pl: `https://checkpoint.test/${mid}` }
}

function missingCheckpoint(mid: number) {
  return { op: "H", tc: "event-football-nfl", mid, pl: "https://checkpoint.test/missing" }
}

function patchMessage(mid: number) {
  return { op: "P", tc: "event-football-nfl", mid, pl: JSON.stringify({ ts: 1791136341731, pl: [] }) }
}

const checkpointBody = readFileSync(
  new URL("./fixtures/nfl-fastcast-checkpoint-2026-10-04T1752Z.json", import.meta.url),
  "utf8"
)

// FastCast's host lookup, and any checkpoint, which is the recorded one, except a missing one and one that never comes.
const espn = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      request.url.includes("websockethost")
        ? new Response(JSON.stringify({ ip: "fastcast.test", securePort: 443, token: "token" }))
        : request.url.endsWith("/missing")
          ? new Response("Not Found", { status: 404 })
          : new Response(checkpointBody)
    )
  ).pipe(
    Effect.andThen((response) => (request.url.endsWith("/hang") ? Effect.never : Effect.succeed(response)))
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
  const sent = watched<typeof Sent.Type>()
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
      if (frame.op === "C") send({ hbi: 30, rc: 200, sid: "sid-1", op: "C" })
      if (frame.op === "S") send({ rc: 200, sid: frame.sid, tc: frame.tc, op: "S" })
      // Recorded after the answer, so a test waiting on this frame sends what follows after it.
      sent.add(frame)
    }
  }
  return {
    socket,
    sent,
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
