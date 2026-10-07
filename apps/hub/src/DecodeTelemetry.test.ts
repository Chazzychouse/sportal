import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Effect, Option, References } from "effect"
import * as DecodeTelemetry from "./DecodeTelemetry.ts"
import { DecodeObservation } from "./provider/Provider.ts"
import { counted, recordingLogs, withMetrics } from "./TestTelemetry.ts"

describe("DecodeTelemetry.observed", () => {
  it.effect("should count a message received by league and op, logging it at Debug", () =>
    Effect.gen(function* () {
      const received = DecodeObservation.Received({
        league: Option.some("nfl"),
        op: "P",
        topic: Option.some("event-football-nfl"),
        mid: Option.some(8)
      })

      const logs = yield* told(received)

      const messages = yield* counted("sportal_live_feed_messages", { league: "nfl", op: "P" })
      assert.strictEqual(messages, 1)
      assert.deepStrictEqual(levels(logs), ["Debug"])
    }).pipe(withMetrics)
  )

  it.effect("should log a message of an unknown op at Debug, counting it nowhere", () =>
    Effect.gen(function* () {
      const unknown = DecodeObservation.OpUnknown({ body: "{}" })

      const logs = yield* told(unknown)

      assert.deepStrictEqual(levels(logs), ["Debug"])
    }).pipe(withMetrics)
  )

  it.effect("should count games pushed by league, logging nothing", () =>
    Effect.gen(function* () {
      const pushed = DecodeObservation.Pushed({ league: "nfl", games: 16 })

      const logs = yield* told(pushed)

      const games = yield* counted("sportal_live_feed_games", { league: "nfl" })
      assert.strictEqual(games, 16)
      assert.deepStrictEqual(levels(logs), [])
    }).pipe(withMetrics)
  )

  it.effect("should count a pushed game no listing has by league", () =>
    Effect.gen(function* () {
      const unlisted = DecodeObservation.Unlisted({ league: "nfl", game: GameId.make("1") })

      yield* told(unlisted)

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

      const logs = yield* told(reset)

      const resets = yield* counted("sportal_live_feed_document_resets", { league: "nfl", reason: "Gap" })
      assert.strictEqual(resets, 1)
      assert.deepStrictEqual(levels(logs), ["Warn"])
      assert.include(logs[0]?.message, "event-football-nfl waits for its next checkpoint")
    }).pipe(withMetrics)
  )

  it.effect("should count a frame that does not decode by feed, logging it at Error with its seq", () =>
    Effect.gen(function* () {
      const undecoded = DecodeObservation.FrameUndecoded({
        feed: "poll",
        channel: "nfl",
        kind: "response",
        cause: "not json"
      })

      const logs = yield* told(undecoded)

      const frames = yield* counted("sportal_frames_undecoded", { feed: "poll" })
      assert.strictEqual(frames, 1)
      assert.deepStrictEqual(levels(logs), ["Error"])
      assert.strictEqual(logs[0]?.annotations.seq, 7)
    }).pipe(withMetrics)
  )

  it.effect("should count an event that does not decode by league and feed, logging it at Warn", () =>
    Effect.gen(function* () {
      const undecoded = DecodeObservation.EventUndecoded({ league: "fbs", feed: "fastcast", cause: "bad" })

      const logs = yield* told(undecoded)

      const events = yield* counted("sportal_events_undecoded", { league: "fbs", feed: "fastcast" })
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

      const logs = yield* told(undecoded)

      const plays = yield* counted("sportal_live_feed_undecoded_plays", { league: "nfl" })
      assert.strictEqual(plays, 1)
      assert.deepStrictEqual(levels(logs), ["Warn"])
    }).pipe(withMetrics)
  )

  it.effect("should log a play type the table does not know at Info, with its text", () =>
    Effect.gen(function* () {
      const unknown = DecodeObservation.PlayTypeUnknown({ id: "999", text: "Something New" })

      const logs = yield* told(unknown)

      assert.deepStrictEqual(levels(logs), ["Info"])
      assert.include(logs[0]?.message, "Something New")
    }).pipe(withMetrics)
  )
})

/** Tells `observation` as frame 7, logging from Debug: what was logged. */
function told(observation: DecodeObservation) {
  const { logs, layer } = recordingLogs()
  return DecodeTelemetry.observed(observation, 7).pipe(
    Effect.provide(layer),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.as(logs)
  )
}

function levels(logs: ReturnType<typeof recordingLogs>["logs"]) {
  return logs.map(({ level }) => level)
}
