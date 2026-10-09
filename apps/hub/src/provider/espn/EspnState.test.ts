import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Play, PlayId } from "@sportal/domain/Play"
import { DateTime, Effect, Equal, HashMap, Metric, Option, Record, Schema } from "effect"
import { counted, recordingLogs, withMetrics } from "../../TestTelemetry.ts"
import { Delivery } from "../Provider.ts"
import { EspnEvent } from "./EspnEvent.ts"
import { EspnState } from "./EspnState.ts"
import * as FastCastMessage from "./FastCastMessage.ts"
import { Frame } from "./Frame.ts"
import { decodedFrames, recordedNeAtBuf, stateAfter } from "./TestEspn.ts"
import { Topic, tcOf, topicOf } from "./Topic.ts"

// Recorded from ESPN on 2026-10-04: the NFL checkpoint at 17:52Z, every socket text on its topic after it until
// 18:00Z, each line one text as it arrived, and the scoreboard polled at 18:00Z.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
const checkpointBody = fixture("nfl-fastcast-checkpoint-2026-10-04T1752Z.json")
const socketTexts = Schema.decodeSync(Schema.Array(Schema.fromJsonString(Schema.String)))(
  fixture("nfl-fastcast-messages-2026-10-04T1752Z.jsonl").trim().split("\n")
)
const scoreboardBody = fixture("nfl-scoreboard-2026-10-04T1800Z.json")
const playEntities = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)))
)(fixture("nfl-plays-2026-10-04.json"))
// Recorded from ESPN on 2026-10-04 on BUF at NE's game topic: the two plays its messages 819–822 patch, as they stood
// after message 818, and those messages as the recorder kept them. Message 819 opens with a `move` outside the plays.
const moveRecording = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      checkpoint: Schema.Struct({ mid: Schema.Int, body: Schema.Json }),
      messages: Schema.Array(
        Schema.Struct({
          op: Schema.String,
          tc: Schema.String,
          mid: Schema.Int,
          ts: Schema.Finite,
          pl: Schema.String
        })
      )
    })
  )
)(fixture("nfl-gp-move-2026-10-04.json"))

const snapshotJson = Schema.fromJsonString(GameSnapshot)
const playJson = Schema.fromJsonString(Play)

const ariAtNyg = "s:20~l:28~e:401872966~c:401872966"
const neAtBuf = "s:20~l:28~e:401872971~c:401872971"
const ariAtNygPlays = "gp-football-nfl-401872966"

// NE at BUF's recorded frames, decoded by ESPN's decode once, by the first test that reads them.
const neAtBufDecoded = Effect.runSync(Effect.cached(Effect.flatMap(recordedNeAtBuf, decodedFrames)))

