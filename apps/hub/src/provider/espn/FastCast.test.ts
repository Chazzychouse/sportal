import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import {
  Array as Arr,
  Deferred,
  Effect,
  HashMap,
  Layer,
  Option,
  Schema,
  Stream,
  SubscriptionRef
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"
import { recordingLogs } from "../../TestTelemetry.ts"
import { FastCast, type Wanted } from "./FastCast.ts"
import * as FastCastMessage from "./FastCastMessage.ts"
import { Frame } from "./Frame.ts"
import type { GameTopics } from "./GameTopics.ts"
import * as TestEspn from "./TestEspn.ts"
import { fakeServer, subscribed, watched } from "./TestFastCast.ts"
import { Topic } from "./Topic.ts"

// Games of the recorded checkpoint: the first two live, the third scheduled for 20:05Z.
const firstGame = "401872971"
const secondGame = "401872972"
const laterGame = "401872974"

// The two live games' topics: the first's checkpoint is missing in the tests that follow both.
const missingTopic = gameTopic(firstGame)
const otherTopic = gameTopic(secondGame)

describe("FastCast", () => {
  it.effect("should connect, then subscribe to its wanted game topic", () =>
    Effect.gen(function* () {
      const server = fakeServer()

      const { frames } = yield* nflFrames(server)

      yield* frames.until(atLeast(2))
      yield* server.sent.until(subscribed(mainTc, 1))
      assert.deepStrictEqual(server.sent.all(), [{ op: "C" }, { op: "S", sid: "sid-1", tc: mainTc }])
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

      yield* server.sent.until(subscribed(mainTc, 2))
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

      yield* server.sent.until(subscribed(mainTc, 2))
      assert.isTrue(
        logs.some(
          (log) =>
            log.level === "Warn" &&
            log.message.includes("FastCast: the live feed failed (Closed); subscribing again")
        )
      )
    })
  )

  it.effect("should log that the live feed stopped on a defect, and keep running", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
      const host = Layer.mergeAll(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("boom"))
        ),
        Layer.succeed(Socket.WebSocketConstructor, () => fakeServer().socket)
      )

      const { ended } = yield* framesOver(host).pipe(Effect.provide(layer))
      yield* Effect.yieldNow

      const done = yield* Deferred.isDone(ended)
      const stopped = logs.filter((log) => log.message.includes("FastCast: the live feed stopped"))
      assert.lengthOf(stopped, 1)
      assert.strictEqual(stopped[0]?.level, "Error")
      assert.isFalse(done)
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

      yield* server.sent.until(subscribed(mainTc, 2))
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
        { tag: "Pushed", tc: mainTc, mid: undefined, body: "S" },
        { tag: "Pushed", tc: mainTc, mid: 7, body: "H" },
        { tag: "Checkpoint", tc: mainTc, mid: 7, document: checkpointDocument }
      ])
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

  it.effect("should emit an unreadable socket text without ending the feed", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.sendText("not json"))
      yield* Effect.sync(() => server.send({ op: "B" }))
      const received = yield* frames.until(atLeast(4))

      const bad = received[2]
      assert.isTrue(bad !== undefined && Frame.$is("Pushed")(bad) && Option.isNone(bad.envelope))
      const after = received[3]
      assert.isTrue(
        after !== undefined &&
          Frame.$is("Pushed")(after) &&
          Option.exists(after.envelope, (envelope) => envelope.op === "B")
      )
    })
  )

  it.effect("should emit a text of an unknown op with its envelope, but no topic or mid", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send({ op: "X", tc: mainTc, mid: 8, extra: 1 }))
      const received = yield* frames.until(atLeast(3))

      const unknown = received[2]
      assert.deepStrictEqual(unknown === undefined ? undefined : seen(unknown), {
        tag: "Pushed",
        tc: undefined,
        mid: undefined,
        body: "X"
      })
      assert.isTrue(
        unknown !== undefined &&
          Frame.$is("Pushed")(unknown) &&
          Option.exists(unknown.envelope, (envelope) => envelope.extra === 1)
      )
    })
  )

  it.effect("should emit a known op missing its fields with its envelope, but no topic or mid", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send({ op: "P", tc: mainTc }))
      const received = yield* frames.until(atLeast(3))

      const malformed = received[2]
      assert.deepStrictEqual(malformed === undefined ? undefined : seen(malformed), {
        tag: "Pushed",
        tc: undefined,
        mid: undefined,
        body: "P"
      })
    })
  )

  it.effect("should frame a patch whose payload does not decode with its topic and mid", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send(undecodablePatchMessage(8)))
      const received = yield* frames.until(atLeast(3))

      const patch = received[2]
      assert.deepStrictEqual(patch === undefined ? undefined : seen(patch), {
        tag: "Pushed",
        tc: mainTc,
        mid: 8,
        body: "P"
      })
    })
  )

  it.effect("should reset only its topic when a patch's payload does not decode on a synced topic", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(checkpointMessage(7)))
      yield* frames.until(wholeAt(7))
      yield* Effect.sync(() => server.send(undecodablePatchMessage(8)))
      const received = yield* frames.until(numbered(8))
      const before = yield* TestEspn.topicsAfter(received.slice(0, -1))
      const bad = yield* Effect.fromOption(Arr.last(received))

      const [after] = yield* before.take(bad)

      assert.deepStrictEqual(syncedTopics(before), [mainTc])
      assert.deepStrictEqual(syncedTopics(after), [])
    })
  )

  it.effect("should follow a topic once it is wanted", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, want } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* want([main, "AwaitingCheckpoint"], [gameOf(laterGame), "AwaitingCheckpoint"])

      yield* server.sent.until(subscribed(gameTopic(laterGame), 1))
      assert.deepStrictEqual(subscriptionsSent(server), [
        { op: "S", sid: "sid-1", tc: mainTc },
        { op: "S", sid: "sid-1", tc: gameTopic(laterGame) }
      ])
    })
  )

  it.effect("should load a second topic's checkpoint while the first still loads", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send({ ...checkpointMessage(7), pl: "https://checkpoint.test/slow" }))
      yield* Effect.sync(() =>
        server.send({ op: "H", tc: gameTopic(secondGame), mid: 3, pl: "https://checkpoint.test/slow" })
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
      yield* want([main, "AwaitingCheckpoint"], [gameOf(secondGame), "AwaitingCheckpoint"])
      yield* server.sent.until(subscribed(gameTopic(secondGame), 1))

      yield* want([main, "AwaitingCheckpoint"], [gameOf(secondGame), "AwaitingCheckpoint"])
      yield* want(
        [main, "AwaitingCheckpoint"],
        [gameOf(secondGame), "AwaitingCheckpoint"],
        [gameOf(laterGame), "AwaitingCheckpoint"]
      )

      // Wanted sets are taken in order, so once the third has subscribed, the second has sent all it would.
      yield* server.sent.until(subscribed(gameTopic(laterGame), 1))
      assert.deepStrictEqual(
        subscriptionsSent(server).map((frame) => frame.tc),
        [mainTc, gameTopic(secondGame), gameTopic(laterGame)],
        "the same topic wanted again sends none"
      )
    })
  )

  it.effect("should send nothing for a topic no longer wanted", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, want } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* want([main, "AwaitingCheckpoint"], [gameOf(secondGame), "AwaitingCheckpoint"])
      yield* server.sent.until(subscribed(gameTopic(secondGame), 1))

      yield* want([main, "AwaitingCheckpoint"])
      yield* TestClock.adjust("1 second")

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S" && frame.tc === gameTopic(secondGame)),
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

        const received = yield* frames.until(numbered(10))
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
        yield* frames.until(numbered(10))

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
      yield* frames.until(numbered(10))

      yield* want([gameOf(secondGame), "Synced"])
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
        yield* Effect.sync(() => server.send(checkpointMessage(7)))
        yield* frames.until(wholeAt(7))
        yield* want([main, "Synced"])

        yield* want([main, "AwaitingCheckpoint"])
        yield* server.sent.until(subscribed(mainTc, 2))
        yield* want([main, "AwaitingCheckpoint"])
        yield* Effect.sync(() => server.send(checkpointMessage(20)))
        yield* frames.until(wholeAt(20))

        assert.deepStrictEqual(
          server.sent.all().filter((frame) => frame.op === "S"),
          [
            { op: "S", sid: "sid-1", tc: mainTc },
            { op: "S", sid: "sid-1", tc: mainTc }
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

      yield* server.sent.until(subscribed(mainTc, 2))
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

      yield* server.sent.until(subscribed(mainTc, 2))
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
      yield* server.sent.until(subscribed(mainTc, 2))
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
        yield* server.sent.until(subscribed(mainTc, mid + 1))
      }

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S"),
        7
      )
    })
  )

  it.effect("should cancel a pending checkpoint retry once its checkpoint succeeds", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(missingCheckpoint(7)))
      yield* frames.until(numbered(7))

      yield* Effect.sync(() => server.send(checkpointMessage(8)))
      yield* frames.until(wholeAt(8))
      yield* TestClock.adjust("30 seconds")

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S"),
        1
      )
    })
  )

  it.effect("should cancel a retry for a slow failed checkpoint once a later checkpoint succeeds first", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => {
        server.send({ ...missingCheckpoint(7), pl: "https://checkpoint.test/slow-missing" })
        server.send(checkpointMessage(8))
      })
      yield* TestClock.adjust("5 seconds")
      const received = yield* frames.until(wholeAt(8))
      yield* TestClock.adjust("30 seconds")

      assert.deepStrictEqual(
        received
          .slice(2)
          .map(seen)
          .map(({ tag, mid }) => [tag, mid]),
        [
          ["Pushed", 7],
          ["Pushed", 8],
          ["Checkpoint", 8]
        ]
      )
      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S"),
        1
      )
    })
  )

  it.effect("should keep the retry of a failed checkpoint that follows a slow successful one", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => {
        server.send({ ...checkpointMessage(7), pl: "https://checkpoint.test/slow" })
        server.send(missingCheckpoint(8))
      })
      yield* TestClock.adjust("5 seconds")
      const received = yield* frames.until(numbered(8))
      yield* TestClock.adjust("30 seconds")

      yield* server.sent.until(subscribed(mainTc, 2))
      assert.deepStrictEqual(
        received
          .slice(2)
          .map(seen)
          .map(({ tag, mid }) => [tag, mid]),
        [
          ["Pushed", 7],
          ["Checkpoint", 7],
          ["Pushed", 8]
        ]
      )
      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S"),
        2
      )
    })
  )

  it.effect(
    "should subscribe at once to a topic whose document is lost while its re-subscribe waits, and not again when the wait ends",
    () =>
      Effect.gen(function* () {
        const server = fakeServer()
        const { want } = yield* dueToBeFollowedAgain(server)

        yield* want([main, "AwaitingCheckpoint"])
        yield* server.sent.until(subscribed(mainTc, 3))
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
      yield* want([main, "Synced"], [gameOf(secondGame), "Synced"])
      yield* server.sent.until(subscribed(gameTopic(secondGame), 1))

      yield* Effect.sync(() => server.close(1000))
      yield* TestClock.adjust("2 seconds")

      yield* server.sent.until(subscribed(gameTopic(secondGame), 2))
      yield* server.sent.until(subscribed(mainTc, 2))
      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S" && frame.tc === mainTc),
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

/** NFL frames once `missingTopic`'s and `otherTopic`'s games are wanted and both are subscribed (the first by default). */
function twoGamesFollowed(server: ReturnType<typeof fakeServer>, logged: Layer.Layer<never>) {
  return Effect.gen(function* () {
    const following = yield* nflFrames(server).pipe(Effect.provide(logged))

    yield* following.frames.until(atLeast(2))
    yield* following.want([main, "AwaitingCheckpoint"], [gameOf(secondGame), "AwaitingCheckpoint"])
    yield* server.sent.until(subscribed(otherTopic, 1))
    return following
  })
}

/** Sends an H for each game topic, `missingTopic`'s checkpoint missing, then a patch on `otherTopic`. */
function missingCheckpointBesideOther(server: ReturnType<typeof fakeServer>) {
  return Effect.sync(() => {
    server.send({ op: "H", tc: missingTopic, mid: 5, pl: "https://checkpoint.test/missing" })
    server.send({ op: "H", tc: otherTopic, mid: 9, pl: "https://checkpoint.test/9" })
    server.send({ ...patchMessage(10), tc: otherTopic })
  })
}

/** NFL frames once the game topic has an H whose checkpoint never comes, logging to `logged`. */
function hangingCheckpoint(server: ReturnType<typeof fakeServer>, logged: Layer.Layer<never>) {
  return Effect.gen(function* () {
    const following = yield* nflFrames(server).pipe(Effect.provide(logged))

    yield* following.frames.until(atLeast(2))
    yield* Effect.sync(() => server.send({ op: "H", tc: mainTc, mid: 7, pl: "https://checkpoint.test/hang" }))
    return following
  })
}

/**
 * NFL frames once the game topic is due to be followed again: synced at 7, its document lost so it is
 * subscribed to again, that subscription's checkpoint at 10 missing, then a checkpoint at 11 FastCast sent unasked,
 * which synced it and cancelled the wait, then another unasked at 12 missing, which waits to follow it again.
 */
function dueToBeFollowedAgain(server: ReturnType<typeof fakeServer>) {
  return Effect.gen(function* () {
    const following = yield* nflFrames(server)

    yield* following.frames.until(atLeast(2))
    yield* Effect.sync(() => server.send(checkpointMessage(7)))
    yield* following.frames.until(wholeAt(7))
    yield* following.want([main, "Synced"])
    yield* following.want([main, "AwaitingCheckpoint"])
    yield* server.sent.until(subscribed(mainTc, 2))
    yield* Effect.sync(() => server.send(missingCheckpoint(10)))
    yield* following.frames.until(numbered(10))
    yield* Effect.sync(() => server.send(checkpointMessage(11)))
    yield* following.frames.until(wholeAt(11))
    yield* following.want([main, "Synced"])
    yield* Effect.sync(() => server.send(missingCheckpoint(12)))
    yield* following.frames.until(numbered(12))
    return following
  })
}

/** Every subscription the client sent. */
function subscriptionsSent(server: ReturnType<typeof fakeServer>) {
  return server.sent.all().filter((frame) => frame.op === "S")
}

/** Every handshake the client sent: one per socket it opened. */
function connectsSent(server: ReturnType<typeof fakeServer>) {
  return server.sent.all().filter((frame) => frame.op === "C")
}

/** The NFL game topic followed from the start, and any NFL game's. */
const gameOf = (game: string) => new Topic({ league: "nfl", game: GameId.make(game) })
const main = gameOf(firstGame)
const mainTc = gameTopic(firstGame)

/** A wanted set of `entries`. */
function wantedOf(...entries: ReadonlyArray<readonly [Topic, HashMap.HashMap.Value<Wanted>]>): Wanted {
  return HashMap.fromIterable(entries)
}

/**
 * Runs FastCast's frames over `server` in a fiber of its own, told to follow the NFL game `main` until `want` says
 * otherwise, collecting them into `frames` and completing `ended` if they ever end.
 */
function nflFrames(server: ReturnType<typeof fakeServer>) {
  return framesOver(fastCastHost(server))
}

/**
 * Runs FastCast's frames over `host` in a fiber of its own, told to follow the NFL game `main` until `want` says
 * otherwise, collecting them into `frames` and completing `ended` if they ever end.
 */
function framesOver(host: Layer.Layer<HttpClient.HttpClient | Socket.WebSocketConstructor>) {
  return Effect.gen(function* () {
    const ended = yield* Deferred.make<void>()
    const frames = watched<Frame>()
    const wanted = yield* SubscriptionRef.make(wantedOf([main, "AwaitingCheckpoint"]))
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
    Pushed: ({ topic, mid, envelope }) => ({
      tag: "Pushed",
      tc: Option.getOrUndefined(Option.map(topic, (each) => each.tc())),
      mid: Option.getOrUndefined(mid),
      body: Option.getOrUndefined(Option.map(envelope, (value) => value.op))
    }),
    Checkpoint: ({ topic, mid, document }) => ({ tag: "Checkpoint", tc: topic.tc(), mid, document })
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

/** The recorded game package's checkpoint, at `mid`. */
function checkpointMessage(mid: number) {
  return { op: "H", tc: mainTc, mid, pl: `https://checkpoint.test/${mid}` }
}

function garbledCheckpoint(mid: number) {
  return { op: "H", tc: mainTc, mid, pl: "https://checkpoint.test/garbled" }
}

function missingCheckpoint(mid: number) {
  return { op: "H", tc: mainTc, mid, pl: "https://checkpoint.test/missing" }
}

/** A `P` at `mid` that patches nothing. */
function patchMessage(mid: number) {
  return { op: "P", tc: mainTc, mid, pl: JSON.stringify({ ts: 1791136341731, pl: [] }) }
}

/** A `P` at `mid` whose patches are base64, but not zlib-deflated. */
function undecodablePatchMessage(mid: number) {
  const pl = Buffer.from("not deflated").toString("base64")
  return { op: "P", tc: mainTc, mid, pl: JSON.stringify({ ts: 1791136341731, pl }) }
}

/** The topics whose documents `state` has synced, by name. */
function syncedTopics(state: GameTopics) {
  return [...HashMap.keys(state.documents.byTopic)]
    .filter((topic) => state.documents.isSynced(topic))
    .map((topic) => topic.tc())
}

const checkpointBody = JSON.stringify(
  JSON.parse(readFileSync(new URL("./fixtures/nfl-gp-move-2026-10-04.json", import.meta.url), "utf8"))
    .checkpoint.body
)

const checkpointDocument = Schema.decodeSync(FastCastMessage.Checkpoint)(checkpointBody)

// FastCast's host lookup, and any checkpoint, which is the recorded one, except a missing one, one that is not a game
// package, one that never comes, and a recorded or missing one that comes after 5 s.
const espn = HttpClient.make((request) => {
  const url = new URL(request.url)
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      url.pathname.endsWith("websockethost")
        ? new Response(JSON.stringify({ ip: "fastcast.test", securePort: 443, token: "token" }))
        : url.pathname === "/missing" || url.pathname === "/slow-missing"
          ? new Response("Not Found", { status: 404 })
          : url.pathname === "/garbled"
            ? new Response(JSON.stringify({ entities: "not a game package" }))
            : new Response(checkpointBody)
    )
  ).pipe(
    Effect.andThen((response) =>
      url.pathname === "/hang"
        ? Effect.never
        : url.pathname === "/slow" || url.pathname === "/slow-missing"
          ? Effect.sleep("5 seconds").pipe(Effect.as(response))
          : Effect.succeed(response)
    )
  )
})
