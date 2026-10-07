import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { Deferred, Effect, Layer, Queue, Schedule, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"
import type { FeedFrame } from "../../Frame.ts"
import { HubConfig } from "../../HubConfig.ts"
import { counted, recordingLogs, withMetrics } from "../../TestTelemetry.ts"
import { LiveFeedDemand, type ProviderUnavailable } from "../Provider.ts"
import { FastCast } from "./FastCast.ts"

// Two games' topics: the first's checkpoint is missing in the tests that follow both.
const missingTopic = "gp-football-nfl-401872971"
const otherTopic = "gp-football-nfl-401872972"

describe("FastCast", () => {
  it.effect(
    "should fail with Closed when FastCast closes the socket cleanly, so Ingest subscribes again",
    () =>
      Effect.gen(function* () {
        const server = fakeServer()
        const { ended } = yield* nflFrames(server)
        yield* server.sent.until(subscribed("event-football-nfl", 1))

        yield* Effect.sync(() => server.close(1000))

        const error = yield* Effect.flip(Deferred.await(ended))
        assert.strictEqual(error.reason, "Closed")
      })
  )

  it.effect("should connect, then subscribe to its league's scoreboard topic", () =>
    Effect.gen(function* () {
      const server = fakeServer()

      const { frames } = yield* nflFrames(server)

      yield* frames.until(atLeast(2))
      assert.deepStrictEqual(server.sent.all(), [
        { op: "C" },
        { op: "S", sid: "sid-1", tc: "event-football-nfl" }
      ])
    })
  )

  it.effect("should keep the socket open on FastCast's own heartbeats", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { ended, frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      // FastCast sends `B` after 10 s of nothing else; a gap of 20 s was seen live.
      yield* TestClock.adjust("20 seconds")

      yield* Effect.sync(() => server.send({ op: "B" }))
      yield* frames.until(atLeast(3))
      yield* TestClock.adjust("40 seconds")

      const done = yield* Deferred.isDone(ended)
      assert.isFalse(done)
    })
  )

  it.effect("should fail with Silent 45 s after its last frame, never heartbeating itself", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { ended, frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* TestClock.adjust("20 seconds")
      yield* Effect.sync(() => server.send({ op: "B" }))
      yield* frames.until(atLeast(3))
      yield* TestClock.adjust("40 seconds")

      yield* TestClock.adjust("5 seconds")

      const error = yield* Effect.flip(Deferred.await(ended))
      assert.strictEqual(error.reason, "Silent")
      assert.isFalse(
        server.sent.all().some((frame) => frame.op === "B"),
        "the client never heartbeats"
      )
    })
  )

  it.effect("should emit each socket text as a message frame, and an H's checkpoint after it", () =>
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

  it.effect("should give a patch's frame its mid and the time FastCast sent it", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send(patchMessage(8)))

      const received = yield* frames.until(atLeast(3))
      const patch = received.at(-1)
      assert.strictEqual(patch?.sourceId, 8)
      assert.strictEqual(patch?.sentAt?.epochMilliseconds, 1791136341731)
    })
  )

  it.effect("should subscribe a newly wanted game's topic", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { demand } = yield* nflFrames(server)

      yield* Queue.offer(demand, LiveFeedDemand.Games({ games: [nflGame("401872971")] }))

      yield* server.sent.until(subscribed("gp-football-nfl-401872971", 1))
      assert.deepStrictEqual(gameTopicsSent(server), [
        { op: "S", sid: "sid-1", tc: "gp-football-nfl-401872971" }
      ])
    })
  )

  it.effect("should not subscribe a game's topic again when the game is wanted again", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { demand } = yield* nflFrames(server)
      yield* Queue.offer(demand, LiveFeedDemand.Games({ games: [nflGame("401872971")] }))
      yield* server.sent.until(subscribed("gp-football-nfl-401872971", 1))

      yield* Queue.offer(demand, LiveFeedDemand.Games({ games: [nflGame("401872971")] }))
      yield* Queue.offer(
        demand,
        LiveFeedDemand.Games({ games: [nflGame("401872971"), nflGame("401872972")] })
      )

      // Wanted changes are taken in order, so once the third has subscribed, the second has sent all it would.
      yield* server.sent.until(subscribed("gp-football-nfl-401872972", 1))
      assert.deepStrictEqual(
        gameTopicsSent(server).map((frame) => frame.tc),
        ["gp-football-nfl-401872971", "gp-football-nfl-401872972"],
        "the same game wanted again sends none"
      )
    })
  )

  it.effect(
    "should keep the socket and the other topics when a checkpoint does not load, counting it and warning of it",
    () =>
      Effect.gen(function* () {
        const { logs, layer } = recordingLogs()
        const server = fakeServer()
        const { ended, frames } = yield* twoGamesFollowed(server, layer)

        yield* missingCheckpointBesideOther(server)

        const received = yield* frames.until((all) =>
          all.some((frame) => frame.channel === "event-football-nfl" && frame.kind === "checkpoint")
        )
        const done = yield* Deferred.isDone(ended)
        const failures = yield* counted("sportal_live_feed_checkpoint_failures", { league: "nfl" })
        assert.deepStrictEqual(
          received.flatMap(({ channel, kind, sourceId }) =>
            channel.startsWith("gp-") ? [[channel, kind, sourceId]] : []
          ),
          [
            [missingTopic, "message", undefined],
            [otherTopic, "message", undefined],
            [missingTopic, "message", 5],
            [otherTopic, "message", 9],
            [otherTopic, "checkpoint", 9],
            [otherTopic, "message", 10]
          ]
        )
        assert.isFalse(done)
        assert.strictEqual(failures, 1)
        assert.isTrue(logs.some((log) => log.level === "Warn" && log.annotations.topic === missingTopic))
        assert.lengthOf(
          server.sent.all().filter((frame) => frame.op === "S" && frame.tc === missingTopic),
          1
        )
      }).pipe(withMetrics)
  )

  it.effect(
    "should subscribe a topic whose checkpoint did not load again after 30 s, keeping the socket",
    () =>
      Effect.gen(function* () {
        const server = fakeServer()
        const { ended, frames } = yield* twoGamesFollowed(server, Layer.empty)
        yield* missingCheckpointBesideOther(server)
        yield* frames.until((all) =>
          all.some((frame) => frame.channel === "event-football-nfl" && frame.kind === "checkpoint")
        )

        yield* TestClock.adjust("30 seconds")

        yield* server.sent.until(subscribed(missingTopic, 2))
        const done = yield* Deferred.isDone(ended)
        assert.isFalse(done)
      })
  )

  it.effect(
    "should subscribe a topic its decoder resyncs again, only while it is followed on this socket",
    () =>
      Effect.gen(function* () {
        const server = fakeServer()
        const { frames, demand } = yield* nflFrames(server)
        yield* frames.until(atLeast(2))
        yield* Effect.sync(() => server.send(checkpointMessage(7)))
        yield* frames.until(atLeast(4))

        yield* Queue.offer(demand, LiveFeedDemand.Resync({ channel: "gp-football-nfl-401872971" }))
        yield* Queue.offer(demand, LiveFeedDemand.Resync({ channel: "event-football-nfl" }))
        yield* server.sent.until(subscribed("event-football-nfl", 2))
        // Waiting for its checkpoint already: a second resync asks for nothing more.
        yield* Queue.offer(demand, LiveFeedDemand.Resync({ channel: "event-football-nfl" }))
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

  it.effect("should wait up to 20 s for a checkpoint", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* hangingCheckpoint(server, Layer.empty)

      yield* TestClock.adjust("19 seconds")

      const received = yield* frames.until(atLeast(2))
      assert.lengthOf(received, 2, "the H waits for its checkpoint")
    })
  )

  it.effect("should fail a checkpoint that hangs for 20 s as Unloaded, counting it and warning of it", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
      const server = fakeServer()
      const { frames } = yield* hangingCheckpoint(server, layer)
      yield* TestClock.adjust("19 seconds")

      yield* TestClock.adjust("1 second")

      yield* frames.until(atLeast(3))
      const failures = yield* counted("sportal_live_feed_checkpoint_failures", { league: "nfl" })
      assert.strictEqual(failures, 1)
      assert.isTrue(logs.some((log) => log.level === "Warn" && log.annotations.reason === "Unloaded"))
    }).pipe(withMetrics)
  )

  it.effect("should not follow a topic whose checkpoint hung again before the Schedule says", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* hangingCheckpoint(server, Layer.empty)
      yield* TestClock.adjust("20 seconds")
      yield* frames.until(atLeast(3))

      yield* TestClock.adjust("29 seconds")

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S"),
        1
      )
    })
  )

  it.effect(
    "should follow a topic whose checkpoint hung again when the Schedule says, keeping the socket",
    () =>
      Effect.gen(function* () {
        const server = fakeServer()
        const { ended, frames } = yield* hangingCheckpoint(server, Layer.empty)
        yield* TestClock.adjust("20 seconds")
        yield* frames.until(atLeast(3))
        yield* TestClock.adjust("29 seconds")

        yield* TestClock.adjust("1 second")

        yield* server.sent.until(subscribed("event-football-nfl", 2))
        const done = yield* Deferred.isDone(ended)
        assert.isFalse(done)
      })
  )

  it.effect("should emit only the H of a checkpoint that does not decode, counting it as Undecodable", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
      const server = fakeServer()
      const { frames } = yield* nflFrames(server).pipe(Effect.provide(layer))
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send(garbledCheckpoint(7)))
      yield* Effect.sync(() => server.send(patchMessage(8)))

      const received = yield* frames.until(atLeast(4))
      const failures = yield* counted("sportal_live_feed_checkpoint_failures", { league: "nfl" })
      assert.deepStrictEqual(
        received.slice(2).map(({ kind, sourceId }) => [kind, sourceId]),
        [
          ["message", 7],
          ["message", 8]
        ]
      )
      assert.strictEqual(failures, 1)
      assert.isTrue(logs.some((log) => log.level === "Warn" && log.annotations.reason === "Undecodable"))
    }).pipe(withMetrics)
  )

  it.effect("should follow a topic whose checkpoint did not decode again after 30 s", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(garbledCheckpoint(7)))
      yield* Effect.sync(() => server.send(patchMessage(8)))
      yield* frames.until(atLeast(4))

      yield* TestClock.adjust("30 seconds")

      yield* server.sent.until(subscribed("event-football-nfl", 2))
      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S"),
        2
      )
    })
  )

  it.effect("should send no second S for a resync of a topic already due to be followed again", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, demand } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(missingCheckpoint(5)))
      yield* frames.until(atLeast(3))

      yield* Queue.offer(demand, LiveFeedDemand.Resync({ channel: "event-football-nfl" }))
      yield* TestClock.adjust("1 second")

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S"),
        1
      )
    })
  )

  it.effect("should follow a topic resynced while it is due to be followed again only once more", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, demand } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(missingCheckpoint(5)))
      yield* frames.until(atLeast(3))
      yield* Queue.offer(demand, LiveFeedDemand.Resync({ channel: "event-football-nfl" }))
      yield* TestClock.adjust("1 second")

      yield* TestClock.adjust("29 seconds")
      yield* server.sent.until(subscribed("event-football-nfl", 2))
      yield* TestClock.adjust("30 seconds")

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S"),
        2
      )
    })
  )

  it.effect("should keep one subscription pending at a time for a topic whose checkpoints keep failing", () =>
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

  it.effect(
    "should leave a topic to polling once the Schedule is done, saying so once, and not subscribe it again until the socket reconnects",
    () =>
      Effect.gen(function* () {
        const { logs, layer } = recordingLogs()
        const server = fakeServer()
        const { frames, demand } = yield* nflFrames(server, Schedule.recurs(1)).pipe(Effect.provide(layer))
        yield* frames.until(atLeast(2))
        yield* Effect.sync(() => server.send(missingCheckpoint(1)))
        yield* server.sent.until(subscribed("event-football-nfl", 2))

        yield* Effect.sync(() => server.send(missingCheckpoint(2)))
        yield* frames.until((all) => all.some((frame) => frame.sourceId === 2))
        yield* Queue.offer(demand, LiveFeedDemand.Resync({ channel: "event-football-nfl" }))
        yield* TestClock.adjust("1 minute")

        const gaveUp = logs.filter((log) => log.message.includes("left to polling"))
        assert.lengthOf(
          server.sent.all().filter((frame) => frame.op === "S"),
          2
        )
        assert.lengthOf(gaveUp, 1)
        assert.strictEqual(gaveUp[0]?.level, "Warn")
      })
  )
})

