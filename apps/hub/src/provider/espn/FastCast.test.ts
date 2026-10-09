import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Deferred, Effect, HashMap, Layer, Option, Schema, Stream, SubscriptionRef } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"
import { recordingLogs } from "../../TestTelemetry.ts"
import { FastCast, type Wanted } from "./FastCast.ts"
import * as FastCastMessage from "./FastCastMessage.ts"
import { Frame } from "./Frame.ts"
import { decodeSent, fakeServer, subscribed, watched } from "./TestFastCast.ts"
import { Topic, tcOf } from "./Topic.ts"

// Games of the recorded checkpoint: the first two live, the third scheduled for 20:05Z.
const firstGame = "401872971"
const secondGame = "401872972"
const laterGame = "401872974"

// The two live games' topics: the first's checkpoint is missing in the tests that follow both.
const missingTopic = gameTopic(firstGame)
const otherTopic = gameTopic(secondGame)

describe("FastCast", () => {
  it.effect("should connect, then subscribe to its league's scoreboard topic", () =>
    Effect.gen(function* () {
      const server = fakeServer()

      const { frames } = yield* nflFrames(server)

      yield* frames.until(atLeast(2))
      yield* server.sent.until(subscribed("event-football-nfl", 1))
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
      assert.lengthOf(connectsSent(server), 1, "the socket is never opened again")
    })
  )

  it.effect("should reconnect after the socket closes", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { ended, frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.close(1000))
      yield* TestClock.adjust("2 seconds")

      yield* server.sent.until(subscribed("event-football-nfl", 2))
      const done = yield* Deferred.isDone(ended)
      assert.lengthOf(connectsSent(server), 2)
      assert.isFalse(done)
    })
  )

  it.effect("should warn of a failed live feed with its reason", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
      const server = fakeServer()
      const { frames } = yield* nflFrames(server).pipe(Effect.provide(layer))
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.close(1000))
      yield* TestClock.adjust("2 seconds")

      yield* server.sent.until(subscribed("event-football-nfl", 2))
      assert.isTrue(
        logs.some(
          (log) =>
            log.level === "Warn" &&
            log.message.includes("FastCast: the live feed failed (Closed); subscribing again")
        )
      )
    })
  )

  it.effect("should keep running when the socket goes silent", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { ended, frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* TestClock.adjust("20 seconds")
      yield* Effect.sync(() => server.send({ op: "B" }))
      yield* frames.until(atLeast(3))
      yield* TestClock.adjust("40 seconds")

      yield* TestClock.adjust("5 seconds")
      yield* TestClock.adjust("2 seconds")

      yield* server.sent.until(subscribed("event-football-nfl", 2))
      const done = yield* Deferred.isDone(ended)
      assert.isFalse(done)
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
      const firstFour = received.slice(0, 4)
      assert.deepStrictEqual(firstFour.map(seen), [
        { tag: "Pushed", tc: undefined, mid: undefined, body: "C" },
        { tag: "Pushed", tc: "event-football-nfl", mid: undefined, body: "S" },
        { tag: "Pushed", tc: "event-football-nfl", mid: 7, body: "H" },
        { tag: "Checkpoint", tc: "event-football-nfl", mid: 7, document: checkpointDocument }
      ])
      assert.isFalse(firstFour.some(Frame.$is("Polled")))
    })
  )

  it.effect("should give a patch's frame its mid", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send(patchMessage(8)))

      const received = yield* frames.until(atLeast(3))
      const patch = received.at(-1)
      assert.strictEqual(patch === undefined ? undefined : seen(patch).mid, 8)
    })
  )

  it.effect("should follow a topic once it is wanted", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, want } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* want([scoreboard, "AwaitingCheckpoint"], [gameOf(laterGame), "AwaitingCheckpoint"])

      yield* server.sent.until(subscribed(gameTopic(laterGame), 1))
      assert.deepStrictEqual(gameTopicsSent(server), [{ op: "S", sid: "sid-1", tc: gameTopic(laterGame) }])
    })
  )

  it.effect("should load a second topic's checkpoint while the first still loads", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send({ ...checkpointMessage(7), pl: "https://checkpoint.test/slow" }))
      yield* Effect.sync(() =>
        server.send({ op: "H", tc: gameTopic(firstGame), mid: 3, pl: "https://checkpoint.test/slow" })
      )
      yield* TestClock.adjust("5 seconds")

      const received = yield* frames.until(atLeast(6))
      assert.deepStrictEqual(
        received.slice(2, 6).map((frame) => frame._tag),
        ["Pushed", "Checkpoint", "Pushed", "Checkpoint"]
      )
    })
  )

  it.effect("should not follow a topic again while it stays wanted", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, want } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* want([scoreboard, "AwaitingCheckpoint"], [gameOf(firstGame), "AwaitingCheckpoint"])
      yield* server.sent.until(subscribed(gameTopic(firstGame), 1))

      yield* want([scoreboard, "AwaitingCheckpoint"], [gameOf(firstGame), "AwaitingCheckpoint"])
      yield* want(
        [scoreboard, "AwaitingCheckpoint"],
        [gameOf(firstGame), "AwaitingCheckpoint"],
        [gameOf(secondGame), "AwaitingCheckpoint"]
      )

      // Wanted sets are taken in order, so once the third has subscribed, the second has sent all it would.
      yield* server.sent.until(subscribed(gameTopic(secondGame), 1))
      assert.deepStrictEqual(
        gameTopicsSent(server).map((frame) => frame.tc),
        [gameTopic(firstGame), gameTopic(secondGame)],
        "the same topic wanted again sends none"
      )
    })
  )

  it.effect("should send nothing for a topic no longer wanted", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, want } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* want([scoreboard, "AwaitingCheckpoint"], [gameOf(firstGame), "AwaitingCheckpoint"])
      yield* server.sent.until(subscribed(gameTopic(firstGame), 1))

      yield* want([scoreboard, "AwaitingCheckpoint"])
      yield* TestClock.adjust("1 second")

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S" && frame.tc === gameTopic(firstGame)),
        1
      )
    })
  )

  it.effect(
    "should keep the socket and the other topics when a checkpoint does not load, warning of it",
    () =>
      Effect.gen(function* () {
        const { logs, layer } = recordingLogs()
        const server = fakeServer()
        const { ended, frames } = yield* twoGamesFollowed(server, layer)

        yield* missingCheckpointBesideOther(server)

        const received = yield* frames.until(wholeAt(7))
        const done = yield* Deferred.isDone(ended)
        assert.deepStrictEqual(
          received.map(seen).flatMap(({ tag, tc, mid }) => (tc?.startsWith("gp-") ? [[tc, tag, mid]] : [])),
          [
            [missingTopic, "Pushed", undefined],
            [otherTopic, "Pushed", undefined],
            [missingTopic, "Pushed", 5],
            [otherTopic, "Pushed", 9],
            [otherTopic, "Checkpoint", 9],
            [otherTopic, "Pushed", 10]
          ]
        )
        assert.isFalse(done)
        assert.isTrue(logs.some((log) => log.level === "Warn" && log.annotations.topic === missingTopic))
        assert.lengthOf(
          server.sent.all().filter((frame) => frame.op === "S" && frame.tc === missingTopic),
          1
        )
      })
  )

  it.effect(
    "should subscribe a topic whose checkpoint did not load again after 30 s, keeping the socket",
    () =>
      Effect.gen(function* () {
        const server = fakeServer()
        const { ended, frames } = yield* twoGamesFollowed(server, Layer.empty)
        yield* missingCheckpointBesideOther(server)
        yield* frames.until(wholeAt(7))

        yield* TestClock.adjust("30 seconds")

        yield* server.sent.until(subscribed(missingTopic, 2))
        const done = yield* Deferred.isDone(ended)
        assert.isFalse(done)
      })
  )

  it.effect("should not subscribe again to a topic left while its re-subscribe waited", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, want } = yield* twoGamesFollowed(server, Layer.empty)
      yield* missingCheckpointBesideOther(server)
      yield* frames.until(wholeAt(7))

      yield* want([scoreboard, "Synced"], [gameOf(secondGame), "Synced"])
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("29 seconds")

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S" && frame.tc === missingTopic),
        1
      )
    })
  )

  it.effect(
    "should follow a topic again once its document goes back to waiting for its checkpoint, and only once while it waits",
    () =>
      Effect.gen(function* () {
        const server = fakeServer()
        const { frames, want } = yield* nflFrames(server)
        yield* frames.until(atLeast(2))
        yield* Effect.sync(() => server.send(scoreboardShowing(7)))
        yield* frames.until(wholeAt(7))
        yield* want([scoreboard, "Synced"])

        yield* want([scoreboard, "AwaitingCheckpoint"])
        yield* server.sent.until(subscribed("event-football-nfl", 2))
        yield* want([scoreboard, "AwaitingCheckpoint"])
        yield* Effect.sync(() => server.send(scoreboardShowing(20)))
        yield* frames.until(wholeAt(20))

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

  it.effect("should fail a checkpoint that hangs for 20 s as Unloaded, warning of it", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
      const server = fakeServer()
      const { frames } = yield* hangingCheckpoint(server, layer)
      yield* TestClock.adjust("19 seconds")

      yield* TestClock.adjust("1 second")

      yield* frames.until(atLeast(3))
      assert.isTrue(logs.some((log) => log.level === "Warn" && log.annotations.reason === "Unloaded"))
    })
  )

  it.effect("should not subscribe again to a topic whose checkpoint hung before 30 s", () =>
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

  it.effect("should subscribe again to a topic whose checkpoint hung after 30 s, keeping the socket", () =>
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

  it.effect("should emit only the H of a checkpoint that does not decode, warning of it as Undecodable", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
      const server = fakeServer()
      const { frames } = yield* nflFrames(server).pipe(Effect.provide(layer))
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send(garbledCheckpoint(7)))
      yield* Effect.sync(() => server.send(patchMessage(8)))

      const received = yield* frames.until(atLeast(4))
      assert.deepStrictEqual(
        received
          .slice(2)
          .map(seen)
          .map(({ tag, mid }) => [tag, mid]),
        [
          ["Pushed", 7],
          ["Pushed", 8]
        ]
      )
      assert.isTrue(logs.some((log) => log.level === "Warn" && log.annotations.reason === "Undecodable"))
    })
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

  it.effect("should subscribe again every 30 s to a topic whose checkpoints keep failing", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      for (const mid of [1, 2, 3, 4, 5, 6]) {
        yield* Effect.sync(() => server.send(missingCheckpoint(mid)))
        yield* frames.until(numbered(mid))
        yield* TestClock.adjust("30 seconds")
        yield* server.sent.until(subscribed("event-football-nfl", mid + 1))
      }

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S"),
        7
      )
    })
  )

  it.effect(
    "should subscribe at once to a topic whose document is lost while its re-subscribe waits, and not again when the wait ends",
    () =>
      Effect.gen(function* () {
        const server = fakeServer()
        const { want } = yield* dueToBeFollowedAgain(server)

        yield* want([scoreboard, "AwaitingCheckpoint"])
        yield* server.sent.until(subscribed("event-football-nfl", 3))
        yield* TestClock.adjust("30 seconds")

        assert.lengthOf(
          server.sent.all().filter((frame) => frame.op === "S"),
          3,
          "the first gap's S, the second gap's at once, and none when the wait ends"
        )
      })
  )

  it.effect("should follow every wanted topic again on a new socket", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, want } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* want([scoreboard, "Synced"], [gameOf(firstGame), "Synced"])
      yield* server.sent.until(subscribed(gameTopic(firstGame), 1))

      yield* Effect.sync(() => server.close(1000))
      yield* TestClock.adjust("2 seconds")

      yield* server.sent.until(subscribed(gameTopic(firstGame), 2))
      yield* server.sent.until(subscribed("event-football-nfl", 2))
      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S" && frame.tc === "event-football-nfl"),
        2
      )
    })
  )
})

