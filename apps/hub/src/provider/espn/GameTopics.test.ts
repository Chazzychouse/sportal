import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { PlayId } from "@sportal/domain/Play"
import { Effect, HashMap, Record } from "effect"
import { recordingLogs } from "../../TestTelemetry.ts"
import { Delivery } from "../Provider.ts"
import type { Frame } from "./Frame.ts"
import { GameTopics } from "./GameTopics.ts"
import * as TestEspn from "./TestEspn.ts"
import * as TestFastCast from "./TestFastCast.ts"
import * as TestGameTopics from "./TestGameTopics.ts"

describe("GameTopics#take", () => {
  it.effect("should send a topic that missed a message back to waiting for a checkpoint", () =>
    Effect.gen(function* () {
      // The recording's checkpoint and messages 819 to 822, without message 820.
      const frames = TestFastCast.moveRecordingFrames().filter((_, index) => index !== 2)

      const deliveries = yield* decoded(frames)

      // Frame 1 is the checkpoint, 2 message 819, and 3 message 821, the first after the gap.
      const playsFrames = deliveries.flatMap(({ frame, delivery }) =>
        Delivery.$is("Plays")(delivery) ? [frame] : []
      )
      assert.deepStrictEqual(playsFrames, [1, 2])
    })
  )

  it.effect("should give nothing and fail nothing for a patch or an idle message before any checkpoint", () =>
    Effect.gen(function* () {
      const deliveries = yield* decoded(TestFastCast.beforeAnyCheckpoint())

      assert.deepStrictEqual(tags(deliveries), [])
    })
  )

  it.effect("should send a topic back to waiting for a checkpoint when a patch will not apply", () =>
    Effect.gen(function* () {
      const copyFromNothing = TestFastCast.message(TestFastCast.neAtBufPlays, 820, [
        { op: "copy", from: "/entities/plays/no-such-play/text", path: "/entities/plays/401872971792/text" }
      ])
      const frames = [TestFastCast.neAtBufCheckpoint(), TestFastCast.unapplicablePatch(819), copyFromNothing]

      const deliveries = yield* decoded(frames)

      assert.deepStrictEqual(
        deliveries.filter(({ frame }) => frame > 1),
        []
      )
    })
  )

  it.effect("should reset a synced topic on a message that does not decode", () =>
    Effect.gen(function* () {
      const frames = [
        TestFastCast.neAtBufCheckpoint(),
        TestFastCast.undecodablePatch(819),
        TestFastCast.textReplaced(820)
      ]

      const deliveries = yield* decoded(frames)

      assert.deepStrictEqual(
        deliveries.filter(({ frame }) => frame > 1),
        [],
        "the topic waits for its next checkpoint"
      )
    })
  )

  it.effect("should log a topic that lost its document at Warning, with why and its topic", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()

      yield* TestGameTopics.topicsAfter([
        TestFastCast.neAtBufCheckpoint(),
        TestFastCast.unapplicablePatch(819)
      ]).pipe(Effect.provide(layer))

      const lost = logs.filter(({ message }) =>
        message.includes(`${TestFastCast.neAtBufPlays} lost its document`)
      )
      assert.lengthOf(lost, 1)
      assert.strictEqual(lost[0]?.level, "Warn")
      assert.strictEqual(lost[0]?.annotations.topic, TestFastCast.neAtBufPlays)
    })
  )

  it.effect("should sync a waiting topic on the next checkpoint that decodes", () =>
    Effect.gen(function* () {
      const frames = [TestFastCast.neAtBufCheckpoint(), TestFastCast.textReplaced(819)]

      const deliveries = yield* decoded(frames)

      assert.deepStrictEqual(
        deliveries.flatMap(({ frame, delivery }) => (frame === 2 ? [textOf(delivery, "401872971792")] : [])),
        ["Corrected"]
      )
    })
  )

  it.effect("should skip a frame that does not decode, and decode the next", () =>
    Effect.gen(function* () {
      const deliveries = yield* decoded([
        TestFastCast.undecodablePatch(819),
        TestFastCast.neAtBufCheckpoint()
      ])

      assert.deepStrictEqual(
        deliveries.map(({ frame }) => frame),
        [2]
      )
    })
  )

  it.effect("should log a frame that does not decode at Warning, with its kind and topic", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()

      yield* TestGameTopics.framesReplayed([
        TestFastCast.undecodablePatch(819),
        TestFastCast.neAtBufCheckpoint()
      ]).pipe(Effect.provide(layer))

      assert.deepStrictEqual(
        logs.map(({ level, annotations }) => [level, annotations]),
        [["Warn", { frame: "Pushed", topic: TestFastCast.neAtBufPlays }]]
      )
    })
  )

  describe("a game's plays", () => {
    it.effect(
      "should give the game's whole list, in sequence order, on a checkpoint and an add of plays",
      () =>
        Effect.gen(function* () {
          const deliveries = yield* decoded([
            TestFastCast.checkpoint(TestFastCast.ariAtNygPlays, 99, { entities: {} }),
            playsMessage(100, [
              {
                op: "add",
                path: "/entities/plays",
                value: TestEspn.plays("401872966237", "401872966271", "40187297063")
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
          TestFastCast.checkpoint(TestFastCast.ariAtNygPlays, 99, {
            entities: { plays: TestEspn.plays("401872966237", "401872966271") }
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
          TestFastCast.checkpoint(TestFastCast.ariAtNygPlays, 99, {
            entities: { plays: TestEspn.plays("401872966237", "401872966271") }
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

    it.effect("should take a move's value within the plays from its source", () =>
      Effect.gen(function* () {
        const deliveries = yield* decoded([
          TestFastCast.checkpoint(TestFastCast.ariAtNygPlays, 99, {
            entities: { plays: TestEspn.plays("401872966237", "401872966271") }
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
          const frames = TestFastCast.moveRecordingFrames()

          const deliveries = yield* decoded(frames)

          const penalty =
            deliveries[1] !== undefined && Delivery.$is("Plays")(deliveries[1].delivery)
              ? deliveries[1].delivery.plays.find((play) => play.id === "401872971792")?.text
              : undefined
          assert.isTrue(
            TestFastCast.moveRecording.messages[0]?.pl.includes('"op":"move"'),
            "the first recorded message has a move"
          )
          assert.deepStrictEqual(
            deliveries.map(({ frame }) => frame),
            [1, 2, 5],
            "the checkpoint, message 819, and message 822 change the plays"
          )
          assert.include(penalty, "PENALTY on BUF-C.McGovern")
          assert.include(deliveries.map(playIds).at(-1) ?? [], PlayId.make("4018729711662"))
        })
    )

    it.effect("should leave out a play that does not decode, and deliver the rest", () =>
      Effect.gen(function* () {
        const broken = {
          ...Record.remove(TestEspn.plays("401872966237")["401872966237"] ?? {}, "statYardage"),
          id: "401872966999"
        }
        const frames = [
          TestFastCast.checkpoint(TestFastCast.ariAtNygPlays, 99, {
            entities: { plays: { ...TestEspn.plays("401872966237", "401872966271"), "401872966999": broken } }
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
          TestFastCast.checkpoint(TestFastCast.ariAtNygPlays, 99, { entities: {} }),
          playsMessage(100, [
            { op: "replace", path: "/boxscore/teams/0/statistics/0/displayValue", value: "12" }
          ]),
          playsMessage(101, [{ op: "add", path: "/entities/plays", value: TestEspn.plays("40187297063") }])
        ]

        const deliveries = yield* decoded(frames)

        assert.deepStrictEqual(deliveries.map(playIds), [[], ["40187297063"]])
      })
    )

    it.effect("should keep the other games decoding after a gap on one game's topic", () =>
      Effect.gen(function* () {
        const frames = [
          TestFastCast.checkpoint(TestFastCast.ariAtNygPlays, 99, { entities: {} }),
          TestFastCast.checkpoint(TestFastCast.neAtBufPlays, 99, { entities: {} }),
          playsMessage(101, [{ op: "add", path: "/entities/plays", value: TestEspn.plays("401872966237") }]),
          playsMessage(
            100,
            [{ op: "add", path: "/entities/plays", value: TestEspn.plays("401872971330") }],
            TestFastCast.neAtBufPlays
          )
        ]

        const deliveries = yield* decoded(frames)

        const after = deliveries.filter(({ frame }) => frame > 2)
        assert.deepStrictEqual(
          after.map(({ delivery }) => delivery._tag),
          ["Plays"]
        )
        assert.deepStrictEqual(after.map(playIds)[0], ["401872971330"])
      })
    )

    // Recorded 2026-10-10 00:22Z: FSU at LOU's game topic checkpoint, live in the second quarter.
    it.effect("should decode a recorded college game's plays", () =>
      Effect.gen(function* () {
        const document = JSON.parse(
          readFileSync(new URL("./fixtures/fbs-gp-checkpoint-2026-10-10T0022Z.json", import.meta.url), "utf8")
        )

        const deliveries = yield* decoded([
          TestFastCast.checkpoint("gp-football-college-football-401858254", 386, document)
        ])

        const [plays] = deliveries.map(playIds)
        assert.strictEqual(plays?.length, 66)
        assert.strictEqual(plays?.at(-1), "401858254288")
      })
    )
  })

  describe("one array of deliveries per frame", () => {
    it.effect("should give a message that changes no document no deliveries", () =>
      Effect.gen(function* () {
        const [, second, ...rest] = yield* TestGameTopics.framesReplayed([
          TestFastCast.neAtBufCheckpoint(),
          TestFastCast.message(TestFastCast.neAtBufPlays, 819, [{ op: "replace", path: "/x", value: "1" }])
        ])

        assert.deepStrictEqual(rest, [])
        assert.deepStrictEqual(second, [])
      })
    )

    it.effect("should give a frame that resets its topic no deliveries", () =>
      Effect.gen(function* () {
        const frames = [TestFastCast.neAtBufCheckpoint(), TestFastCast.undecodablePatch(819)]

        const all = yield* TestGameTopics.framesReplayed(frames)

        assert.strictEqual(all.length, frames.length)
        assert.deepStrictEqual(all.at(-1), [])
      })
    )

    it.effect("should give one array of deliveries per frame", () =>
      Effect.gen(function* () {
        const frames = TestFastCast.moveRecordingFrames()

        const all = yield* TestGameTopics.framesReplayed(frames)

        assert.strictEqual(all.length, frames.length)
      })
    )
  })
})

describe("GameTopics#retained", () => {
  it.effect("should drop the document and plays of a game no longer wanted", () =>
    Effect.gen(function* () {
      const topics = yield* TestGameTopics.topicsAfter([TestFastCast.neAtBufCheckpoint()])

      const kept = topics.retained((topic) => topic.tc() !== TestFastCast.neAtBufPlays)

      assert.isFalse(HashMap.has(kept.documents.byTopic, TestFastCast.topicNamed(TestFastCast.neAtBufPlays)))
      assert.isFalse(HashMap.has(kept.plays, GameId.make("401872971")))
    })
  )

  it.effect("should keep the document of a topic still wanted", () =>
    Effect.gen(function* () {
      const topics = yield* TestGameTopics.topicsAfter([TestFastCast.neAtBufCheckpoint()])

      const kept = topics.retained((topic) => topic.tc() === TestFastCast.neAtBufPlays)

      assert.isTrue(kept.isSynced(TestFastCast.topicNamed(TestFastCast.neAtBufPlays)))
    })
  )

  it.effect("should keep a trailing game checkpoint until retention drops it", () =>
    Effect.gen(function* () {
      const [afterPush, said] = yield* GameTopics.empty.take(TestFastCast.neAtBufCheckpoint())

      const kept = afterPush.retained(() => false)

      assert.isTrue(said.some(Delivery.$is("Plays")))
      assert.isTrue(afterPush.isSynced(TestFastCast.topicNamed(TestFastCast.neAtBufPlays)))
      assert.isFalse(HashMap.has(kept.documents.byTopic, TestFastCast.topicNamed(TestFastCast.neAtBufPlays)))
      assert.isFalse(HashMap.has(kept.plays, GameId.make("401872971")))
    })
  )
})

/** The deliveries `frames` decode to, each with the place, from 1, of the frame that said it. */
function decoded(frames: ReadonlyArray<Frame>) {
  return TestGameTopics.framesReplayed(frames).pipe(
    Effect.map((all) =>
      all.flatMap((deliveries, index) => deliveries.map((delivery) => ({ frame: index + 1, delivery })))
    )
  )
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

function playsMessage(mid: number, patches: ReadonlyArray<object>, channel = TestFastCast.ariAtNygPlays) {
  return TestFastCast.message(channel, mid, patches)
}

function playIds({ delivery }: { readonly delivery: Delivery }) {
  return Delivery.$is("Plays")(delivery) ? delivery.plays.map((play) => play.id) : []
}
