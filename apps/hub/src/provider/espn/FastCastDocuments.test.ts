import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, HashMap, Option, Schema } from "effect"
import * as TestHub from "../../TestHub.ts"
import { Frame } from "./FastCast.ts"
import { DocumentChange, FastCastDocuments } from "./FastCastDocuments.ts"

describe("FastCastDocuments#advance", () => {
  it.effect("should add the value read at a copy's source", () =>
    Effect.gen(function* () {
      const copy = TestHub.message(TestHub.neAtBufPlays, 819, [
        { op: "copy", from: "/entities/plays/401872971917/text", path: "/entities/plays/401872971792/text" }
      ])

      const synced = yield* FastCastDocuments.empty.advance(TestHub.neAtBufCheckpoint())
      const copiedTo = yield* synced.documents.advance(copy)

      const source = yield* playText(synced.change, "401872971917")
      const copied = yield* playText(copiedTo.change, "401872971792")
      assert.isDefined(source)
      assert.strictEqual(copied, source)
    })
  )

  it.effect("should send a topic that missed a message back to waiting for a checkpoint", () =>
    Effect.gen(function* () {
      // The recording's checkpoint and messages 819 to 822, without message 820.
      const frames = TestHub.moveRecordingFrames().filter((_, index) => index !== 2)

      const reset = yield* resetTopics(frames)

      assert.deepStrictEqual(reset, [TestHub.neAtBufPlays])
    })
  )

  it.effect("should give nothing and fail nothing for a patch or an idle message before any checkpoint", () =>
    Effect.gen(function* () {
      const frames = TestHub.beforeAnyCheckpoint()

      const advanced = yield* Effect.forEach(frames, (frame, index) =>
        Effect.flatMap(documentsAfter(frames.slice(0, index)), (documents) => documents.advance(frame))
      )

      assert.deepStrictEqual(
        advanced.map(({ change }) => Option.isSome(change)),
        [false, false]
      )
      assert.deepStrictEqual(
        advanced.map(({ documents }) => syncedTopics(documents)),
        [[], []]
      )
    })
  )

  it.effect("should send a topic back to waiting for a checkpoint when a patch will not apply", () =>
    Effect.gen(function* () {
      const copyFromNothing = TestHub.message(TestHub.neAtBufPlays, 820, [
        { op: "copy", from: "/entities/plays/no-such-play/text", path: "/entities/plays/401872971792/text" }
      ])
      const frames = [TestHub.neAtBufCheckpoint(), TestHub.unapplicablePatch(819), copyFromNothing]

      const reset = yield* resetTopics(frames)

      assert.deepStrictEqual(reset, [TestHub.neAtBufPlays])
    })
  )

  it.effect("should reset a synced topic on a message that does not decode", () =>
    Effect.gen(function* () {
      const frames = [TestHub.neAtBufCheckpoint(), TestHub.undecodablePatch(819), TestHub.textReplaced(820)]

      const reset = yield* resetTopics(frames)

      assert.deepStrictEqual(reset, [TestHub.neAtBufPlays])
    })
  )

  it.effect.each([
    {
      reset: "a gap",
      frames: () => [TestHub.neAtBufCheckpoint(), TestHub.textReplaced(820)],
      expected: [TestHub.neAtBufPlays]
    },
    {
      reset: "a patch that will not apply",
      frames: () => [TestHub.neAtBufCheckpoint(), TestHub.unapplicablePatch(819), TestHub.textReplaced(820)],
      expected: [TestHub.neAtBufPlays]
    },
    {
      reset: "a message that does not decode",
      frames: () => [TestHub.neAtBufCheckpoint(), TestHub.undecodablePatch(819)],
      expected: [TestHub.neAtBufPlays]
    }
  ])("should reset a topic's document, once, after $reset", ({ frames, expected }) =>
    Effect.gen(function* () {
      const reset = yield* resetTopics(frames())

      assert.deepStrictEqual(reset, expected)
    })
  )

  it.effect("should reset no topic that was never synced", () =>
    Effect.gen(function* () {
      const reset = yield* resetTopics(TestHub.beforeAnyCheckpoint())

      assert.deepStrictEqual(reset, [])
    })
  )

  it.effect("should sync a waiting topic on the next checkpoint that decodes", () =>
    Effect.gen(function* () {
      const frames = [TestHub.neAtBufCheckpoint(), TestHub.textReplaced(819)]

      const documents = yield* documentsAfter(frames)
      const reset = yield* resetTopics(frames)

      assert.isTrue(documents.isSynced(TestHub.topicNamed(TestHub.neAtBufPlays)))
      assert.deepStrictEqual(reset, [])
    })
  )

  it.effect("should sync a topic sent back to waiting again on its next checkpoint", () =>
    Effect.gen(function* () {
      const frames = [
        TestHub.neAtBufCheckpoint(),
        TestHub.unapplicablePatch(819),
        TestHub.neAtBufCheckpoint(),
        TestHub.textReplaced(819)
      ]

      const documents = yield* documentsAfter(frames)
      const reset = yield* resetTopics(frames)

      assert.isTrue(documents.isSynced(TestHub.topicNamed(TestHub.neAtBufPlays)))
      assert.deepStrictEqual(reset, [TestHub.neAtBufPlays])
    })
  )

  it.effect(
    "should keep a topic synced through a recorded move outside the plays, still delivering the plays after it",
    () =>
      Effect.gen(function* () {
        const frames = TestHub.moveRecordingFrames()

        const documents = yield* documentsAfter(frames)
        const reset = yield* resetTopics(frames)

        assert.isTrue(documents.isSynced(TestHub.topicNamed(TestHub.neAtBufPlays)))
        assert.deepStrictEqual(reset, [])
      })
  )

  it.effect("should give nothing and fail nothing for a patch outside the plays", () =>
    Effect.gen(function* () {
      const checkpoint = TestHub.checkpoint(TestHub.ariAtNygPlays, 99, { entities: {} })
      const patch = TestHub.message(TestHub.ariAtNygPlays, 100, [
        { op: "replace", path: "/boxscore/teams/0/statistics/0/displayValue", value: "12" }
      ])
      const before = yield* documentsAfter([checkpoint])

      const after = yield* before.advance(patch)

      assert.isTrue(Option.isNone(after.change))
      assert.isTrue(after.documents.isSynced(TestHub.topicNamed(TestHub.ariAtNygPlays)))
    })
  )

  it.effect("should keep the other games decoding after a gap on one game's topic", () =>
    Effect.gen(function* () {
      const frames = [
        TestHub.checkpoint(TestHub.ariAtNygPlays, 99, { entities: {} }),
        TestHub.checkpoint(TestHub.neAtBufPlays, 99, { entities: {} }),
        TestHub.message(TestHub.ariAtNygPlays, 101, [
          { op: "add", path: "/entities/plays", value: TestHub.plays("401872966237") }
        ]),
        TestHub.message(TestHub.neAtBufPlays, 100, [
          { op: "add", path: "/entities/plays", value: TestHub.plays("401872971330") }
        ])
      ]

      const documents = yield* documentsAfter(frames)
      const reset = yield* resetTopics(frames)

      assert.deepStrictEqual(reset, [TestHub.ariAtNygPlays])
      assert.deepStrictEqual(syncedTopics(documents), [TestHub.neAtBufPlays])
    })
  )

  it.effect("should reset only its topic when a patch's payload does not decode on a synced topic", () =>
    Effect.gen(function* () {
      const server = TestHub.fakeServer()
      const { frames } = yield* TestHub.nflFrames(server)
      yield* frames.until((all) => all.length >= 2)
      yield* Effect.sync(() => server.send(TestHub.checkpointMessage(7)))
      yield* frames.until((all) => all.some((frame) => Frame.$is("Checkpoint")(frame) && frame.mid === 7))
      yield* Effect.sync(() => server.send(TestHub.undecodablePatchMessage(8)))
      const received = yield* frames.until((all) =>
        all.some((frame) => Frame.$is("Pushed")(frame) && Option.getOrUndefined(frame.mid) === 8)
      )
      const before = yield* documentsAfter(received.slice(0, -1))
      const bad = yield* Effect.fromOption(Arr.last(received))

      const { documents: after } = yield* before.advance(bad)

      assert.deepStrictEqual(syncedTopics(before), [TestHub.mainTc])
      assert.deepStrictEqual(syncedTopics(after), [])
    })
  )
})

