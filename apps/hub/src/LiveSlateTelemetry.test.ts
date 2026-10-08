import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { liveSnapshot, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Option, References } from "effect"
import { Following } from "./Following.ts"
import * as LiveSlateTelemetry from "./LiveSlateTelemetry.ts"
import { Decoded, DecodeObservation } from "./provider/Decoder.ts"
import { Delivery } from "./slate/Delivery.ts"
import { Slate } from "./slate/Slate.ts"
import { counted, recordingLogs, withMetrics } from "./TestTelemetry.ts"

describe("LiveSlateTelemetry.told", () => {
  it.effect("should count a message received by league and op, logging it at Debug", () =>
    Effect.gen(function* () {
      const received = DecodeObservation.Received({
        league: Option.some("nfl"),
        op: "P",
        topic: Option.some("event-football-nfl"),
        mid: Option.some(8)
      })

      const logs = yield* toldOf(received)

      const messages = yield* counted("sportal_live_feed_messages", { league: "nfl", op: "P" })
      assert.strictEqual(messages, 1)
      assert.deepStrictEqual(levels(logs), ["Debug"])
    }).pipe(withMetrics)
  )

  it.effect("should log a message of an unknown op at Debug, counting it nowhere", () =>
    Effect.gen(function* () {
      const unknown = DecodeObservation.OpUnknown({ body: "{}" })

      const logs = yield* toldOf(unknown)

      assert.deepStrictEqual(levels(logs), ["Debug"])
    }).pipe(withMetrics)
  )

  it.effect("should count games pushed by league, logging nothing", () =>
    Effect.gen(function* () {
      const pushed = DecodeObservation.Pushed({ league: "nfl", games: 16 })

      const logs = yield* toldOf(pushed)

      const games = yield* counted("sportal_live_feed_games", { league: "nfl" })
      assert.strictEqual(games, 16)
      assert.deepStrictEqual(levels(logs), [])
    }).pipe(withMetrics)
  )

  it.effect("should count a pushed game no listing has by league", () =>
    Effect.gen(function* () {
      const unlisted = DecodeObservation.Unlisted({ league: "nfl", game: GameId.make("1") })

      yield* toldOf(unlisted)

      const count = yield* counted("sportal_live_feed_unlisted", { league: "nfl" })
      assert.strictEqual(count, 1)
    }).pipe(withMetrics)
  )

  it.effect("should count a reset by league and reason, logging it at Warn", () =>
    Effect.gen(function* () {
      const reset = DecodeObservation.Reset({
        league: "nfl",
        topic: "event-football-nfl",
        reason: "Gap",
        detail: "message 9 came after 7"
      })

      const logs = yield* toldOf(reset)

      const resets = yield* counted("sportal_live_feed_document_resets", { league: "nfl", reason: "Gap" })
      assert.strictEqual(resets, 1)
      assert.deepStrictEqual(levels(logs), ["Warn"])
      assert.include(logs[0]?.message, "event-football-nfl waits for its next checkpoint")
    }).pipe(withMetrics)
  )

  it.effect("should count a frame that does not decode by source, logging it at Error with its seq", () =>
    Effect.gen(function* () {
      const undecoded = DecodeObservation.FrameUndecoded({
        source: "poll",
        channel: "nfl",
        kind: "whole",
        cause: "not json"
      })

      const logs = yield* toldOf(undecoded)

      const frames = yield* counted("sportal_frames_undecoded", { source: "poll" })
      assert.strictEqual(frames, 1)
      assert.deepStrictEqual(levels(logs), ["Error"])
      assert.strictEqual(logs[0]?.annotations.seq, 7)
    }).pipe(withMetrics)
  )

  it.effect("should count an event that does not decode by league and source, logging it at Warn", () =>
    Effect.gen(function* () {
      const undecoded = DecodeObservation.EventUndecoded({ league: "fbs", source: "push", cause: "bad" })

      const logs = yield* toldOf(undecoded)

      const events = yield* counted("sportal_events_undecoded", { league: "fbs", source: "push" })
      assert.strictEqual(events, 1)
      assert.deepStrictEqual(levels(logs), ["Warn"])
    }).pipe(withMetrics)
  )

  it.effect("should count a play that does not decode by league, logging it at Warn", () =>
    Effect.gen(function* () {
      const undecoded = DecodeObservation.PlayUndecoded({
        league: "nfl",
        game: GameId.make("1"),
        play: "19",
        cause: "bad"
      })

      const logs = yield* toldOf(undecoded)

      const plays = yield* counted("sportal_live_feed_undecoded_plays", { league: "nfl" })
      assert.strictEqual(plays, 1)
      assert.deepStrictEqual(levels(logs), ["Warn"])
    }).pipe(withMetrics)
  )

  it.effect("should log a play type the table does not know at Info, with its text", () =>
    Effect.gen(function* () {
      const unknown = DecodeObservation.PlayTypeUnknown({ id: "999", text: "Something New" })

      const logs = yield* toldOf(unknown)

      assert.deepStrictEqual(levels(logs), ["Info"])
      assert.include(logs[0]?.message, "Something New")
    }).pipe(withMetrics)
  )

  it.effect(
    "should log and count an event of a game started and stopped within one take with that step's snapshot",
    () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        const at = yield* DateTime.now
        const final = snapshot({ id: one, status: "final", period: 4, clock: "0:00" })
        const taken = yield* Slate.empty.take({
          deliveries: [
            Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one }), from: "push" }),
            Delivery.cases.Snapshot.make({ snapshot: final, from: "push" })
          ],
          at,
          seq: 1
        })
        const said = taken.events.map(({ what }) => what._tag)

        yield* LiveSlateTelemetry.told(Following.Live(), Option.none(), Slate.empty, taken)
        const went = logs.filter(({ message }) => message.includes("WentFinal"))
        const wentFinal = yield* counted("sportal_game_events", { game: "1", event: "WentFinal" })

        assert.isFalse(taken.next.live.has(one))
        assert.deepStrictEqual(said, ["PeriodEnded", "WentFinal"])
        assert.strictEqual(went.length, 1)
        assert.strictEqual(went[0]?.level, "Info")
        assert.include(went[0]?.message, "at final")
        assert.strictEqual(wentFinal, 1)
      }).pipe(Effect.provide(layer), withMetrics)
    }
  )

  it.effect(
    "should annotate an event of a game changed and stopped within one take with that step's snapshot",
    () => {
      const { logs, layer } = recordingLogs("Debug")
      return Effect.gen(function* () {
        const at = yield* DateTime.now
        const first = yield* Slate.empty.take({
          deliveries: [Delivery.cases.Snapshot.make({ snapshot: liveSnapshot({ id: one }), from: "push" })],
          at,
          seq: 1
        })
        const final = snapshot({ id: one, status: "final", period: 4, clock: "0:00" })
        const taken = yield* first.next.take({
          deliveries: [Delivery.cases.Snapshot.make({ snapshot: final, from: "push" })],
          at: DateTime.add(at, { seconds: 1 }),
          seq: 2
        })

        yield* LiveSlateTelemetry.told(Following.Live(), Option.none(), first.next, taken)
        const went = logs.filter(({ message }) => message.includes("WentFinal"))
        const wentFinal = yield* counted("sportal_game_events", { game: "1", event: "WentFinal" })

        assert.isFalse(taken.next.live.has(one))
        assert.strictEqual(went.length, 1)
        assert.include(went[0]?.message, "at final")
        assert.strictEqual(wentFinal, 1)
      }).pipe(Effect.provide(layer), withMetrics)
    }
  )
})

const one = GameId.make("1")

/** Tells, live, frame 7 decoded to `observation` alone and taken to no change, logging from Debug: what was logged. */
function toldOf(observation: DecodeObservation) {
  const { logs, layer } = recordingLogs()
  const frame = new Decoded({
    seq: 7,
    at: DateTime.makeUnsafe(0),
    deliveries: [],
    resyncs: [],
    observations: [observation]
  })
  const taken = { next: Slate.empty, events: [], observations: [] }
  return LiveSlateTelemetry.told(Following.Live(), Option.some(frame), Slate.empty, taken).pipe(
    Effect.provide(layer),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.as(logs)
  )
}

function levels(logs: ReturnType<typeof recordingLogs>["logs"]) {
  return logs.map(({ level }) => level)
}