// Jitter scales each reconnect delay by 0.8 to 1.2. Every socket is closed as it opens, so nothing is delivered to reset
// the backoff: the second opens 0.8 s to 1.2 s after the first, the third 1.6 s to 2.4 s after that.
describe("FastCast reconnect", () => {
  it.effect("should open the socket at once", () =>
    Effect.gen(function* () {
      const sockets = closedSockets()
      yield* framesOver(sockets.host)

      yield* TestClock.adjust(0)

      assert.lengthOf(sockets.opened.all(), 1)
    })
  )

  it.effect("should not open a closed socket again within 0.7 s", () =>
    Effect.gen(function* () {
      const sockets = closedSockets()
      yield* framesOver(sockets.host)
      yield* TestClock.adjust(0)

      yield* TestClock.adjust("700 millis")

      assert.lengthOf(sockets.opened.all(), 1)
    })
  )

  it.effect("should open a closed socket again within 1.3 s", () =>
    Effect.gen(function* () {
      const sockets = closedSockets()
      yield* framesOver(sockets.host)
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("700 millis")

      yield* TestClock.adjust("600 millis")

      assert.lengthOf(sockets.opened.all(), 2)
    })
  )

  it.effect("should not open a socket closed a second time again within 2.3 s of the first", () =>
    Effect.gen(function* () {
      const sockets = closedSockets()
      yield* framesOver(sockets.host)
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("1300 millis")

      yield* TestClock.adjust("1 second")

      assert.lengthOf(sockets.opened.all(), 2)
    })
  )

  it.effect("should open a socket closed a second time again within 3.7 s of the first", () =>
    Effect.gen(function* () {
      const sockets = closedSockets()
      yield* framesOver(sockets.host)
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("1300 millis")
      yield* TestClock.adjust("1 second")

      yield* TestClock.adjust("1400 millis")

      assert.lengthOf(sockets.opened.all(), 3)
    })
  )
})