describe("EspnState#take", () => {
  // Each recorded feed as it decoded when both feeds' events were read by one transform: the poll's listings, the
  // checkpoint's pushes, and the checkpoint's events each read alone.
  describe("the recorded feeds decode to the same games", () => {
    const expected = Schema.decodeSync(
      Schema.fromJsonString(Schema.Struct({ deliveries: Schema.Json, checkpointEvents: Schema.Json }))
    )(fixture("decoded-snapshots.json"))
    const encoded = (value: unknown) => JSON.parse(JSON.stringify(value))
    const encode = Schema.encodeSync(GameSnapshot)

    it.effect("should decode each listing and push", () =>
      Effect.gen(function* () {
        const checkpointDocument = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
          checkpointBody
        )
        const frames = [
          poll("fbs", fixture("fbs-scoreboard-live.json")),
          poll("nfl", scoreboardBody),
          checkpoint("event-football-nfl", 1, checkpointDocument)
        ]

        const all = yield* decoded(frames)

        assert.deepStrictEqual(
          encoded(
            all.map((output) =>
              Delivery.$is("Listing")(output.delivery)
                ? {
                    frame: output.frame,
                    tag: "Listing",
                    league: output.delivery.league,
                    games: output.delivery.games.map((game) => encode(game))
                  }
                : Delivery.$is("Snapshot")(output.delivery)
                  ? {
                      frame: output.frame,
                      tag: "Snapshot",
                      snapshot: encode(output.delivery.snapshot)
                    }
                  : { frame: output.frame, tag: output.delivery._tag }
            )
          ),
          expected.deliveries
        )
      })
    )

    it("should decode each checkpoint event alone", () => {
      const events = checkpointEvents()
      const decodeEvent = Schema.decodeUnknownSync(EspnEvent("nfl"))

      const games = events.map((event) => encode(decodeEvent(event)))

      assert.deepStrictEqual(encoded(games), expected.checkpointEvents)
    })
  })

  it.effect("should read a poll response as its league's listing", () =>
    Effect.gen(function* () {
      const [listing] = yield* decoded([poll("nfl", scoreboardBody)])

      assert.strictEqual(listing?.frame, 1)
      assert.strictEqual(listing?.delivery._tag, "Listing")
      assert.strictEqual(
        listing !== undefined && Delivery.$is("Listing")(listing.delivery)
          ? listing.delivery.games.length
          : 0,
        16
      )
    })
  )

  it.effect("should push a snapshot of every listed game on a checkpoint, advanced to its listed game", () =>
    Effect.gen(function* () {
      const deliveries = yield* decoded(synced())

      const pushed = deliveries.flatMap(({ delivery }) =>
        Delivery.$is("Snapshot")(delivery) ? [delivery] : []
      )
      // FastCast has no short names: each pushed game keeps its listed game's.
      const nyg = pushed.find((delivery) => delivery.snapshot.id === "401872966")?.snapshot
      assert.strictEqual(pushed.length, 16)
      assert.strictEqual(nyg?.home.team.shortName, "Giants")
    })
  )

  it("should carry a checkpoint event's teams' colors", () => {
    const events = checkpointEvents()
    const decodeEvent = Schema.decodeUnknownSync(EspnEvent("nfl"))

    const games = events.map((event) => decodeEvent(event))

    const ari = games.find((game) => game.id === "401872966")?.away.team
    assert.strictEqual(ari?.color, "a40227")
    assert.strictEqual(ari?.alternateColor, "ffffff")
  })

  it.effect(
    "should end each live game where the scoreboard had it, after the checkpoint and every message",
    () =>
      Effect.gen(function* () {
        const listings = yield* decoded([poll("nfl", scoreboardBody)])
        const polled = listings.flatMap(({ delivery }) =>
          Delivery.$is("Listing")(delivery) ? delivery.games : []
        )
        const live = polled.filter((game) => game.progress() === "live")

        const all = yield* decoded([poll("nfl", scoreboardBody), ...recorded(socketTexts)])

        const pushed = lastPushed(all)
        assert.strictEqual(live.length, 8)
        assert.deepStrictEqual(
          live.map((game) => [game.matchup(), inPlay(pushed.get(game.id))]),
          live.map((game) => [game.matchup(), inPlay(game)])
        )
      })
  )

  it.effect(
    "should orient the yard line for the team with the ball, keeping possession where the scoreboard drops it",
    () =>
      Effect.gen(function* () {
        const all = yield* decoded([poll("nfl", scoreboardBody), ...recorded(socketTexts)])

        const pushed = lastPushed(all)
        assert.strictEqual(pushed.get("401872971")?.situation?.possession, "nfl:2")
        assert.strictEqual(pushed.get("401872971")?.situation?.yardLine, 58)
        assert.strictEqual(pushed.get("401872968")?.situation?.possession, "nfl:27")
      })
  )

  it.effect("should deliver no pushed game a listing lacks", () =>
    Effect.gen(function* () {
      const deliveries = yield* decoded(recorded(socketTexts.slice(0, 3)))

      assert.deepStrictEqual(deliveries, [])
    })
  )

  it.effect("should add the value read at a copy's source", () =>
    Effect.gen(function* () {
      // ARI at NYG: the away team (competitor 0) had 14, the home team 6.
      const copy = message("event-football-nfl", 4286638, [
        { op: "copy", from: `${ariAtNyg}/competitors/1/score`, path: `${ariAtNyg}/competitors/0/score` }
      ])

      const deliveries = yield* decoded([...synced(), copy])

      assert.deepStrictEqual(
        deliveries
          .filter(({ frame }) => frame === 6)
          .flatMap(({ delivery }) =>
            Delivery.$is("Snapshot")(delivery)
              ? [[delivery.snapshot.id, delivery.snapshot.away.score, delivery.snapshot.home.score]]
              : []
          ),
        [["401872966", 6, 6]]
      )
    })
  )

  it.effect("should send only the topic that missed a message back to waiting for a checkpoint", () =>
    Effect.gen(function* () {
      const skipped = [...socketTexts.slice(0, 20), ...socketTexts.slice(21)]
      const frames = [poll("nfl", scoreboardBody), ...recorded(skipped), poll("nfl", scoreboardBody)]

      const deliveries = yield* decoded(frames)

      // Frames 2–5 are C, S, H, and its checkpoint, so text 21, the first after the gap, is frame 23.
      const snapshotFrames = deliveries.flatMap(({ frame, delivery }) =>
        Delivery.$is("Snapshot")(delivery) ? [frame] : []
      )
      const reset = yield* resetTopics(frames)
      assert.deepStrictEqual(reset, ["event-football-nfl"])
      assert.isNotEmpty(snapshotFrames)
      assert.isTrue(snapshotFrames.every((frame) => frame < 23))
      assert.strictEqual(deliveries.at(-1)?.delivery._tag, "Listing", "the scoreboard poll still decodes")
    })
  )

  it.effect("should give nothing and fail nothing for a patch or an idle message before any checkpoint", () =>
    Effect.gen(function* () {
      const deliveries = yield* decoded([poll("nfl", scoreboardBody), ...beforeAnyCheckpoint()])

      assert.deepStrictEqual(tags(deliveries), ["Listing"])
    })
  )

  it.effect("should send a topic back to waiting for a checkpoint when a patch will not apply", () =>
    Effect.gen(function* () {
      const copyFromNothing = message("event-football-nfl", 4286639, [
        { op: "copy", from: `${ariAtNyg}/competitors/5/score`, path: `${ariAtNyg}/competitors/0/score` }
      ])
      const frames = [...synced(), unapplicablePatch(4286638), copyFromNothing]

      const deliveries = yield* decoded(frames)

      const reset = yield* resetTopics(frames)
      assert.deepStrictEqual(
        deliveries.filter(({ frame }) => frame > 5),
        []
      )
      assert.deepStrictEqual(reset, ["event-football-nfl"])
    })
  )

  it.effect("should change nothing when removing a whole event the document does not have", () =>
    Effect.gen(function* () {
      const removed = message("event-football-nfl", 4286638, [{ op: "remove", path: "s:20~l:28~e:1~c:1" }])

      const frames = [...synced(), removed, scoreReplaced(4286639)]

      const deliveries = yield* decoded(frames)

      const reset = yield* resetTopics(frames)
      assert.deepStrictEqual(
        deliveries.filter(({ frame }) => frame > 5).map(({ frame, delivery }) => [frame, delivery._tag]),
        [[7, "Snapshot"]]
      )
      assert.deepStrictEqual(reset, [])
    })
  )

  it.effect("should reset a synced topic on a message that does not decode", () =>
    Effect.gen(function* () {
      const frames = [...synced(), undecodablePatch(4286638), scoreReplaced(4286639)]

      const deliveries = yield* decoded(frames)

      const reset = yield* resetTopics(frames)
      assert.deepStrictEqual(
        deliveries.filter(({ frame }) => frame > 5),
        [],
        "the topic waits for its next checkpoint"
      )
      assert.deepStrictEqual(reset, ["event-football-nfl"])
    })
  )

  it.effect("should log a topic that lost its document at Warning, with why and its topic", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()

      yield* stateAfter([...synced(), unapplicablePatch(4286638)]).pipe(Effect.provide(layer))

      const lost = logs.filter(({ message }) => message.includes("event-football-nfl lost its document"))
      assert.lengthOf(lost, 1)
      assert.strictEqual(lost[0]?.level, "Warn")
      assert.strictEqual(lost[0]?.annotations.topic, "event-football-nfl")
    })
  )

  it.effect.each([
    {
      reset: "a gap",
      frames: () => [...synced(), ...recorded(socketTexts.slice(4, 6))],
      expected: ["event-football-nfl"]
    },
    {
      reset: "a patch that will not apply",
      frames: () => [...synced(), unapplicablePatch(4286638), scoreReplaced(4286639)],
      expected: ["event-football-nfl"]
    },
    {
      reset: "a message that does not decode",
      frames: () => [...synced(), undecodablePatch(4286638)],
      expected: ["event-football-nfl"]
    },
    {
      reset: "a gap on a game's topic",
      frames: () => [
        checkpoint(ariAtNygPlays, 99, { entities: {} }),
        playsMessage(101, [{ op: "add", path: "/entities/plays", value: plays("401872966237") }])
      ],
      expected: [ariAtNygPlays]
    }
  ])("should reset a topic's document, once, after $reset", ({ frames, expected }) =>
    Effect.gen(function* () {
      const reset = yield* resetTopics(frames())

      assert.deepStrictEqual(reset, expected)
    })
  )

  it.effect("should reset no topic that was never synced", () =>
    Effect.gen(function* () {
      const reset = yield* resetTopics([poll("nfl", scoreboardBody), ...beforeAnyCheckpoint()])

      assert.deepStrictEqual(reset, [])
    })
  )

  it.effect("should leave a topic waiting on a checkpoint that does not decode, with no reset", () =>
    Effect.gen(function* () {
      const unreadable = [
        poll("nfl", scoreboardBody),
        checkpoint("event-football-nfl", 7, { sports: "not a scoreboard" }),
        scoreReplaced(8)
      ]

      const deliveries = yield* decoded(unreadable)

      const reset = yield* resetTopics(unreadable)
      assert.deepStrictEqual(reset, [])
      assert.deepStrictEqual(
        deliveries.map(({ frame }) => frame),
        [1],
        "the message after it is not applied"
      )
    })
  )

  it.effect("should sync a waiting topic on the next checkpoint that decodes", () =>
    Effect.gen(function* () {
      const frames = [
        poll("nfl", scoreboardBody),
        checkpoint("event-football-nfl", 7, { sports: "not a scoreboard" }),
        checkpoint("event-football-nfl", 4286637, JSON.parse(checkpointBody)),
        // ARI at NYG: the away team (competitor 0) had 14, the home team 6.
        message("event-football-nfl", 4286638, [
          { op: "copy", from: `${ariAtNyg}/competitors/1/score`, path: `${ariAtNyg}/competitors/0/score` }
        ])
      ]

      const deliveries = yield* decoded(frames)

      const reset = yield* resetTopics(frames)
      assert.deepStrictEqual(
        deliveries.flatMap(({ frame, delivery }) =>
          frame === 4 && Delivery.$is("Snapshot")(delivery)
            ? [[delivery.snapshot.id, delivery.snapshot.away.score]]
            : []
        ),
        [["401872966", 6]]
      )
      assert.deepStrictEqual(reset, [])
    })
  )

  it.effect("should count a push behind its listed game by its league", () =>
    Effect.gen(function* () {
      yield* decodedFrames(synced())

      const count = yield* counted("sportal_push_behind_listing", { league: "nfl" })
      assert.strictEqual(count, 8)
    }).pipe(withMetrics)
  )

  it.effect("should log a push behind its listed game at Info, with its game", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()

      yield* decodedFrames(synced()).pipe(Effect.provide(layer))

      const behind = logs.filter(({ message }) => message.includes("a push is behind its listed game"))
      assert.deepStrictEqual(
        behind.map(({ level, annotations }) => [level, typeof annotations.game]),
        Array.from({ length: 8 }, () => ["Info", "string"])
      )
    })
  )

  it.effect("should count no push that moves its listed game forward", () =>
    Effect.gen(function* () {
      yield* decodedFrames([...synced(), scoreReplaced(4286638)])

      const count = yield* counted("sportal_push_behind_listing", { league: "nfl" })
      assert.strictEqual(count, 8)
    }).pipe(withMetrics)
  )

  it.effect("should touch no metric but the count of pushes behind their listed game", () =>
    Effect.gen(function* () {
      const unknownType = { ...playEntities["40187297063"], type: { id: "999", text: "Something New" } }
      const brokenPlay = { ...Record.remove(playEntities["401872966237"] ?? {}, "statYardage"), id: "1" }
      const skipped = [...socketTexts.slice(0, 20), ...socketTexts.slice(21)]
      const frames = [
        poll("nfl", "not json"),
        poll("nfl", JSON.stringify({ events: [{ id: "broken" }] })),
        ...recorded(socketTexts.slice(0, 3)),
        poll("nfl", scoreboardBody),
        ...recorded(skipped.slice(3)),
        checkpoint(ariAtNygPlays, 99, {
          entities: { plays: { "40187297063": unknownType, "1": brokenPlay } }
        })
      ]

      yield* decodedFrames(frames)

      const metrics = yield* Metric.snapshot
      assert.deepStrictEqual(
        metrics.map(({ id }) => id),
        ["sportal_push_behind_listing"]
      )
    }).pipe(withMetrics)
  )

  it.effect("should skip an event that does not decode, and list the rest", () =>
    Effect.gen(function* () {
      const { events } = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ events: Schema.Array(Schema.Json) }))
      )(scoreboardBody)
      const withBroken = JSON.stringify({ events: [{ id: "broken" }, ...events] })

      const deliveries = yield* decoded([poll("nfl", withBroken)])

      const [listing] = deliveries
      assert.strictEqual(
        listing !== undefined && Delivery.$is("Listing")(listing.delivery)
          ? listing.delivery.games.length
          : 0,
        events.length
      )
    })
  )

  it.effect("should skip a frame that does not decode, and decode the next", () =>
    Effect.gen(function* () {
      const deliveries = yield* decoded([poll("nfl", "not json"), poll("nfl", scoreboardBody)])

      assert.deepStrictEqual(
        deliveries.map(({ frame }) => frame),
        [2]
      )
    })
  )

  it.effect("should log a frame that does not decode at Warning, with its kind and league", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()

      yield* decodedFrames([poll("nfl", "not json"), poll("nfl", scoreboardBody)]).pipe(Effect.provide(layer))

      assert.deepStrictEqual(
        logs.map(({ level, annotations }) => [level, annotations]),
        [["Warn", { frame: "Polled", league: "nfl" }]]
      )
    })
  )

  it.effect("should move a listed game forward in its listing on a push", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([...synced(), scoreReplaced(4286638)])

      const ari = state.games().find((game) => game.id === "401872966")
      assert.strictEqual(ari?.away.score, 17)
    })
  )

  it.effect("should keep a pushed game's progress over a poll that lags it", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([...synced(), neAtBufFinal(4286638), poll("nfl", scoreboardBody)])

      const game = state.games().find((each) => each.id === "401872971")
      assert.strictEqual(game?.progress(), "over")
    })
  )

  it.effect("should deliver a poll's own games in its listing, whatever a push moved forward", () =>
    Effect.gen(function* () {
      const deliveries = yield* decoded([...synced(), neAtBufFinal(4286638), poll("nfl", scoreboardBody)])

      const relisted = deliveries.at(-1)?.delivery
      const game =
        relisted !== undefined && Delivery.$is("Listing")(relisted)
          ? relisted.games.find((each) => each.id === "401872971")
          : undefined
      assert.strictEqual(game?.progress(), "live")
    })
  )

  describe("a game's plays", () => {
    it.effect(
      "should give the game's whole list, in sequence order, on a checkpoint and an add of plays",
      () =>
        Effect.gen(function* () {
          const deliveries = yield* decoded([
            checkpoint(ariAtNygPlays, 99, { entities: {} }),
            playsMessage(100, [
              {
                op: "add",
                path: "/entities/plays",
                value: plays("401872966237", "401872966271", "40187297063")
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

    it.effect("should give the new list on each replaced text, removed play, and copy within the plays", () =>
      Effect.gen(function* () {
        const deliveries = yield* decoded([
          checkpoint(ariAtNygPlays, 99, { entities: { plays: plays("401872966237", "401872966271") } }),
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
          checkpoint(ariAtNygPlays, 99, { entities: { plays: plays("401872966237", "401872966271") } }),
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
          const frames = moveRecordingFrames()

          const deliveries = yield* decoded(frames)

          const reset = yield* resetTopics(frames)
          const penalty =
            deliveries[1] !== undefined && Delivery.$is("Plays")(deliveries[1].delivery)
              ? deliveries[1].delivery.plays.find((play) => play.id === "401872971792")?.text
              : undefined
          assert.isTrue(
            moveRecording.messages[0]?.pl.includes('"op":"move"'),
            "the first recorded message has a move"
          )
          assert.deepStrictEqual(
            deliveries.map(({ frame }) => frame),
            [1, 2, 5],
            "the checkpoint, message 819, and message 822 change the plays"
          )
          assert.include(penalty, "PENALTY on BUF-C.McGovern")
          assert.include(deliveries.map(playIds).at(-1) ?? [], PlayId.make("4018729711662"))
          assert.deepStrictEqual(reset, [])
        })
    )

    it.effect("should leave out a play that does not decode, and deliver the rest", () =>
      Effect.gen(function* () {
        const broken = {
          ...Record.remove(playEntities["401872966237"] ?? {}, "statYardage"),
          id: "401872966999"
        }
        const frames = [
          checkpoint(ariAtNygPlays, 99, {
            entities: { plays: { ...plays("401872966237", "401872966271"), "401872966999": broken } }
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
          checkpoint(ariAtNygPlays, 99, { entities: {} }),
          playsMessage(100, [
            { op: "replace", path: "/boxscore/teams/0/statistics/0/displayValue", value: "12" }
          ]),
          playsMessage(101, [{ op: "add", path: "/entities/plays", value: plays("40187297063") }])
        ]

        const deliveries = yield* decoded(frames)

        const reset = yield* resetTopics(frames)
        assert.deepStrictEqual(deliveries.map(playIds), [[], ["40187297063"]])
        assert.deepStrictEqual(reset, [])
      })
    )

    it.effect("should keep the other games and the scoreboard decoding after a gap on one game's topic", () =>
      Effect.gen(function* () {
        const other = "gp-football-nfl-401872971"
        const frames = [
          ...synced(),
          checkpoint(ariAtNygPlays, 99, { entities: {} }),
          checkpoint(other, 99, { entities: {} }),
          playsMessage(101, [{ op: "add", path: "/entities/plays", value: plays("401872966237") }]),
          playsMessage(100, [{ op: "add", path: "/entities/plays", value: plays("401872971330") }], other),
          scoreReplaced(4286638)
        ]

        const deliveries = yield* decoded(frames)

        const reset = yield* resetTopics(frames)
        const after = deliveries.filter(({ frame }) => frame > 7)
        assert.deepStrictEqual(
          after.map(({ delivery }) => delivery._tag),
          ["Plays", "Snapshot"]
        )
        assert.deepStrictEqual(after.map(playIds)[0], ["401872971330"])
        assert.deepStrictEqual(reset, [ariAtNygPlays])
      })
    )
  })

  describe("one array of deliveries per frame", () => {
    it.effect("should give a message that changes no document no deliveries", () =>
      Effect.gen(function* () {
        const [only, ...rest] = yield* decodedFrames([
          message("event-football-nfl", 1, [{ op: "replace", path: "/x", value: "1" }])
        ])

        assert.deepStrictEqual(rest, [])
        assert.deepStrictEqual(only, [])
      })
    )

    it.effect("should give a poll that does not decode no deliveries", () =>
      Effect.gen(function* () {
        const all = yield* decodedFrames([poll("nfl", "not json")])

        assert.strictEqual(all.length, 1)
        assert.deepStrictEqual(all[0], [])
      })
    )

    it.effect("should give a scoreboard checkpoint each pushed game's Snapshot", () =>
      Effect.gen(function* () {
        const all = yield* decodedFrames(synced())

        const pushing = all.at(-1)
        assert.strictEqual(pushing?.length, 16)
        assert.isTrue(pushing?.every((delivery) => Delivery.$is("Snapshot")(delivery)))
      })
    )

    it.effect("should give a frame that resets its topic no deliveries", () =>
      Effect.gen(function* () {
        const frames = [...synced(), undecodablePatch(4286638)]

        const all = yield* decodedFrames(frames)

        assert.strictEqual(all.length, frames.length)
        assert.deepStrictEqual(all.at(-1), [])
      })
    )

    it.effect("should give one array of deliveries per frame", () =>
      Effect.gen(function* () {
        const frames = [poll("nfl", scoreboardBody), poll("nfl", "not json"), ...recorded(socketTexts)]

        const all = yield* decodedFrames(frames)

        assert.strictEqual(all.length, frames.length)
      })
    )
  })

  // Decoding NE at BUF's whole recorded day takes seconds alone, and many under a full suite's load: whichever test
  // runs first decodes it, so each has a timeout to match.
  describe("the recorded NE at BUF day", () => {
    it.effect(
      "should decode every snapshot so it reads back from its JSON Equal to itself",
      () =>
        Effect.gen(function* () {
          const decoded = yield* neAtBufDecoded
          const deliveries = decoded.flat()
          const snapshots = deliveries.flatMap((delivery) =>
            Delivery.$is("Listing")(delivery)
              ? delivery.games
              : Delivery.$is("Snapshot")(delivery)
                ? [delivery.snapshot]
                : []
          )

          const backs = yield* Effect.forEach(snapshots, (snapshot) =>
            Schema.encodeEffect(snapshotJson)(snapshot).pipe(
              Effect.flatMap(Schema.decodeEffect(snapshotJson))
            )
          )

          assert.isNotEmpty(snapshots)
          for (const [index, snapshot] of snapshots.entries()) {
            assert.isTrue(Equal.equals(backs[index], snapshot), snapshot.id)
          }
        }),
      { timeout: 60_000 }
    )

    it.effect(
      "should decode every play so it reads back from its JSON Equal to itself",
      () =>
        Effect.gen(function* () {
          const decoded = yield* neAtBufDecoded
          const deliveries = decoded.flat()
          const plays = deliveries.flatMap((delivery) =>
            Delivery.$is("Plays")(delivery) ? delivery.plays : []
          )

          const backs = yield* Effect.forEach(plays, (play) =>
            Schema.encodeEffect(playJson)(play).pipe(Effect.flatMap(Schema.decodeEffect(playJson)))
          )

          assert.isNotEmpty(plays)
          for (const [index, play] of plays.entries()) {
            assert.isTrue(Equal.equals(backs[index], play), play.id)
          }
        }),
      // Round-tripping every recorded play through JSON takes about 5 s more under coverage.
      { timeout: 60_000 }
    )
  })
})

describe("EspnState#wanted", () => {
  const nfl = ["nfl"] as const
  const scoreboard = Topic.Scoreboard({ league: "nfl" })
  const gameTopic = (id: string) => Topic.Game({ league: "nfl", game: GameId.make(id) })
  const at = (iso: string) => DateTime.makeUnsafe(iso)

  it("should want each league's scoreboard topic, waiting for its checkpoint, before any frame", () => {
    const wanted = EspnState.empty.wanted(["nfl", "fbs"], at("2026-10-04T18:00:00Z"))

    assert.strictEqual(HashMap.size(wanted), 2)
    assert.deepStrictEqual(HashMap.get(wanted, scoreboard), Option.some("AwaitingCheckpoint"))
    assert.deepStrictEqual(
      HashMap.get(wanted, Topic.Scoreboard({ league: "fbs" })),
      Option.some("AwaitingCheckpoint")
    )
  })

  it.effect("should want a listed game's topic while it is live", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([poll("nfl", scoreboardBody)])

      const wanted = state.wanted(nfl, at("2026-10-04T18:00:00Z"))

      assert.isTrue(HashMap.has(wanted, gameTopic("401872971")))
    })
  )

  it.effect("should want a listed game's topic from 30 minutes before its kickoff", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([poll("nfl", scoreboardBody)])

      const wanted = state.wanted(nfl, at("2026-10-04T19:35:00Z"))

      assert.isTrue(HashMap.has(wanted, gameTopic("401872974")))
    })
  )

  it.effect("should not want a listed game's topic a second before 30 minutes before its kickoff", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([poll("nfl", scoreboardBody)])

      const wanted = state.wanted(nfl, at("2026-10-04T19:34:59Z"))

      assert.isFalse(HashMap.has(wanted, gameTopic("401872974")))
    })
  )

  it.effect("should not want the topic of a game a push shows over", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([...synced(), neAtBufFinal(4286638)])

      const wanted = state.wanted(nfl, at("2026-10-04T18:00:00Z"))

      assert.isFalse(HashMap.has(wanted, gameTopic("401872971")))
    })
  )

  it.effect("should want no game's topic a push shows before any poll lists it", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter(recorded(socketTexts.slice(0, 3)))

      const wanted = state.wanted(nfl, at("2026-10-04T18:00:00Z"))

      assert.deepStrictEqual([...HashMap.keys(wanted)], [scoreboard])
    })
  )

  it.effect("should show a synced topic as Synced", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter(synced())

      const wanted = state.wanted(nfl, at("2026-10-04T18:00:00Z"))

      assert.deepStrictEqual(HashMap.get(wanted, scoreboard), Option.some("Synced"))
    })
  )

  it.effect("should show a topic that lost its document as waiting for its checkpoint", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([...synced(), unapplicablePatch(4286638)])

      const wanted = state.wanted(nfl, at("2026-10-04T18:00:00Z"))

      assert.deepStrictEqual(HashMap.get(wanted, scoreboard), Option.some("AwaitingCheckpoint"))
    })
  )
})

