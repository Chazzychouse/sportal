import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { PlayId } from "@sportal/domain/Play"
import { Array as Arr, Effect, HashMap, Logger, Option, Record } from "effect"
import * as TestHub from "../../TestHub.ts"
import { Delivery } from "../Provider.ts"
import { Frame } from "./FastCast.ts"
import { GameTopics } from "./GameTopics.ts"

describe("GameTopics#take", () => {
  it.effect("should send a topic that missed a message back to waiting for a checkpoint", () =>
    Effect.gen(function* () {
      // The recording's checkpoint and messages 819 to 822, without message 820.
      const frames = TestHub.moveRecordingFrames().filter((_, index) => index !== 2)

      const deliveries = yield* decoded(frames)
      const reset = yield* resetTopics(frames)

      // Frame 1 is the checkpoint, 2 message 819, and 3 message 821, the first after the gap.
      const playsFrames = deliveries.flatMap(({ frame, delivery }) =>
        Delivery.$is("Plays")(delivery) ? [frame] : []
      )
      assert.deepStrictEqual(playsFrames, [1, 2])
      assert.deepStrictEqual(reset, [TestHub.neAtBufPlays])
    })
  )

  it.effect("should give nothing and fail nothing for a patch or an idle message before any checkpoint", () =>
    Effect.gen(function* () {
      const frames = TestHub.beforeAnyCheckpoint()

      const deliveries = yield* decoded(frames)
      const synced = yield* Effect.forEach(frames, (_, index) =>
        Effect.map(TestHub.topicsAfter(frames.slice(0, index + 1)), syncedTopics)
      )

      assert.deepStrictEqual(tags(deliveries), [])
      assert.deepStrictEqual(synced, [[], []])
    })
  )

  it.effect("should send a topic back to waiting for a checkpoint when a patch will not apply", () =>
    Effect.gen(function* () {
      const copyFromNothing = TestHub.message(TestHub.neAtBufPlays, 820, [
        { op: "copy", from: "/entities/plays/no-such-play/text", path: "/entities/plays/401872971792/text" }
      ])
      const frames = [TestHub.neAtBufCheckpoint(), TestHub.unapplicablePatch(819), copyFromNothing]

      const deliveries = yield* decoded(frames)
      const reset = yield* resetTopics(frames)

      assert.deepStrictEqual(
        deliveries.filter(({ frame }) => frame > 1),
        []
      )
      assert.deepStrictEqual(reset, [TestHub.neAtBufPlays])
    })
  )

  it.effect("should reset a synced topic on a message that does not decode", () =>
    Effect.gen(function* () {
      const frames = [TestHub.neAtBufCheckpoint(), TestHub.undecodablePatch(819), TestHub.textReplaced(820)]

      const deliveries = yield* decoded(frames)
      const reset = yield* resetTopics(frames)

      assert.deepStrictEqual(
        deliveries.filter(({ frame }) => frame > 1),
        [],
        "the topic waits for its next checkpoint"
      )
      assert.deepStrictEqual(reset, [TestHub.neAtBufPlays])
    })
  )

  it.effect("should sync a waiting topic on the next checkpoint that decodes", () =>
    Effect.gen(function* () {
      const frames = [TestHub.neAtBufCheckpoint(), TestHub.textReplaced(819)]

      const deliveries = yield* decoded(frames)
      const topics = yield* TestHub.topicsAfter(frames)
      const reset = yield* resetTopics(frames)

      assert.deepStrictEqual(
        deliveries.flatMap(({ frame, delivery }) => (frame === 2 ? [textOf(delivery, "401872971792")] : [])),
        ["Corrected"]
      )
      assert.isTrue(topics.isSynced(TestHub.topicNamed(TestHub.neAtBufPlays)))
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

      const topics = yield* TestHub.topicsAfter(frames)
      const reset = yield* resetTopics(frames)

      assert.isTrue(topics.isSynced(TestHub.topicNamed(TestHub.neAtBufPlays)))
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
      const before = yield* TestHub.topicsAfter(received.slice(0, -1))
      const bad = yield* Effect.fromOption(Arr.last(received))

      const [after] = yield* before.take(bad)

      assert.deepStrictEqual(syncedTopics(before), [TestHub.mainTc])
      assert.deepStrictEqual(syncedTopics(after), [])
    })
  )

  it.effect("should skip a frame that does not decode, and decode the next", () =>
    Effect.gen(function* () {
      const deliveries = yield* decoded([TestHub.undecodablePatch(819), TestHub.neAtBufCheckpoint()])

      assert.deepStrictEqual(
        deliveries.map(({ frame }) => frame),
        [2]
      )
    })
  )

  describe("a game's plays", () => {
    it.effect(
      "should give the game's whole list, in sequence order, on a checkpoint and an add of plays",
      () =>
        Effect.gen(function* () {
          const deliveries = yield* decoded([
            TestHub.checkpoint(TestHub.ariAtNygPlays, 99, { entities: {} }),
            playsMessage(100, [
              {
                op: "add",
                path: "/entities/plays",
                value: TestHub.plays("401872966237", "401872966271", "40187297063")
              }
            ])
          ])

          assert.deepStrictEqual(deliveries.map(playIds), [
            [],
            ["40187297063", "401872966237", "401872966271"]
          ])
          assert.deepStrictEqual(
            deliveries.map(({ delivery }) => (Delivery.$is("Plays")(delivery) ? delivery.game : undefined)),
            [GameId.make("401872966"), GameId.make("401872966")]
          )
        })
    )

    it.effect("should keep a play no patch touched as it was decoded", () =>
      Effect.gen(function* () {
        const deliveries = yield* decoded([
          TestHub.checkpoint(TestHub.ariAtNygPlays, 99, {
            entities: { plays: TestHub.plays("401872966237", "401872966271") }
          }),
          playsMessage(100, [
            { op: "replace", path: "/entities/plays/401872966271/text", value: "Corrected" }
          ])
        ])

        const [first, second] = deliveries.map(({ delivery }) =>
          Delivery.$is("Plays")(delivery)
            ? delivery.plays.find((play) => play.id === "401872966237")
            : undefined
        )
        assert.isDefined(first)
        assert.strictEqual(second, first)
      })
    )

    it.effect("should give the new list on each replaced text, removed play, and copy within the plays", () =>
      Effect.gen(function* () {
        const deliveries = yield* decoded([
          TestHub.checkpoint(TestHub.ariAtNygPlays, 99, {
            entities: { plays: TestHub.plays("401872966237", "401872966271") }
          }),
          playsMessage(100, [
            { op: "replace", path: "/entities/plays/401872966237/text", value: "Corrected" }
          ]),
          playsMessage(101, [
            {
              op: "copy",
              from: "/entities/plays/401872966237/text",
              path: "/entities/plays/401872966271/text"
            }
          ]),
          playsMessage(102, [{ op: "remove", path: "/entities/plays/401872966237" }])
        ])

        assert.deepStrictEqual(
          deliveries.map(({ delivery }) =>
            Delivery.$is("Plays")(delivery) ? delivery.plays.map((play) => play.text) : []
          ),
          [
            [
              " J.Brissett pass short left to M.Harrison for 12 yards, TOUCHDOWN.",
              "Official Timeout at 11:08."
            ],
            ["Corrected", "Official Timeout at 11:08."],
            ["Corrected", "Corrected"],
            ["Corrected"]
          ]
        )
      })
    )

    it.effect("should give a recorded copy's target the value read at its source", () =>
      Effect.gen(function* () {
        const copy = TestHub.message(TestHub.neAtBufPlays, 819, [
          { op: "copy", from: "/entities/plays/401872971917/text", path: "/entities/plays/401872971792/text" }
        ])

        const deliveries = yield* decoded([TestHub.neAtBufCheckpoint(), copy])

        const [source] = deliveries.flatMap(({ frame, delivery }) =>
          frame === 1 ? [textOf(delivery, "401872971917")] : []
        )
        const [copied] = deliveries.flatMap(({ frame, delivery }) =>
          frame === 2 ? [textOf(delivery, "401872971792")] : []
        )
        assert.isDefined(source)
        assert.strictEqual(copied, source)
      })
    )

    it.effect("should take a move's value within the plays from its source", () =>
      Effect.gen(function* () {
        const deliveries = yield* decoded([
          TestHub.checkpoint(TestHub.ariAtNygPlays, 99, {
            entities: { plays: TestHub.plays("401872966237", "401872966271") }
          }),
          playsMessage(100, [
            { op: "move", from: "/entities/plays/401872966271", path: "/entities/plays/moved" }
          ]),
          playsMessage(101, [{ op: "remove", path: "/entities/plays/moved" }])
        ])

        assert.deepStrictEqual(deliveries.map(playIds), [
          ["401872966237", "401872966271"],
          ["401872966237", "401872966271"],
          ["401872966237"]
        ])
      })
    )

    it.effect(
      "should keep a topic synced through a recorded move outside the plays, still delivering the plays after it",
      () =>
        Effect.gen(function* () {
          const frames = TestHub.moveRecordingFrames()

          const deliveries = yield* decoded(frames)
          const topics = yield* TestHub.topicsAfter(frames)
          const reset = yield* resetTopics(frames)

          const penalty =
            deliveries[1] !== undefined && Delivery.$is("Plays")(deliveries[1].delivery)
              ? deliveries[1].delivery.plays.find((play) => play.id === "401872971792")?.text
              : undefined
          assert.isTrue(
            TestHub.moveRecording.messages[0]?.pl.includes('"op":"move"'),
            "the first recorded message has a move"
          )
          assert.deepStrictEqual(
            deliveries.map(({ frame }) => frame),
            [1, 2, 5],
            "the checkpoint, message 819, and message 822 change the plays"
          )
          assert.include(penalty, "PENALTY on BUF-C.McGovern")
          assert.include(deliveries.map(playIds).at(-1) ?? [], PlayId.make("4018729711662"))
          assert.isTrue(topics.isSynced(TestHub.topicNamed(TestHub.neAtBufPlays)))
          assert.deepStrictEqual(reset, [])
        })
    )

    it.effect("should leave out a play that does not decode, and deliver the rest", () =>
      Effect.gen(function* () {
        const broken = {
          ...Record.remove(TestHub.plays("401872966237")["401872966237"] ?? {}, "statYardage"),
          id: "401872966999"
        }
        const frames = [
          TestHub.checkpoint(TestHub.ariAtNygPlays, 99, {
            entities: { plays: { ...TestHub.plays("401872966237", "401872966271"), "401872966999": broken } }
          }),
          playsMessage(100, [
            { op: "replace", path: "/entities/plays/401872966271/text", value: "Corrected" }
          ])
        ]

        const deliveries = yield* decoded(frames)

        assert.deepStrictEqual(deliveries.map(playIds), [
          ["401872966237", "401872966271"],
          ["401872966237", "401872966271"]
        ])
      })
    )

    it.effect("should give nothing and fail nothing for a patch outside the plays", () =>
      Effect.gen(function* () {
        const frames = [
          TestHub.checkpoint(TestHub.ariAtNygPlays, 99, { entities: {} }),
          playsMessage(100, [
            { op: "replace", path: "/boxscore/teams/0/statistics/0/displayValue", value: "12" }
          ]),
          playsMessage(101, [{ op: "add", path: "/entities/plays", value: TestHub.plays("40187297063") }])
        ]

        const deliveries = yield* decoded(frames)
        const afterOutside = yield* TestHub.topicsAfter(frames.slice(0, 2))

        assert.deepStrictEqual(deliveries.map(playIds), [[], ["40187297063"]])
        assert.isTrue(afterOutside.isSynced(TestHub.topicNamed(TestHub.ariAtNygPlays)))
      })
    )

    it.effect("should keep the other games decoding after a gap on one game's topic", () =>
      Effect.gen(function* () {
        const frames = [
          TestHub.checkpoint(TestHub.ariAtNygPlays, 99, { entities: {} }),
          TestHub.checkpoint(TestHub.neAtBufPlays, 99, { entities: {} }),
          playsMessage(101, [{ op: "add", path: "/entities/plays", value: TestHub.plays("401872966237") }]),
          playsMessage(
            100,
            [{ op: "add", path: "/entities/plays", value: TestHub.plays("401872971330") }],
            TestHub.neAtBufPlays
          )
        ]

        const deliveries = yield* decoded(frames)
        const topics = yield* TestHub.topicsAfter(frames)
        const reset = yield* resetTopics(frames)

        const after = deliveries.filter(({ frame }) => frame > 2)
        assert.deepStrictEqual(
          after.map(({ delivery }) => delivery._tag),
          ["Plays"]
        )
        assert.deepStrictEqual(after.map(playIds)[0], ["401872971330"])
        assert.deepStrictEqual(reset, [TestHub.ariAtNygPlays])
        assert.deepStrictEqual(syncedTopics(topics), [TestHub.neAtBufPlays])
      })
    )

    // Recorded 2026-10-10 00:22Z: FSU at LOU's game topic checkpoint, live in the second quarter.
    it.effect("should decode a recorded college game's plays", () =>
      Effect.gen(function* () {
        const document = JSON.parse(
          readFileSync(new URL("./fixtures/fbs-gp-checkpoint-2026-10-10T0022Z.json", import.meta.url), "utf8")
        )

        const deliveries = yield* decoded([
          TestHub.checkpoint("gp-football-college-football-401858254", 386, document)
        ])

        const [plays] = deliveries.map(playIds)
        assert.strictEqual(plays?.length, 66)
        assert.strictEqual(plays?.at(-1), "401858254288")
      })
    )
  })

  describe("what each frame said", () => {
    it.effect("should say nothing for a message that changes no document", () =>
      Effect.gen(function* () {
        const [, second, ...rest] = yield* TestHub.framesReplayed([
          TestHub.neAtBufCheckpoint(),
          TestHub.message(TestHub.neAtBufPlays, 819, [{ op: "replace", path: "/x", value: "1" }])
        ])

        assert.deepStrictEqual(rest, [])
        assert.deepStrictEqual(second, Option.none())
      })
    )

    it.effect("should say nothing for a frame that resets its topic", () =>
      Effect.gen(function* () {
        const frames = [TestHub.neAtBufCheckpoint(), TestHub.undecodablePatch(819)]

        const all = yield* TestHub.framesReplayed(frames)

        assert.strictEqual(all.length, frames.length)
        assert.deepStrictEqual(all.at(-1), Option.none())
      })
    )

    it.effect("should say at most one thing per frame", () =>
      Effect.gen(function* () {
        const frames = TestHub.moveRecordingFrames()

        const all = yield* TestHub.framesReplayed(frames)

        assert.strictEqual(all.length, frames.length)
      })
    )
  })
})