/** NFL frames once both `missingTopic`'s and `otherTopic`'s games are wanted and subscribed, logging to `logged`. */
function twoGamesFollowed(server: ReturnType<typeof fakeServer>, logged: Layer.Layer<never>) {
  return Effect.gen(function* () {
    const following = yield* nflFrames(server).pipe(Effect.provide(logged))

    yield* Queue.offer(
      following.demand,
      LiveFeedDemand.Games({ games: [nflGame("401872971"), nflGame("401872972")] })
    )
    yield* server.sent.until(subscribed(otherTopic, 1))
    return following
  })
}

/** Sends an H for each game topic, `missingTopic`'s checkpoint missing, a patch on `otherTopic`, then the scoreboard's H. */
function missingCheckpointBesideOther(server: ReturnType<typeof fakeServer>) {
  return Effect.sync(() => {
    server.send({ op: "H", tc: missingTopic, mid: 5, pl: "https://checkpoint.test/missing" })
    server.send({ op: "H", tc: otherTopic, mid: 9, pl: "https://checkpoint.test/9" })
    server.send({ ...patchMessage(10), tc: otherTopic })
    server.send(checkpointMessage(7))
  })
}

/** NFL frames once the scoreboard topic has an H whose checkpoint never comes, logging to `logged`. */
function hangingCheckpoint(server: ReturnType<typeof fakeServer>, logged: Layer.Layer<never>) {
  return Effect.gen(function* () {
    const following = yield* nflFrames(server).pipe(Effect.provide(logged))

    yield* following.frames.until(atLeast(2))
    yield* Effect.sync(() =>
      server.send({ op: "H", tc: "event-football-nfl", mid: 7, pl: "https://checkpoint.test/hang" })
    )
    return following
  })
}

