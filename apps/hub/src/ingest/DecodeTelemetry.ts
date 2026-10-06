import { Effect, Metric, Option, Record } from "effect"
import { Notice } from "../provider/Provider.ts"

/** What decode noticed in frame `seq`, as logs and metrics. Ingest tells only notices from frames after the replay. */
export function noticed(notice: Notice, seq: number): Effect.Effect<void> {
  return Notice.$match(notice, {
    Received: ({ league, op, topic, mid }) =>
      Effect.logDebug(
        `Decode: received ${op}${Option.match(mid, { onNone: () => "", onSome: (n) => ` ${n}` })}`
      ).pipe(
        Effect.annotateLogs(Record.getSomes({ league, topic, op: Option.some<string | number>(op), mid })),
        Effect.andThen(
          Metric.update(Metric.withAttributes(messages, Record.getSomes({ league, op: Option.some(op) })), 1)
        )
      ),
    OpUnknown: ({ body }) => Effect.logDebug("Decode: skipped a message of an unknown op", body),
    Pushed: ({ league, games }) => Metric.update(Metric.withAttributes(gamesPushed, { league }), games),
    Unlisted: ({ league }) => Metric.update(Metric.withAttributes(unlisted, { league }), 1),
    Reset: ({ league, topic, reason, detail }) =>
      Effect.logWarning(`Decode: ${detail}; ${topic} waits for its next checkpoint`).pipe(
        Effect.annotateLogs({ league, topic, reason }),
        Effect.andThen(Metric.update(Metric.withAttributes(resets, { league, reason }), 1))
      ),
    FrameUndecoded: ({ feed, channel, kind, cause }) =>
      Effect.logError("Decode: skipped a frame that does not decode", cause).pipe(
        Effect.annotateLogs({ feed, channel, kind }),
        Effect.andThen(Metric.update(Metric.withAttributes(framesUndecoded, { feed }), 1))
      ),
    EventUndecoded: ({ league, feed, cause }) =>
      Effect.logWarning("Decode: skipped an event that does not decode", cause).pipe(
        Effect.annotateLogs({ league, feed }),
        Effect.andThen(Metric.update(Metric.withAttributes(eventsUndecoded, { league, feed }), 1))
      ),
    PlayUndecoded: ({ league, game, play, cause }) =>
      Effect.logWarning(`Decode: skipped play ${play}, which does not decode`, cause).pipe(
        Effect.annotateLogs({ league, game }),
        Effect.andThen(Metric.update(Metric.withAttributes(playsUndecoded, { league }), 1))
      ),
    PlayTypeUnknown: ({ id, text }) =>
      Effect.logInfo(`Decode: play type ${id} (${text}) is not in the table; read as other`)
  }).pipe(Effect.annotateLogs({ seq }))
}

const messages = Metric.counter("sportal_live_feed_messages", {
  description: "Live feed messages received, by league and op",
  incremental: true
})

const gamesPushed = Metric.counter("sportal_live_feed_games", {
  description: "Game snapshots the live feed delivered, by league",
  incremental: true
})

const unlisted = Metric.counter("sportal_live_feed_unlisted", {
  description: "Pushed games no poll has listed yet, so not sent",
  incremental: true
})

const resets = Metric.counter("sportal_live_feed_document_resets", {
  description:
    "Times a live feed topic's document missed a message or could not apply one, by league and reason",
  incremental: true
})

const framesUndecoded = Metric.counter("sportal_frames_undecoded", {
  description: "Frames that did not decode and were skipped, by feed",
  incremental: true
})

const eventsUndecoded = Metric.counter("sportal_events_undecoded", {
  description: "Events, polled or pushed, that did not decode and were skipped, by league and feed",
  incremental: true
})

const playsUndecoded = Metric.counter("sportal_live_feed_undecoded_plays", {
  description: "Plays that did not decode and were left out of their game's list, each once, by league",
  incremental: true
})