/** The deliveries `frames` decode to, each with the place, from 1, of the frame that said it. */
function decoded(frames: ReadonlyArray<Frame>) {
  return decodedFrames(frames).pipe(
    Effect.map((all) =>
      all.flatMap((deliveries, index) => deliveries.map((delivery) => ({ frame: index + 1, delivery })))
    )
  )
}

/** The topics whose document went from synced back to waiting for a checkpoint over `frames`, in order. */
function resetTopics(frames: ReadonlyArray<Frame>) {
  return Effect.reduce(
    frames,
    (): { readonly state: EspnState; readonly topics: ReadonlyArray<string> } => ({
      state: EspnState.empty,
      topics: []
    }),
    ({ state, topics }, frame) =>
      Effect.map(state.take(frame), ([next]) => ({
        state: next,
        topics: [...topics, ...lostBetween(state, next)]
      }))
  ).pipe(Effect.map(({ topics }) => topics))
}

/** Each topic synced in `before` that is not in `after`, by name. */
function lostBetween(before: EspnState, after: EspnState): ReadonlyArray<string> {
  return [...HashMap.keys(before.documents.byTopic)]
    .filter((topic) => before.documents.isSynced(topic) && !after.documents.isSynced(topic))
    .map(tcOf)
}

function poll(league: LeagueId, body: string): Frame {
  return Frame.Polled({ league, body })
}

