import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem, Option, Schema, Stream } from "effect"
import type { Frame } from "../../feed/Frame.ts"
import * as Gzip from "../../feed/Gzip.ts"
import * as ImportRecording from "./ImportRecording.ts"

const neAtBuf = "gp-football-nfl-401872971"
const checkpointUrl = (topic: string, mid: number) =>
  `https://fcast.espncdn.com/FastcastService/pubsub/profiles/12000/topic/${topic}/message/${mid}/checkpoint`

describe("ImportRecording.importRecording", () => {
  it.effect(
    "a recording of an H, a P, and a poll becomes four frames, in the order message, checkpoint, response, message",
    () =>
      Effect.gen(function* () {
        const recording = yield* recordingOf(
          [
            { at: 1791132295165, op: "H", tc: neAtBuf, pl: checkpointUrl(neAtBuf, 99) },
            { at: 1791132689529, op: "P", tc: neAtBuf, mid: 100, ts: 1791132689001, pl: "[]" }
          ],
          [{ stem: "1791132300.250", body: '{"events":[]}' }]
        )

        const frames = yield* Stream.runCollect(ImportRecording.importRecording({ recording, games: [] }))

        // A live socket logs the `H` itself before the checkpoint it points to, so the `H` is a frame too.
        assert.deepStrictEqual(frames.map(described), [
          {
            receivedAt: 1791132295165,
            sentAt: undefined,
            sourceId: 99,
            feed: "fastcast",
            channel: neAtBuf,
            kind: "message",
            body: JSON.stringify({ op: "H", tc: neAtBuf, mid: 99, pl: checkpointUrl(neAtBuf, 99) })
          },
          {
            receivedAt: 1791132295165,
            sentAt: undefined,
            sourceId: 99,
            feed: "fastcast",
            channel: neAtBuf,
            kind: "checkpoint",
            body: '{"entities":{}}'
          },
          {
            receivedAt: 1791132300250,
            sentAt: undefined,
            sourceId: undefined,
            feed: "poll",
            channel: "nfl",
            kind: "response",
            body: '{"events":[]}'
          },
          {
            receivedAt: 1791132689529,
            sentAt: 1791132689001,
            sourceId: 100,
            feed: "fastcast",
            channel: neAtBuf,
            kind: "message",
            body: JSON.stringify({
              op: "P",
              tc: neAtBuf,
              mid: 100,
              pl: JSON.stringify({ ts: 1791132689001, pl: "[]" })
            })
          }
        ])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect(
    "numbers an idle message after the one before it, and leaves out the scoreboard topic and the socket's own messages",
    () =>
      Effect.gen(function* () {
        const recording = yield* recordingOf(
          [
            { at: 1, op: "C", rc: 200 },
            { at: 2, op: "S", tc: "event-football-nfl", rc: 200 },
            { at: 3, op: "H", tc: "event-football-nfl", pl: checkpointUrl("event-football-nfl", 4285993) },
            { at: 4, op: "R", tc: "event-football-nfl", mid: 4285994, ts: 3, pl: "[]" },
            { at: 5, op: "S", tc: neAtBuf, rc: 200 },
            { at: 6, op: "H", tc: neAtBuf, pl: checkpointUrl(neAtBuf, 99) },
            { at: 7, op: "I", tc: neAtBuf, pl: "0" },
            { at: 8, op: "P", tc: neAtBuf, mid: 101, ts: 7, pl: "[]" }
          ],
          []
        )

        const frames = yield* Stream.runCollect(ImportRecording.importRecording({ recording, games: [] }))

        assert.deepStrictEqual(
          frames.map((frame) => [frame.kind, frame.channel, frame.sourceId]),
          [
            ["message", neAtBuf, 99],
            ["checkpoint", neAtBuf, 99],
            ["message", neAtBuf, 100],
            ["message", neAtBuf, 101]
          ]
        )
        assert.strictEqual(frames[2]?.body, JSON.stringify({ op: "I", tc: neAtBuf, mid: 100, pl: "0" }))
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps only the games named: their topics, and their events in each scoreboard", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const scoreboard = yield* fs.readFileString(
        join(import.meta.dirname, "fixtures", "nfl-scoreboard-2026-10-04T1800Z.json")
      )
      const buf = "gp-football-nfl-401872972"
      const recording = yield* recordingOf(
        [
          { at: 1791132295165, op: "H", tc: neAtBuf, pl: checkpointUrl(neAtBuf, 99) },
          { at: 1791132295166, op: "H", tc: buf, pl: checkpointUrl(buf, 100) }
        ],
        [{ stem: "1791132300.000", body: scoreboard }]
      )

      const frames = yield* Stream.runCollect(
        ImportRecording.importRecording({ recording, games: ["401872971"] })
      )

      assert.deepStrictEqual(
        frames.map((frame) => [frame.kind, frame.channel]),
        [
          ["message", neAtBuf],
          ["checkpoint", neAtBuf],
          ["response", "nfl"]
        ]
      )
      const trimmed = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ events: Schema.Array(Schema.Struct({ id: Schema.String })) }))
      )(frames[2]?.body)
      assert.deepStrictEqual(
        trimmed.events.map((event) => event.id),
        ["401872971"]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("fails on a line it cannot read", () =>
    Effect.gen(function* () {
      const recording = yield* recordingOf([{ at: 1, op: "H", tc: neAtBuf, pl: "not a checkpoint URL" }], [])

      const error = yield* Stream.runCollect(ImportRecording.importRecording({ recording, games: [] })).pipe(
        Effect.flip
      )

      assert.strictEqual(error._tag, "ImportFailed")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("ImportRecording.readFrames", () => {
  it.effect("reads back the frames an import wrote", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const recording = yield* recordingOf(
        [
          { at: 1791132295165, op: "H", tc: neAtBuf, pl: checkpointUrl(neAtBuf, 99) },
          { at: 1791132689529, op: "P", tc: neAtBuf, mid: 100, ts: 1791132689001, pl: "[]" }
        ],
        [{ stem: "1791132300.250", body: '{"events":[]}' }]
      )
      const out = join(yield* fs.makeTempDirectoryScoped(), "frames.jsonl.gz")
      const imported = ImportRecording.importRecording({ recording, games: [] })

      yield* ImportRecording.writeFrames(imported, out)

      assert.deepStrictEqual(
        (yield* Stream.runCollect(ImportRecording.readFrames(out))).map(described),
        (yield* Stream.runCollect(imported)).map(described)
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** A frame with its instants as epoch milliseconds, to compare. */
function described(frame: Omit<Frame, "seq">) {
  return {
    receivedAt: DateTime.toEpochMillis(frame.receivedAt),
    sentAt: Option.getOrUndefined(Option.map(Option.fromUndefinedOr(frame.sentAt), DateTime.toEpochMillis)),
    sourceId: frame.sourceId,
    feed: frame.feed,
    channel: frame.channel,
    kind: frame.kind,
    body: frame.body
  }
}

/** An NFL recording folder, as the spike's recorder writes one: socket lines, and each poll gzip'd under its stem. */
function recordingOf(
  lines: ReadonlyArray<Record<string, string | number>>,
  polls: ReadonlyArray<{ readonly stem: string; readonly body: string }>
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const recording = join(yield* fs.makeTempDirectoryScoped(), "nfl")
    yield* fs.makeDirectory(join(recording, "scoreboard"), { recursive: true })
    yield* fs.writeFileString(
      join(recording, "fastcast.jsonl"),
      lines.map((line) => `${JSON.stringify(line)}\n`).join("")
    )
    yield* Effect.forEach(
      polls,
      ({ stem, body }) =>
        Effect.flatMap(Gzip.compress(body), (bytes) =>
          fs.writeFile(join(recording, "scoreboard", `${stem}.json.gz`), bytes)
        ),
      { discard: true }
    )
    return recording
  })
}