describe("GameTopics#retained", () => {
  it.effect("should drop the document and plays of a game no longer wanted", () =>
    Effect.gen(function* () {
      const topics = yield* TestHub.topicsAfter([TestHub.neAtBufCheckpoint()])

      const kept = topics.retained((topic) => topic.tc() !== TestHub.neAtBufPlays)

      assert.isFalse(HashMap.has(kept.documents, TestHub.topicNamed(TestHub.neAtBufPlays)))
      assert.isFalse(HashMap.has(kept.plays, GameId.make("401872971")))
    })
  )

  it.effect("should keep the document of a topic still wanted", () =>
    Effect.gen(function* () {
      const topics = yield* TestHub.topicsAfter([TestHub.neAtBufCheckpoint()])

      const kept = topics.retained((topic) => topic.tc() === TestHub.neAtBufPlays)

      assert.isTrue(kept.isSynced(TestHub.topicNamed(TestHub.neAtBufPlays)))
    })
  )

  it.effect("should keep a trailing game checkpoint until retention drops it", () =>
    Effect.gen(function* () {
      const [afterPush, said] = yield* GameTopics.empty.take(TestHub.neAtBufCheckpoint())

      const kept = afterPush.retained(() => false)

      assert.isTrue(Option.exists(said, Delivery.$is("Plays")))
      assert.isTrue(afterPush.isSynced(TestHub.topicNamed(TestHub.neAtBufPlays)))
      assert.isFalse(HashMap.has(kept.documents, TestHub.topicNamed(TestHub.neAtBufPlays)))
      assert.isFalse(HashMap.has(kept.plays, GameId.make("401872971")))
    })
  )
})