function checkpoint(tc: string, mid: number, document: unknown): Frame {
  return Frame.Checkpoint({ topic: topicNamed(tc), mid, body: JSON.stringify(document) })
}

/** A `P` on `tc`, its patches sent as an array, one of the three ways FastCast spells them. */
function message(tc: string, mid: number, patches: ReadonlyArray<object>): Frame {
  const pl = JSON.stringify({ ts: 1791136341731, pl: patches })
  return Frame.Pushed({
    topic: topicOf(tc),
    mid: Option.some(mid),
    body: JSON.stringify({ op: "P", tc, mid, pl })
  })
}

/** The topic `tc` names; a test names only real ones. */
function topicNamed(tc: string): Topic {
  return Option.getOrThrow(topicOf(tc))
}

function playsMessage(mid: number, patches: ReadonlyArray<object>, channel = ariAtNygPlays) {
  return message(channel, mid, patches)
}

function plays(...ids: ReadonlyArray<string>) {
  return Object.fromEntries(ids.map((id) => [id, playEntities[id] ?? {}]))
}

/** The recorded socket texts as FastCast frames them, each `H` followed by the recorded checkpoint. */
function recorded(texts: ReadonlyArray<string>): ReadonlyArray<Frame> {
  return texts.flatMap((body) => {
    const { message, channel, mid } = decodeEnvelope(body)
    const topic = Option.flatMap(Option.fromUndefinedOr(channel), topicOf)
    const frame = Frame.Pushed({ topic, mid: Option.fromUndefinedOr(mid), body })
    return message.op === "H" && Option.isSome(topic) && mid !== undefined
      ? [frame, Frame.Checkpoint({ topic: topic.value, mid, body: checkpointBody })]
      : [frame]
  })
}

