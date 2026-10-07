import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Effect, Option, References } from "effect"
import * as DecodeTelemetry from "./DecodeTelemetry.ts"
import { DecodeObservation } from "./provider/Provider.ts"
import { counted, recordingLogs, withMetrics } from "./TestTelemetry.ts"

describe("DecodeTelemetry.observed", () => {
  it.effect("a message received is counted by league and op, and logged at Debug", () =>
    told(
      DecodeObservation.Received({
        league: Option.some("nfl"),
        op: "P",
        topic: Option.some("event-football-nfl"),
        mid: Option.some(8)
      }),
      (logs) =>
        Effect.gen(function* () {
          assert.strictEqual(yield* counted("sportal_live_feed_messages", { league: "nfl", op: "P" }), 1)
          assert.deepStrictEqual(levels(logs), ["Debug"])
        })
    )
  )

  it.effect("a message of an unknown op is logged at Debug and counted nowhere", () =>
    told(DecodeObservation.OpUnknown({ body: "{}" }), (logs) =>
      Effect.sync(() => {
        assert.deepStrictEqual(levels(logs), ["Debug"])
      })
    )
  )

  it.effect("games pushed are counted by league", () =>
    told(DecodeObservation.Pushed({ league: "nfl", games: 16 }), (logs) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* counted("sportal_live_feed_games", { league: "nfl" }), 16)
        assert.deepStrictEqual(levels(logs), [])
      })
    )
  )

  it.effect("a pushed game no listing has is counted by league", () =>
    told(DecodeObservation.Unlisted({ league: "nfl", game: GameId.make("1") }), () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* counted("sportal_live_feed_unlisted", { league: "nfl" }), 1)
      })
    )
  )

  it.effect("a reset is counted by league and reason, and logged at Warn", () =>
    told(
      DecodeObservation.Reset({
        league: "nfl",
        topic: "event-football-nfl",
        reason: "Gap",
        detail: "message 9 came after 7"
      }),
      (logs) =>
        Effect.gen(function* () {
          assert.strictEqual(
            yield* counted("sportal_live_feed_document_resets", { league: "nfl", reason: "Gap" }),
            1
          )
          assert.deepStrictEqual(levels(logs), ["Warn"])
          assert.include(logs[0]?.message, "event-football-nfl waits for its next checkpoint")
        })
    )
  )

  it.effect("a frame that does not decode is counted by feed, and logged at Error with its seq", () =>
    told(
      DecodeObservation.FrameUndecoded({ feed: "poll", channel: "nfl", kind: "response", cause: "not json" }),
      (logs) =>
        Effect.gen(function* () {
          assert.strictEqual(yield* counted("sportal_frames_undecoded", { feed: "poll" }), 1)
          assert.deepStrictEqual(levels(logs), ["Error"])
          assert.strictEqual(logs[0]?.annotations.seq, 7)
        })
    )
  )

  it.effect("an event that does not decode is counted by league and feed, and logged at Warn", () =>
    told(DecodeObservation.EventUndecoded({ league: "fbs", feed: "fastcast", cause: "bad" }), (logs) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* counted("sportal_events_undecoded", { league: "fbs", feed: "fastcast" }), 1)
        assert.deepStrictEqual(levels(logs), ["Warn"])
      })
    )
  )

  it.effect("a play that does not decode is counted by league, and logged at Warn", () =>
    told(
      DecodeObservation.PlayUndecoded({ league: "nfl", game: GameId.make("1"), play: "19", cause: "bad" }),
      (logs) =>
        Effect.gen(function* () {
          assert.strictEqual(yield* counted("sportal_live_feed_undecoded_plays", { league: "nfl" }), 1)
          assert.deepStrictEqual(levels(logs), ["Warn"])
        })
    )
  )

  it.effect("a play type the table does not know is logged at Info", () =>
    told(DecodeObservation.PlayTypeUnknown({ id: "999", text: "Something New" }), (logs) =>
      Effect.sync(() => {
        assert.deepStrictEqual(levels(logs), ["Info"])
        assert.include(logs[0]?.message, "Something New")
      })
    )
  )
})

/** Tells `observation` as frame 7, logging from Debug, then runs `check` over what was logged, with the metrics it left. */
function told(
  observation: DecodeObservation,
  check: (logs: ReturnType<typeof recordingLogs>["logs"]) => Effect.Effect<void>
) {
  const { logs, layer } = recordingLogs()
  return Effect.gen(function* () {
    yield* DecodeTelemetry.observed(observation, 7).pipe(
      Effect.provide(layer),
      Effect.provideService(References.MinimumLogLevel, "Debug")
    )
    yield* check(logs)
  }).pipe(withMetrics)
}

function levels(logs: ReturnType<typeof recordingLogs>["logs"]) {
  return logs.map(({ level }) => level)
}