/** NFL frames once `missingTopic`'s and `otherTopic`'s games are wanted and both are subscribed. */
function twoGamesFollowed(server: ReturnType<typeof fakeServer>, logged: Layer.Layer<never>) {
  return Effect.gen(function* () {
    const following = yield* nflFrames(server).pipe(Effect.provide(logged))

    yield* following.frames.until(atLeast(2))
    yield* following.want(
      [scoreboard, "AwaitingCheckpoint"],
      [gameOf(firstGame), "AwaitingCheckpoint"],
      [gameOf(secondGame), "AwaitingCheckpoint"]
    )
    yield* server.sent.until(subscribed(otherTopic, 1))
    return following
  })
}

/**
 * Sends an H for each game topic, `missingTopic`'s checkpoint missing, a patch on `otherTopic`, then the scoreboard's
 * H at 7, showing the same two games.
 */
function missingCheckpointBesideOther(server: ReturnType<typeof fakeServer>) {
  return Effect.sync(() => {
    server.send({ op: "H", tc: missingTopic, mid: 5, pl: "https://checkpoint.test/missing" })
    server.send({ op: "H", tc: otherTopic, mid: 9, pl: "https://checkpoint.test/9" })
    server.send({ ...patchMessage(10), tc: otherTopic })
    server.send(scoreboardShowing(7, firstGame, secondGame))
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

/**
 * NFL frames once the scoreboard topic is due to be followed again: synced at 7, its document lost so it is
 * subscribed to again, that subscription's checkpoint at 10 missing, then a checkpoint at 11 FastCast sent unasked,
 * which synced it.
 */
function dueToBeFollowedAgain(server: ReturnType<typeof fakeServer>) {
  return Effect.gen(function* () {
    const following = yield* nflFrames(server)

    yield* following.frames.until(atLeast(2))
    yield* Effect.sync(() => server.send(scoreboardShowing(7)))
    yield* following.frames.until(wholeAt(7))
    yield* following.want([scoreboard, "Synced"])
    yield* following.want([scoreboard, "AwaitingCheckpoint"])
    yield* server.sent.until(subscribed("event-football-nfl", 2))
    yield* Effect.sync(() => server.send(missingCheckpoint(10)))
    yield* following.frames.until(numbered(10))
    yield* Effect.sync(() => server.send(scoreboardShowing(11)))
    yield* following.frames.until(wholeAt(11))
    yield* following.want([scoreboard, "Synced"])
    return following
  })
}

/** Every subscription to a game topic the client sent. */
function gameTopicsSent(server: ReturnType<typeof fakeServer>) {
  return server.sent.all().flatMap((frame) => (frame.tc?.startsWith("gp-") ? [frame] : []))
}

/** Every handshake the client sent: one per socket it opened. */
function connectsSent(server: ReturnType<typeof fakeServer>) {
  return server.sent.all().filter((frame) => frame.op === "C")
}

/** The NFL's scoreboard topic, and a game's. */
const scoreboard = Topic.Scoreboard({ league: "nfl" })
const gameOf = (game: string) => Topic.Game({ league: "nfl", game: GameId.make(game) })

/** A wanted set of `entries`. */
function wantedOf(...entries: ReadonlyArray<readonly [Topic, HashMap.HashMap.Value<Wanted>]>): Wanted {
  return HashMap.fromIterable(entries)
}

/**
 * Runs FastCast's frames over `server` in a fiber of its own, told to follow the NFL's scoreboard until `want` says
 * otherwise, collecting them into `frames` and completing `ended` if they ever end.
 */
function nflFrames(server: ReturnType<typeof fakeServer>) {
  return framesOver(fastCastHost(server))
}

/**
 * Runs FastCast's frames over `host` in a fiber of its own, told to follow the NFL's scoreboard until `want` says
 * otherwise, collecting them into `frames` and completing `ended` if they ever end.
 */
function framesOver(host: Layer.Layer<HttpClient.HttpClient | Socket.WebSocketConstructor>) {
  return Effect.gen(function* () {
    const ended = yield* Deferred.make<void>()
    const frames = watched<Frame>()
    const wanted = yield* SubscriptionRef.make(wantedOf([scoreboard, "AwaitingCheckpoint"]))
    const running = yield* FastCast

    yield* running.follow(SubscriptionRef.changes(wanted)).pipe(
      Stream.runForEach((frame) => Effect.sync(() => frames.add(frame))),
      Deferred.into(ended),
      Effect.forkChild({ startImmediately: true })
    )
    const want = (...entries: ReadonlyArray<readonly [Topic, HashMap.HashMap.Value<Wanted>]>) =>
      SubscriptionRef.set(wanted, wantedOf(...entries))
    return { ended, frames, want }
  }).pipe(Effect.provide(FastCast.layer.pipe(Layer.provide(host))))
}

/** A frame as a test compares it: its kind, its topic's name, its mid, and its body (a socket text read as its op) or its document. */
function seen(frame: Frame) {
  return Frame.$match(frame, {
    Polled: ({ league, body }) => ({ tag: "Polled", tc: league, mid: undefined, body }),
    PollFailed: ({ league }) => ({ tag: "PollFailed", tc: league, mid: undefined, body: undefined }),
    Pushed: ({ topic, mid, body }) => ({
      tag: "Pushed",
      tc: Option.getOrUndefined(Option.map(topic, tcOf)),
      mid: Option.getOrUndefined(mid),
      body: decodeSent(body).op
    }),
    Checkpoint: ({ topic, mid, document }) => ({ tag: "Checkpoint", tc: tcOf(topic), mid, document })
  })
}

function atLeast(count: number) {
  return (all: ReadonlyArray<unknown>) => all.length >= count
}

/** Whether a frame of mid `mid` has arrived. */
function numbered(mid: number) {
  return (all: ReadonlyArray<Frame>) => all.some((frame) => seen(frame).mid === mid)
}

/** Whether a checkpoint at mid `mid` has been framed. */
function wholeAt(mid: number) {
  return (all: ReadonlyArray<Frame>) =>
    all.some((frame) => Frame.$is("Checkpoint")(frame) && frame.mid === mid)
}

function fastCastHost(server: ReturnType<typeof fakeServer>) {
  return Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, espn),
    Layer.succeed(Socket.WebSocketConstructor, () => server.socket)
  )
}

/** ESPN's host, whose every socket is already closed when it opens, and each address a socket was opened at. */
function closedSockets() {
  const opened = watched<string>()
  const closed: Socket.WebSocketLike = {
    readyState: 3,
    addEventListener: () => {},
    removeEventListener: () => {},
    close: () => {},
    send: () => {}
  }
  const host = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, espn),
    Layer.succeed(Socket.WebSocketConstructor, (url) => {
      opened.add(url)
      return closed
    })
  )
  return { opened, host }
}