const decodeEnvelope = Schema.decodeUnknownSync(FastCastMessage.Envelope)

// Each game as the last pushed snapshot of it.
function lastPushed(deliveries: ReadonlyArray<{ readonly delivery: Delivery }>) {
  return new Map<string, GameSnapshot>(
    deliveries.flatMap(({ delivery }) =>
      Delivery.$is("Snapshot")(delivery) ? [[delivery.snapshot.id, delivery.snapshot] as const] : []
    )
  )
}

function inPlay(game: GameSnapshot | undefined) {
  return {
    status: game?.status,
    period: game?.period,
    clock: game?.clock,
    home: game?.home.score,
    away: game?.away.score,
    down: game?.situation?.down,
    distance: game?.situation?.distance,
    homeTimeouts: game?.situation?.homeTimeouts,
    awayTimeouts: game?.situation?.awayTimeouts,
    lastPlay: game?.situation?.lastPlay
  }
}

function tags(deliveries: ReadonlyArray<{ readonly delivery: Delivery }>) {
  return deliveries.map(({ delivery }) => delivery._tag)
}

function playIds({ delivery }: { readonly delivery: Delivery }) {
  return Delivery.$is("Plays")(delivery) ? delivery.plays.map((play) => play.id) : []
}

/** The NFL listed, then FastCast's C, S, H, and the H's checkpoint: frames 1 to 5, the scoreboard topic synced. */
function synced(): ReadonlyArray<Frame> {
  return [poll("nfl", scoreboardBody), ...recorded(socketTexts.slice(0, 3))]
}

