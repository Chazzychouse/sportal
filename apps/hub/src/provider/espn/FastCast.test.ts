import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Deferred, Effect, Layer, Schedule, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"
import { HubConfig } from "../../HubConfig.ts"
import { counted, recordingLogs, withMetrics } from "../../TestTelemetry.ts"
import { FastCast } from "./FastCast.ts"
import type { Frame } from "./Frame.ts"

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
      const { ended } = yield* nflFrames(server)
      yield* server.sent.until(subscribed("event-football-nfl", 1))

      yield* Effect.sync(() => server.close(1000))
      yield* TestClock.adjust("2 seconds")

      yield* server.sent.until(subscribed("event-football-nfl", 2))
      const done = yield* Deferred.isDone(ended)
      assert.lengthOf(connectsSent(server), 2)
      assert.isFalse(done)
    })
  )

  it.effect("should count a failed live feed by its reason", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
      const server = fakeServer()
      yield* nflFrames(server).pipe(Effect.provide(layer))
      yield* server.sent.until(subscribed("event-football-nfl", 1))

      yield* Effect.sync(() => server.close(1000))
      yield* TestClock.adjust("2 seconds")

      yield* server.sent.until(subscribed("event-football-nfl", 2))
      const failures = yield* counted("sportal_live_feed_errors", { reason: "Closed" })
      assert.strictEqual(failures, 1)
      assert.isTrue(
        logs.some(
          (log) =>
            log.level === "Warn" &&
            log.message.includes("FastCast: the live feed failed (Closed); subscribing again")
        )
      )
    }).pipe(withMetrics)
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
      const silences = yield* counted("sportal_live_feed_errors", { reason: "Silent" })
      assert.isFalse(done)
      assert.strictEqual(silences, 1)
      assert.isFalse(
        server.sent.all().some((frame) => frame.op === "B"),
        "the client never heartbeats"
      )
    }).pipe(withMetrics)
  )

  it.effect("should log that the live feed stopped and stay quiet once its reconnect is done", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
      const server = fakeServer()
      const { ended } = yield* nflFrames(server, {
        checkpoint: Schedule.spaced("30 seconds"),
        reconnect: Schedule.recurs(0)
      }).pipe(Effect.provide(layer))
      yield* server.sent.until(subscribed("event-football-nfl", 1))

      yield* Effect.sync(() => server.close(1000))
      yield* TestClock.adjust("1 minute")

      const done = yield* Deferred.isDone(ended)
      const stopped = logs.filter((log) => log.message.includes("FastCast: the live feed stopped"))
      assert.isFalse(done)
      assert.lengthOf(connectsSent(server), 1)
      assert.lengthOf(stopped, 1)
      assert.strictEqual(stopped[0]?.level, "Error")
    })
  )

  it.effect("should emit each socket text as a message frame, and an H's checkpoint after it", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send(checkpointMessage(7)))

      const received = yield* frames.until(atLeast(4))
      // The first four: the checkpoint's live games are subscribed to after it.
      const firstFour = received.slice(0, 4)
      assert.deepStrictEqual(
        firstFour.map(({ channel, kind, number, body }) => ({
          channel,
          kind,
          number,
          body: kind === "whole" ? body : decodeSent(body).op
        })),
        [
          { channel: "socket", kind: "change", number: undefined, body: "C" },
          { channel: "event-football-nfl", kind: "change", number: undefined, body: "S" },
          { channel: "event-football-nfl", kind: "change", number: 7, body: "H" },
          { channel: "event-football-nfl", kind: "whole", number: 7, body: checkpointBody }
        ]
      )
      assert.isTrue(firstFour.every((frame) => frame.source === "push"))
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
      assert.strictEqual(patch?.number, 8)
    })
  )

  it.effect("should follow a game's topic once its scoreboard shows it live", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(scoreboardShowing(1, laterGame)))
      yield* frames.until(wholeAt(1))

      yield* Effect.sync(() => server.send(patchMessage(2, [stateOf(laterGame, "in")])))

      yield* server.sent.until(subscribed(gameTopic(laterGame), 1))
      assert.deepStrictEqual(gameTopicsSent(server), [{ op: "S", sid: "sid-1", tc: gameTopic(laterGame) }])
    })
  )

  it.effect("should follow a game's topic from 30 minutes before kickoff", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-04T19:34:59Z")))
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(scoreboardShowing(1, laterGame)))
      yield* frames.until(wholeAt(1))
      const before = gameTopicsSent(server)

      yield* TestClock.adjust("1 second")
      yield* Effect.sync(() => server.send({ op: "B" }))

      yield* server.sent.until(subscribed(gameTopic(laterGame), 1))
      assert.deepStrictEqual(before, [], "a second earlier, the game is not followed")
      assert.deepStrictEqual(gameTopicsSent(server), [{ op: "S", sid: "sid-1", tc: gameTopic(laterGame) }])
    })
  )

  it.effect("should not follow a game's topic again while its scoreboard still shows it live", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(scoreboardShowing(1, firstGame)))
      yield* server.sent.until(subscribed(gameTopic(firstGame), 1))

      yield* Effect.sync(() => server.send(patchMessage(2, [clockOf(firstGame, "4:20")])))
      yield* frames.until(numbered(2))
      yield* Effect.sync(() => server.send(scoreboardShowing(3, firstGame, secondGame)))

      // Scoreboard frames are taken in order, so once the third has subscribed, the second has sent all it would.
      yield* server.sent.until(subscribed(gameTopic(secondGame), 1))
      assert.deepStrictEqual(
        gameTopicsSent(server).map((frame) => frame.tc),
        [gameTopic(firstGame), gameTopic(secondGame)],
        "the same game shown live again sends none"
      )
    })
  )

  it.effect("should leave a game's topic when its scoreboard shows it final", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
      const server = fakeServer()
      const { frames } = yield* nflFrames(server).pipe(Effect.provide(layer))
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(scoreboardShowing(1, firstGame)))
      yield* server.sent.until(subscribed(gameTopic(firstGame), 1))
      yield* Effect.sync(() => server.send(gameCheckpoint(firstGame, 3)))
      yield* frames.until(wholeAt(3))

      yield* Effect.sync(() => server.send(patchMessage(2, [stateOf(firstGame, "post")])))
      yield* frames.until(numbered(2))
      yield* Effect.sync(() => server.send({ ...patchMessage(5), tc: gameTopic(firstGame) }))
      yield* frames.until(numbered(5))
      yield* TestClock.adjust("1 second")

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S" && frame.tc === gameTopic(firstGame)),
        1,
        "a gap on a topic it left reads no checkpoint again"
      )
      assert.isTrue(
        logs.some((log) => log.level === "Info" && log.message.includes(`left ${gameTopic(firstGame)}`))
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

        const received = yield* frames.until(wholeAt(7))
        const done = yield* Deferred.isDone(ended)
        const failures = yield* counted("sportal_live_feed_checkpoint_failures", { league: "nfl" })
        assert.deepStrictEqual(
          received.flatMap(({ channel, kind, number }) =>
            channel.startsWith("gp-") ? [[channel, kind, number]] : []
          ),
          [
            [missingTopic, "change", undefined],
            [otherTopic, "change", undefined],
            [missingTopic, "change", 5],
            [otherTopic, "change", 9],
            [otherTopic, "whole", 9],
            [otherTopic, "change", 10]
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
        yield* frames.until(wholeAt(7))

        yield* TestClock.adjust("30 seconds")

        yield* server.sent.until(subscribed(missingTopic, 2))
        const done = yield* Deferred.isDone(ended)
        assert.isFalse(done)
      })
  )

  it.effect("should read a topic's checkpoint again after a gap", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(scoreboardShowing(7)))
      yield* frames.until(wholeAt(7))

      yield* Effect.sync(() => server.send(patchMessage(9)))
      yield* server.sent.until(subscribed("event-football-nfl", 2))
      // Waiting for its checkpoint already: a message after the gap asks for nothing more.
      yield* Effect.sync(() => server.send(patchMessage(11)))
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

  it.effect("should read a topic's checkpoint again after a message that will not apply", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(scoreboardShowing(7)))
      yield* frames.until(wholeAt(7))

      yield* Effect.sync(() =>
        server.send(patchMessage(8, [{ op: "remove", path: `${eventUid(firstGame)}/fullStatus` }]))
      )

      yield* server.sent.until(subscribed("event-football-nfl", 2))
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
        received.slice(2).map(({ kind, number }) => [kind, number]),
        [
          ["change", 7],
          ["change", 8]
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

  it.effect("should send no second S for a gap on a topic already due to be followed again", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* dueToBeFollowedAgain(server)

      yield* Effect.sync(() => server.send(patchMessage(13)))
      yield* frames.until(numbered(13))
      yield* TestClock.adjust("1 second")

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S"),
        2,
        "the first gap's S, and none for the second"
      )
    })
  )

  it.effect("should follow a topic that had a gap while due to be followed again only once more", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* dueToBeFollowedAgain(server)
      yield* Effect.sync(() => server.send(patchMessage(13)))
      yield* frames.until(numbered(13))
      yield* TestClock.adjust("1 second")

      yield* TestClock.adjust("29 seconds")
      yield* server.sent.until(subscribed("event-football-nfl", 3))
      yield* TestClock.adjust("30 seconds")

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S"),
        3,
        "the first gap's S, then one when the Schedule says"
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
        const { frames } = yield* nflFrames(server, {
          checkpoint: Schedule.recurs(1),
          reconnect: Schedule.spaced("1 second")
        }).pipe(Effect.provide(layer))
        yield* frames.until(atLeast(2))
        yield* Effect.sync(() => server.send(missingCheckpoint(1)))
        yield* server.sent.until(subscribed("event-football-nfl", 2))

        yield* Effect.sync(() => server.send(missingCheckpoint(2)))
        yield* frames.until(numbered(2))
        // A checkpoint FastCast sends unasked, then a gap after it.
        yield* Effect.sync(() => server.send(scoreboardShowing(3)))
        yield* frames.until(wholeAt(3))
        yield* Effect.sync(() => server.send(patchMessage(5)))
        yield* frames.until(numbered(5))
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

/** NFL frames once the scoreboard shows `missingTopic`'s and `otherTopic`'s games live and both are subscribed. */
function twoGamesFollowed(server: ReturnType<typeof fakeServer>, logged: Layer.Layer<never>) {
  return Effect.gen(function* () {
    const following = yield* nflFrames(server).pipe(Effect.provide(logged))

    yield* following.frames.until(atLeast(2))
    yield* Effect.sync(() => server.send(scoreboardShowing(1, firstGame, secondGame)))
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
 * NFL frames once the scoreboard topic is due to be followed again: synced at 7, subscribed to again on a gap at 9,
 * that subscription's checkpoint at 10 missing, then a checkpoint at 11 that FastCast sent unasked.
 */
function dueToBeFollowedAgain(server: ReturnType<typeof fakeServer>) {
  return Effect.gen(function* () {
    const following = yield* nflFrames(server)

    yield* following.frames.until(atLeast(2))
    yield* Effect.sync(() => server.send(scoreboardShowing(7)))
    yield* following.frames.until(wholeAt(7))
    yield* Effect.sync(() => server.send(patchMessage(9)))
    yield* server.sent.until(subscribed("event-football-nfl", 2))
    yield* Effect.sync(() => server.send(missingCheckpoint(10)))
    yield* following.frames.until(numbered(10))
    yield* Effect.sync(() => server.send(scoreboardShowing(11)))
    yield* following.frames.until(wholeAt(11))
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

/**
 * Runs FastCast's frames for the NFL over `server` in a fiber of its own, collecting them into `frames` and completing
 * `ended` if they ever end.
 */
function nflFrames(server: ReturnType<typeof fakeServer>, retry?: Parameters<typeof FastCast.make>[0]) {
  return framesOver(fastCastHost(server), retry)
}

/**
 * Runs FastCast's frames for the NFL over `host` in a fiber of its own, on its own retries unless given `retry`,
 * collecting them into `frames` and completing `ended` if they ever end.
 */
function framesOver(
  host: Layer.Layer<HttpClient.HttpClient | Socket.WebSocketConstructor>,
  retry?: Parameters<typeof FastCast.make>[0]
) {
  const fastCast = retry === undefined ? FastCast.layer : Layer.effect(FastCast, FastCast.make(retry))
  const nflOnly = HubConfig.layerTest({ SPORTAL_LEAGUES: "nfl" }).pipe(Layer.orDie)
  return Effect.gen(function* () {
    const ended = yield* Deferred.make<void>()
    const frames = watched<Frame>()
    const running = yield* FastCast

    yield* running.frames.pipe(
      Stream.runForEach((frame) => Effect.sync(() => frames.add(frame))),
      Deferred.into(ended),
      Effect.forkChild({ startImmediately: true })
    )
    return { ended, frames }
  }).pipe(Effect.provide(fastCast.pipe(Layer.provide([host, nflOnly]))))
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

/** Whether a frame of mid `mid` has arrived. */
function numbered(mid: number) {
  return (all: ReadonlyArray<Frame>) => all.some((frame) => frame.number === mid)
}

/** Whether a checkpoint at mid `mid` has been framed. */
function wholeAt(mid: number) {
  return (all: ReadonlyArray<Frame>) => all.some((frame) => frame.kind === "whole" && frame.number === mid)
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

/** The uid a scoreboard patch's path starts with for `game`. */
function eventUid(game: string) {
  return `s:20~l:28~e:${game}~c:${game}`
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

/** A checkpoint of `game`'s topic, at `mid`. */
function gameCheckpoint(game: string, mid: number) {
  return { op: "H", tc: gameTopic(game), mid, pl: `https://checkpoint.test/${mid}` }
}

function garbledCheckpoint(mid: number) {
  return { op: "H", tc: "event-football-nfl", mid, pl: "https://checkpoint.test/garbled" }
}

function missingCheckpoint(mid: number) {
  return { op: "H", tc: "event-football-nfl", mid, pl: "https://checkpoint.test/missing" }
}

/** A scoreboard `P` at `mid` of `patches`, none unless given. */
function patchMessage(mid: number, patches: ReadonlyArray<object> = []) {
  return {
    op: "P",
    tc: "event-football-nfl",
    mid,
    pl: JSON.stringify({ ts: 1791136341731, pl: patches })
  }
}

/** A patch of the state of `game`'s status: `in` is live, `post` is over. */
function stateOf(game: string, state: "in" | "post") {
  return { op: "replace", path: `${eventUid(game)}/fullStatus/type/state`, value: state }
}

function clockOf(game: string, clock: string) {
  return { op: "replace", path: `${eventUid(game)}/fullStatus/displayClock`, value: clock }
}

const checkpointBody = readFileSync(
  new URL("./fixtures/nfl-fastcast-checkpoint-2026-10-04T1752Z.json", import.meta.url),
  "utf8"
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
  ).pipe(Effect.andThen((response) => (url.pathname === "/hang" ? Effect.never : Effect.succeed(response))))
})

/**
 * One open socket that answers the handshake and each subscription as FastCast does, recording each frame the client
 * sends; the test sends the rest and closes it. Each socket the client opens is this one again.
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