function gameTopic(game: string) {
  return `gp-football-nfl-${game}`
}

/** The recorded scoreboard's checkpoint, at `mid`. */
function checkpointMessage(mid: number) {
  return { op: "H", tc: "event-football-nfl", mid, pl: `https://checkpoint.test/${mid}` }
}

/** A scoreboard checkpoint at `mid` showing only `games`, as the recorded checkpoint has them. */
function scoreboardShowing(mid: number, ...games: ReadonlyArray<string>) {
  return {
    op: "H",
    tc: "event-football-nfl",
    mid,
    pl: `https://checkpoint.test/scoreboard?games=${games.join(",")}`
  }
}

function garbledCheckpoint(mid: number) {
  return { op: "H", tc: "event-football-nfl", mid, pl: "https://checkpoint.test/garbled" }
}

function missingCheckpoint(mid: number) {
  return { op: "H", tc: "event-football-nfl", mid, pl: "https://checkpoint.test/missing" }
}

/** A scoreboard `P` at `mid` that patches nothing. */
function patchMessage(mid: number) {
  return { op: "P", tc: "event-football-nfl", mid, pl: JSON.stringify({ ts: 1791136341731, pl: [] }) }
}

const checkpointBody = readFileSync(
  new URL("./fixtures/nfl-fastcast-checkpoint-2026-10-04T1752Z.json", import.meta.url),
  "utf8"
)