/** Every subscription to a game topic the client sent. */
function gameTopicsSent(server: ReturnType<typeof fakeServer>) {
  return server.sent.all().flatMap((frame) => (frame.tc?.startsWith("gp-") ? [frame] : []))
}

/**
 * Runs FastCast's push for the NFL over `server` in a fiber of its own, collecting them into `frames` and completing
 * `ended` with how it ended. `demand` takes the current games, and the topics their decoder resyncs.
 */
function nflFrames(
  server: ReturnType<typeof fakeServer>,
  checkpointRetry?: Parameters<typeof FastCast.make>[0]
) {
  return Effect.gen(function* () {
    const ended = yield* Deferred.make<void, ProviderUnavailable>()
    const frames = watched<FeedFrame>()
    const demand = yield* Queue.unbounded<LiveFeedDemand>()
    const fastCast = yield* FastCast

    yield* fastCast.push(Stream.fromQueue(demand)).pipe(
      Stream.runForEach((frame) => Effect.sync(() => frames.add(frame))),
      Deferred.into(ended),
      Effect.forkChild({ startImmediately: true })
    )
    return { ended, frames, demand }
  }).pipe(Effect.provide(fastCastOver(server, checkpointRetry)))
}

/** FastCast over `server`, following the NFL, on its own checkpoint retry unless given `checkpointRetry`. */
function fastCastOver(
  server: ReturnType<typeof fakeServer>,
  checkpointRetry?: Parameters<typeof FastCast.make>[0]
) {
  const fastCast =
    checkpointRetry === undefined ? FastCast.layer : Layer.effect(FastCast, FastCast.make(checkpointRetry))
  const nflOnly = HubConfig.layerTest({ SPORTAL_LEAGUES: "nfl" }).pipe(Layer.orDie)
  return fastCast.pipe(Layer.provide([fastCastHost(server), nflOnly]))
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

function fastCastHost(server: ReturnType<typeof fakeServer>) {
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

function garbledCheckpoint(mid: number) {
  return { op: "H", tc: "event-football-nfl", mid, pl: "https://checkpoint.test/garbled" }
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

// FastCast's host lookup, and any checkpoint, which is the recorded one, except a missing one, one that is not a
// scoreboard, and one that never comes.
const espn = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      request.url.includes("websockethost")
        ? new Response(JSON.stringify({ ip: "fastcast.test", securePort: 443, token: "token" }))
        : request.url.endsWith("/missing")
          ? new Response("Not Found", { status: 404 })
          : request.url.endsWith("/garbled")
            ? new Response(JSON.stringify({ sports: "not a scoreboard" }))
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