/** FastCast's C and S, then a patch and an idle message before any checkpoint. */
function beforeAnyCheckpoint(): ReadonlyArray<Frame> {
  return recorded([...socketTexts.slice(0, 2), socketTexts[3] ?? "", socketTexts[6] ?? ""])
}

/** NE at BUF over at the end of the fourth quarter, past the 18:00Z poll, which has it live in the second. */
function neAtBufFinal(mid: number) {
  return message("event-football-nfl", mid, [
    { op: "replace", path: `${neAtBuf}/fullStatus/type/state`, value: "post" },
    { op: "replace", path: `${neAtBuf}/fullStatus/period`, value: 4 },
    { op: "replace", path: `${neAtBuf}/fullStatus/displayClock`, value: "0:00" }
  ])
}

/** A patch on the scoreboard topic that sets ARI's score at NYG to 17. */
function scoreReplaced(mid: number) {
  return message("event-football-nfl", mid, [
    { op: "replace", path: `${ariAtNyg}/competitors/0/score`, value: "17" }
  ])
}

/** A patch on the scoreboard topic that will not apply: ARI at NYG has no sixth competitor. */
function unapplicablePatch(mid: number) {
  return message("event-football-nfl", mid, [
    { op: "replace", path: `${ariAtNyg}/competitors/5/score`, value: "21" }
  ])
}

/** A message on the scoreboard topic that does not decode: FastCast sends no `test` op. */
function undecodablePatch(mid: number) {
  return message("event-football-nfl", mid, [{ op: "test", path: `${ariAtNyg}/clock`, value: "1:00" }])
}

/** The events of the recorded NFL checkpoint, each as ESPN sent it. */
function checkpointEvents() {
  return Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Struct({
        sports: Schema.Tuple([
          Schema.Struct({
            leagues: Schema.Tuple([Schema.Struct({ events: Schema.Array(Schema.Unknown) })])
          })
        ])
      })
    )
  )(checkpointBody).sports[0].leagues[0].events
}

/** BUF at NE's recorded checkpoint and the messages after it, as FastCast frames. */
function moveRecordingFrames(): ReadonlyArray<Frame> {
  const game = "gp-football-nfl-401872971"
  const messages = moveRecording.messages.map(
    ({ op, tc, mid, ts, pl }): Frame =>
      Frame.Pushed({
        topic: topicOf(tc),
        mid: Option.some(mid),
        body: JSON.stringify({ op, tc, mid, pl: JSON.stringify({ ts, pl }) })
      })
  )
  return [checkpoint(game, moveRecording.checkpoint.mid, moveRecording.checkpoint.body), ...messages]
}