const checkpointDocument = Schema.decodeSync(FastCastMessage.Checkpoint(Topic.Scoreboard({ league: "nfl" })))(
  checkpointBody
)

const RecordedScoreboard = Schema.fromJsonString(
  Schema.Struct({
    sports: Schema.Array(
      Schema.Struct({
        leagues: Schema.Array(
          Schema.Struct({
            events: Schema.Array(
              Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
                Schema.Record(Schema.String, Schema.Json)
              ])
            )
          })
        )
      })
    )
  })
)

const recordedEvents = Schema.decodeSync(RecordedScoreboard)(checkpointBody).sports.flatMap((sport) =>
  sport.leagues.flatMap((league) => league.events)
)

/** The recorded scoreboard checkpoint with only the events of `games`, by id. */
function scoreboardBody(games: ReadonlyArray<string>) {
  const events = recordedEvents.filter((event) => games.includes(event.id))
  return JSON.stringify({ sports: [{ leagues: [{ events }] }] })
}

// FastCast's host lookup, and any checkpoint, which is the recorded one, except a scoreboard showing only some of its
// games, a missing one, one that is not a scoreboard, and one that never comes.
const espn = HttpClient.make((request) => {
  const url = new URL(request.url)
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      url.pathname.endsWith("websockethost")
        ? new Response(JSON.stringify({ ip: "fastcast.test", securePort: 443, token: "token" }))
        : url.pathname === "/scoreboard"
          ? new Response(scoreboardBody((url.searchParams.get("games") ?? "").split(",")))
          : url.pathname === "/missing"
            ? new Response("Not Found", { status: 404 })
            : url.pathname === "/garbled"
              ? new Response(JSON.stringify({ sports: "not a scoreboard" }))
              : new Response(checkpointBody)
    )
  ).pipe(
    Effect.andThen((response) =>
      url.pathname === "/hang"
        ? Effect.never
        : url.pathname === "/slow"
          ? Effect.sleep("5 seconds").pipe(Effect.as(response))
          : Effect.succeed(response)
    )
  )
})