/** The text of play `id` among the plays of a game's `change`. */
const playText = Effect.fn("FastCastDocuments.test.playText")(function* (
  change: Option.Option<DocumentChange>,
  id: string
) {
  const game = yield* Effect.fromOption(Option.filter(change, DocumentChange.$is("Game")))
  const { text } = yield* decodeText(game.plays[id])
  return text
})

/** The topics `frames` sent back to waiting for a checkpoint, in order, from no documents. */
const resetTopics = Effect.fn("FastCastDocuments.test.resetTopics")(function* (frames: ReadonlyArray<Frame>) {
  const result = yield* Effect.reduce(
    frames,
    (): { readonly documents: FastCastDocuments; readonly topics: ReadonlyArray<string> } => ({
      documents: FastCastDocuments.empty,
      topics: []
    }),
    ({ documents, topics }, frame) =>
      Effect.map(documents.advance(frame), (next) => {
        const reset = Option.filter(next.change, DocumentChange.$is("Reset"))
        return {
          documents: next.documents,
          topics: [...topics, ...Option.toArray(Option.map(reset, ({ topic }) => topic.tc()))]
        }
      })
  )
  return result.topics
})

/** The documents after `frames`, from none. */
const documentsAfter = Effect.fn("FastCastDocuments.test.documentsAfter")(function* (
  frames: ReadonlyArray<Frame>
) {
  return yield* Effect.reduce(
    frames,
    () => FastCastDocuments.empty,
    (documents, frame) => Effect.map(documents.advance(frame), (next) => next.documents)
  )
})

/** The topics whose documents are synced, by name. */
function syncedTopics(documents: FastCastDocuments) {
  return [...HashMap.keys(documents.byTopic)]
    .filter((topic) => documents.isSynced(topic))
    .map((topic) => topic.tc())
}

const decodeText = Schema.decodeUnknownEffect(Schema.Struct({ text: Schema.String }))