/** The deliveries `frames` decode to, each with the place, from 1, of the frame that said it. */
function decoded(frames: ReadonlyArray<Frame>) {
  return TestHub.framesReplayed(frames).pipe(
    Effect.map((all) =>
      all.flatMap((said, index) => Option.toArray(said).map((delivery) => ({ frame: index + 1, delivery })))
    )
  )
}

/** The topics `frames` sent back to waiting for a checkpoint, in order, by the warnings that say so. */
const resetTopics = Effect.fn("GameTopics.test.resetTopics")(function* (frames: ReadonlyArray<Frame>) {
  const reset: Array<string> = []
  const collector = Logger.make(({ message }) => {
    const tc = /GameTopics: (\S+) lost its document/.exec(JSON.stringify(message))?.[1]
    if (tc !== undefined) reset.push(tc)
  })

  yield* TestHub.framesReplayed(frames).pipe(Effect.provide(Logger.layer([collector])))
  return reset
})

/** The topics whose documents are synced, by name. */
function syncedTopics(topics: GameTopics) {
  return [...HashMap.keys(topics.documents)]
    .filter((topic) => topics.isSynced(topic))
    .map((topic) => topic.tc())
}

function tags(deliveries: ReadonlyArray<{ readonly delivery: Delivery }>) {
  return deliveries.map(({ delivery }) => delivery._tag)
}

/** The text of play `id` in `delivery`, when it delivers plays. */
function textOf(delivery: Delivery | undefined, id: string) {
  return delivery !== undefined && Delivery.$is("Plays")(delivery)
    ? delivery.plays.find((play) => play.id === id)?.text
    : undefined
}

function playsMessage(mid: number, patches: ReadonlyArray<object>, channel = TestHub.ariAtNygPlays) {
  return TestHub.message(channel, mid, patches)
}

function playIds({ delivery }: { readonly delivery: Delivery }) {
  return Delivery.$is("Plays")(delivery) ? delivery.plays.map((play) => play.id) : []
}
