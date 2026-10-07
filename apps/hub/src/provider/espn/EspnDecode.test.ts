import { readFileSync } from "node:fs"
import { assert, describe, layer } from "@effect/vitest"
import type { Delivery } from "@sportal/domain/Delivery"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { Play, PlayId } from "@sportal/domain/Play"
import { type Data, DateTime, Effect, Equal, Layer, Metric, Option, Record, Schema } from "effect"
import type { FeedFrame } from "../../Frame.ts"
import { recordingLogs, withMetrics } from "../../TestTelemetry.ts"
import type { DecodeObservation } from "../Provider.ts"
import { decodedFrames, FramesDecoded } from "../TestDecoder.ts"
import * as EspnDecode from "./EspnDecode.ts"
import { EspnEvent } from "./EspnEvent.ts"
import { recordedNeAtBuf } from "./TestEspn.ts"

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
const ariAtNygPlays = "gp-football-nfl-401872966"

// NE at BUF's recorded frames, decoded once by ESPN's decode for the tests that read them.
const neAtBufDecoded = FramesDecoded.layer(recordedNeAtBuf).pipe(Layer.provide(EspnDecode.layer))

layer(EspnDecode.layer)("EspnDecode", (it) => {
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
              output.delivery._tag === "Listing"
                ? {
                    seq: output.seq,
                    tag: "Listing",
                    league: output.delivery.league,
                    games: output.delivery.games.map((game) => encode(game))
                  }
                : output.delivery._tag === "Snapshot"
                  ? {
                      seq: output.seq,
                      tag: "Snapshot",
                      from: output.delivery.from,
                      snapshot: encode(output.delivery.snapshot)
                    }
                  : { seq: output.seq, tag: output.delivery._tag }
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

      assert.strictEqual(listing?.seq, 1)
      assert.strictEqual(listing?.delivery._tag, "Listing")
      assert.strictEqual(listing?.delivery._tag === "Listing" ? listing.delivery.games.length : 0, 16)
    })
  )

  it.effect("should push a snapshot of every listed game on a checkpoint, advanced to its listed game", () =>
    Effect.gen(function* () {
      const deliveries = yield* decoded(synced())

      const pushed = deliveries.flatMap(({ delivery }) => (delivery._tag === "Snapshot" ? [delivery] : []))
      // FastCast has no short names: each pushed game keeps its listed game's.
      const nyg = pushed.find((delivery) => delivery.snapshot.id === "401872966")?.snapshot
      assert.strictEqual(pushed.length, 16)
      assert.isTrue(pushed.every((delivery) => delivery.from === "push"))
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
        const polled = listings.flatMap(({ delivery }) => (delivery._tag === "Listing" ? delivery.games : []))
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

  it.effect("should deliver no pushed game a listing lacks, noting each Unlisted", () =>
    Effect.gen(function* () {
      const { deliveries, noted } = yield* said(recorded(socketTexts.slice(0, 3)))

      assert.deepStrictEqual(deliveries, [])
      assert.strictEqual(count(noted, "Unlisted", { league: "nfl" }), 16)
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
          .filter(({ seq }) => seq === 6)
          .flatMap(({ delivery }) =>
            delivery._tag === "Snapshot"
              ? [[delivery.snapshot.id, delivery.snapshot.away.score, delivery.snapshot.home.score]]
              : []
          ),
        [["401872966", 6, 6]]
      )
    })
  )

  it.effect(
    "should send only the topic that missed a message back to waiting for a checkpoint, noting a Reset Gap",
    () =>
      Effect.gen(function* () {
        const skipped = [...socketTexts.slice(0, 20), ...socketTexts.slice(21)]

        const { deliveries, noted } = yield* said([
          poll("nfl", scoreboardBody),
          ...recorded(skipped),
          poll("nfl", scoreboardBody)
        ])

        // Frames 2–5 are C, S, H, and its checkpoint, so text 21, the first after the gap, is frame 23.
        const snapshotSeqs = deliveries.flatMap(({ seq, delivery }) =>
          delivery._tag === "Snapshot" ? [seq] : []
        )
        assert.strictEqual(count(noted, "Reset", { league: "nfl", reason: "Gap" }), 1)
        assert.isNotEmpty(snapshotSeqs)
        assert.isTrue(snapshotSeqs.every((seq) => seq < 23))
        assert.strictEqual(deliveries.at(-1)?.delivery._tag, "Listing", "the scoreboard poll still decodes")
      })
  )

  it.effect("should give nothing and fail nothing for a patch or an idle message before any checkpoint", () =>
    Effect.gen(function* () {
      const deliveries = yield* decoded([poll("nfl", scoreboardBody), ...beforeAnyCheckpoint()])

      assert.deepStrictEqual(tags(deliveries), ["Listing"])
    })
  )

  it.effect(
    "should send a topic back to waiting for a checkpoint when a patch will not apply, noting it",
    () =>
      Effect.gen(function* () {
        const copyFromNothing = message("event-football-nfl", 4286639, [
          { op: "copy", from: `${ariAtNyg}/competitors/5/score`, path: `${ariAtNyg}/competitors/0/score` }
        ])

        const { deliveries, noted } = yield* said([...synced(), unapplicablePatch(4286638), copyFromNothing])

        assert.deepStrictEqual(
          deliveries.filter(({ seq }) => seq > 5),
          []
        )
        assert.strictEqual(count(noted, "Reset", { league: "nfl", reason: "Unapplicable" }), 1)
      })
  )

  it.effect("should change nothing when removing a whole event the document does not have", () =>
    Effect.gen(function* () {
      const removed = message("event-football-nfl", 4286638, [{ op: "remove", path: "s:20~l:28~e:1~c:1" }])

      const { deliveries, noted } = yield* said([...synced(), removed, scoreReplaced(4286639)])

      assert.deepStrictEqual(
        deliveries.filter(({ seq }) => seq > 5).map(({ seq, delivery }) => [seq, delivery._tag]),
        [[7, "Snapshot"]]
      )
      assert.strictEqual(count(noted, "Reset"), 0)
    })
  )

  it.effect("should reset a synced topic on a message that does not decode, noting it", () =>
    Effect.gen(function* () {
      const { deliveries, noted } = yield* said([
        ...synced(),
        undecodablePatch(4286638),
        scoreReplaced(4286639)
      ])

      assert.deepStrictEqual(
        deliveries.filter(({ seq }) => seq > 5),
        [],
        "the topic waits for its next checkpoint"
      )
      assert.strictEqual(count(noted, "Reset", { league: "nfl", reason: "Unapplicable" }), 1)
      assert.strictEqual(count(noted, "FrameUndecoded"), 0)
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
  ])("should ask for a topic's checkpoint again, once, after $reset", ({ frames, expected }) =>
    Effect.gen(function* () {
      const { resynced } = yield* said(frames())

      assert.deepStrictEqual(resynced, expected)
    })
  )

  it.effect("should ask for nothing for a topic that was never synced", () =>
    Effect.gen(function* () {
      const { resynced } = yield* said([poll("nfl", scoreboardBody), ...beforeAnyCheckpoint()])

      assert.deepStrictEqual(resynced, [])
    })
  )

  it.effect(
    "should leave a topic waiting on a checkpoint that does not decode, noting FrameUndecoded, with no Resync",
    () =>
      Effect.gen(function* () {
        const unreadable = [
          poll("nfl", scoreboardBody),
          checkpoint("event-football-nfl", 7, { sports: "not a scoreboard" }),
          scoreReplaced(8)
        ]

        const { deliveries, noted, resynced } = yield* said(unreadable)

        assert.deepStrictEqual(resynced, [])
        assert.deepStrictEqual(
          deliveries.map(({ seq }) => seq),
          [1],
          "the message after it is not applied"
        )
        assert.strictEqual(count(noted, "FrameUndecoded", { feed: "fastcast", kind: "checkpoint" }), 1)
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

      const all = yield* decodedFrames(frames)

      assert.deepStrictEqual(
        all.flatMap((output) =>
          output.seq === 4
            ? output.deliveries.flatMap((delivery) =>
                delivery._tag === "Snapshot" ? [[delivery.snapshot.id, delivery.snapshot.away.score]] : []
              )
            : []
        ),
        [["401872966", 6]]
      )
      assert.deepStrictEqual(
        all.flatMap(({ resyncs }) => resyncs),
        []
      )
    })
  )

  it.effect("should touch no metric and log nothing, only noting what it observed", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
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

      const { noted } = yield* said(frames).pipe(Effect.provide(layer))

      const metrics = yield* Metric.snapshot
      assert.sameMembers(
        [...new Set(noted.map(({ observation }) => observation._tag))],
        [
          "FrameUndecoded",
          "EventUndecoded",
          "Received",
          "Unlisted",
          "Pushed",
          "Reset",
          "PlayTypeUnknown",
          "PlayUndecoded"
        ]
      )
      assert.deepStrictEqual(metrics, [])
      assert.deepStrictEqual(logs, [])
    }).pipe(withMetrics)
  )

  it.effect("should note each message by league and op, and the games pushed", () =>
    Effect.gen(function* () {
      const { noted } = yield* said([poll("nfl", scoreboardBody), ...recorded(socketTexts)])

      const received = noted.flatMap(({ observation }) =>
        observation._tag === "Received"
          ? [`${Option.getOrElse(observation.league, () => "none")} ${observation.op}`]
          : []
      )
      const pushed = noted.flatMap(({ observation }) =>
        observation._tag === "Pushed" && observation.league === "nfl" ? [observation.games] : []
      )
      assert.deepStrictEqual(
        Object.fromEntries(
          [...new Set(received)].map((key) => [key, received.filter((k) => k === key).length])
        ),
        { "none C": 1, "nfl S": 1, "nfl H": 1, "nfl R": 3, "nfl P": 81, "nfl I": 16 }
      )
      assert.isAbove(
        pushed.reduce((total, games) => total + games, 0),
        16
      )
      assert.strictEqual(count(noted, "EventUndecoded"), 0, "every event decodes")
    })
  )

  it.effect(
    "should skip an event that does not decode, noting it by league and feed, and list the rest",
    () =>
      Effect.gen(function* () {
        const { events } = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ events: Schema.Array(Schema.Json) }))
        )(scoreboardBody)
        const withBroken = JSON.stringify({ events: [{ id: "broken" }, ...events] })

        const { deliveries, noted } = yield* said([poll("nfl", withBroken)])

        const [listing] = deliveries
        assert.strictEqual(
          listing?.delivery._tag === "Listing" ? listing.delivery.games.length : 0,
          events.length
        )
        assert.strictEqual(count(noted, "EventUndecoded", { league: "nfl", feed: "poll" }), 1)
      })
  )

  it.effect("should skip a frame that does not decode, noting it FrameUndecoded with its seq", () =>
    Effect.gen(function* () {
      const { deliveries, noted } = yield* said([poll("nfl", "not json"), poll("nfl", scoreboardBody)])

      assert.deepStrictEqual(
        deliveries.map(({ seq }) => seq),
        [2]
      )
      assert.deepStrictEqual(
        noted.flatMap(({ observation, seq }) =>
          observation._tag === "FrameUndecoded"
            ? [[seq, observation.feed, observation.channel, observation.kind]]
            : []
        ),
        [[1, "poll", "nfl", "response"]]
      )
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
            deliveries.map(({ delivery }) => (delivery._tag === "Plays" ? delivery.game : undefined)),
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
            delivery._tag === "Plays" ? delivery.plays.map((play) => play.text) : []
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

          const { deliveries, noted } = yield* said(frames)

          const penalty =
            deliveries[1]?.delivery._tag === "Plays"
              ? deliveries[1].delivery.plays.find((play) => play.id === "401872971792")?.text
              : undefined
          assert.isTrue(
            moveRecording.messages[0]?.pl.includes('"op":"move"'),
            "the first recorded message has a move"
          )
          assert.deepStrictEqual(
            deliveries.map(({ seq }) => seq),
            [1, 2, 5],
            "the checkpoint, message 819, and message 822 change the plays"
          )
          assert.include(penalty, "PENALTY on BUF-C.McGovern")
          assert.include(deliveries.map(playIds).at(-1) ?? [], PlayId.make("4018729711662"))
          assert.strictEqual(count(noted, "Reset"), 0)
          assert.strictEqual(count(noted, "FrameUndecoded"), 0)
        })
    )

    it.effect("should leave out a play that does not decode, noting it once, and deliver the rest", () =>
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

        const { deliveries, noted } = yield* said(frames)

        assert.deepStrictEqual(deliveries.map(playIds), [
          ["401872966237", "401872966271"],
          ["401872966237", "401872966271"]
        ])
        assert.strictEqual(count(noted, "PlayUndecoded", { league: "nfl", play: "401872966999" }), 1)
        assert.strictEqual(count(noted, "PlayUndecoded"), 1)
      })
    )

    it.effect("should give nothing and fail nothing for a patch outside the plays", () =>
      Effect.gen(function* () {
        const { deliveries, noted } = yield* said([
          checkpoint(ariAtNygPlays, 99, { entities: {} }),
          playsMessage(100, [
            { op: "replace", path: "/boxscore/teams/0/statistics/0/displayValue", value: "12" }
          ]),
          playsMessage(101, [{ op: "add", path: "/entities/plays", value: plays("40187297063") }])
        ])

        assert.deepStrictEqual(deliveries.map(playIds), [[], ["40187297063"]])
        assert.strictEqual(count(noted, "Reset"), 0)
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

        const { deliveries, noted } = yield* said(frames)

        const after = deliveries.filter(({ seq }) => seq > 7)
        assert.deepStrictEqual(
          after.map(({ delivery }) => delivery._tag),
          ["Plays", "Snapshot"]
        )
        assert.deepStrictEqual(after.map(playIds)[0], ["401872971330"])
        assert.strictEqual(count(noted, "Reset", { league: "nfl", reason: "Gap" }), 1)
      })
    )

    it.effect("should note a play type the table does not know once", () =>
      Effect.gen(function* () {
        const unknown = { ...playEntities["40187297063"], type: { id: "999", text: "Something New" } }
        const frames = [
          checkpoint(ariAtNygPlays, 99, { entities: { plays: { "40187297063": unknown } } }),
          playsMessage(100, [{ op: "replace", path: "/entities/plays/40187297063/text", value: "Again" }])
        ]

        const { noted } = yield* said(frames)

        assert.strictEqual(count(noted, "PlayTypeUnknown", { id: "999", text: "Something New" }), 1)
        assert.strictEqual(count(noted, "PlayTypeUnknown"), 1)
      })
    )
  })

  describe("one Decoded per frame", () => {
    it.effect(
      "should give a message that changes no document a Decoded with only its Received observation",
      () =>
        Effect.gen(function* () {
          const [only, ...rest] = yield* decodedFrames([
            message("event-football-nfl", 1, [{ op: "replace", path: "/x", value: "1" }])
          ])

          assert.deepStrictEqual(rest, [])
          assert.strictEqual(only?.seq, 1)
          assert.deepStrictEqual(only?.deliveries, [])
          assert.deepStrictEqual(only?.resyncs, [])
          assert.deepStrictEqual(
            only?.observations.map((observation) => observation._tag),
            ["Received"]
          )
        })
    )

    it.effect(
      "should give a poll that does not decode a Decoded with no deliveries and one FrameUndecoded",
      () =>
        Effect.gen(function* () {
          const all = yield* decodedFrames([poll("nfl", "not json")])

          assert.strictEqual(all.length, 1)
          assert.deepStrictEqual(all[0]?.deliveries, [])
          assert.deepStrictEqual(
            all[0]?.observations.map((observation) => observation._tag),
            ["FrameUndecoded"]
          )
        })
    )

    it.effect("should give a scoreboard push a Decoded of each pushed game's Snapshot, noted Pushed", () =>
      Effect.gen(function* () {
        const all = yield* decodedFrames(synced())

        const pushing = all.find((one) =>
          one.observations.some((observation) => observation._tag === "Pushed")
        )
        assert.strictEqual(pushing?.deliveries.length, 16)
        assert.isTrue(pushing?.deliveries.every((delivery) => delivery._tag === "Snapshot"))
      })
    )

    it.effect("should give a dropped document a Decoded whose resyncs are its topic", () =>
      Effect.gen(function* () {
        const all = yield* decodedFrames([...synced(), undecodablePatch(4286638)])

        assert.deepStrictEqual(all.at(-1)?.resyncs, ["event-football-nfl"])
      })
    )

    it.effect("should give one Decoded per frame, with matching seqs", () =>
      Effect.gen(function* () {
        const frames = [poll("nfl", scoreboardBody), poll("nfl", "not json"), ...recorded(socketTexts)]

        const all = yield* decodedFrames(frames)

        assert.deepStrictEqual(
          all.map(({ seq }) => seq),
          frames.map((_, index) => index + 1)
        )
      })
    )
  })

  // Decoding NE at BUF's whole recorded day takes seconds alone, and many under a full suite's load: the layer decodes
  // it once for both tests, with a timeout to match.
  it.layer(neAtBufDecoded, { timeout: "60 seconds" })("the recorded NE at BUF day", (it) => {
    it.effect("should decode every snapshot so it reads back from its JSON Equal to itself", () =>
      Effect.gen(function* () {
        const decoded = yield* FramesDecoded
        const deliveries = decoded.flatMap(({ deliveries }) => deliveries)
        const snapshots = deliveries.flatMap((delivery) =>
          delivery._tag === "Listing"
            ? delivery.games
            : delivery._tag === "Snapshot"
              ? [delivery.snapshot]
              : []
        )

        const backs = yield* Effect.forEach(snapshots, (snapshot) =>
          Schema.encodeEffect(snapshotJson)(snapshot).pipe(Effect.flatMap(Schema.decodeEffect(snapshotJson)))
        )

        assert.isNotEmpty(snapshots)
        for (const [index, snapshot] of snapshots.entries()) {
          assert.isTrue(Equal.equals(backs[index], snapshot), snapshot.id)
        }
      })
    )

    it.effect("should decode every play so it reads back from its JSON Equal to itself", () =>
      Effect.gen(function* () {
        const decoded = yield* FramesDecoded
        const deliveries = decoded.flatMap(({ deliveries }) => deliveries)
        const plays = deliveries.flatMap((delivery) => (delivery._tag === "Plays" ? delivery.plays : []))

        const backs = yield* Effect.forEach(plays, (play) =>
          Schema.encodeEffect(playJson)(play).pipe(Effect.flatMap(Schema.decodeEffect(playJson)))
        )

        assert.isNotEmpty(plays)
        for (const [index, play] of plays.entries()) {
          assert.isTrue(Equal.equals(backs[index], play), play.id)
        }
      })
    )
  })
})

/**
 * What `frames` decode to, each numbered by its place from 1: the deliveries, what decoding observed, and the channels
 * it asked to have checkpointed again, in order.
 */
function said(frames: ReadonlyArray<FeedFrame>) {
  return decodedFrames(frames).pipe(
    Effect.map((all) => ({
      deliveries: all.flatMap(({ seq, at, deliveries }) =>
        deliveries.map((delivery) => ({ seq, at, delivery }))
      ),
      noted: all.flatMap(({ seq, observations }) =>
        observations.map((observation) => ({ seq, observation }))
      ),
      resynced: all.flatMap(({ resyncs }) => resyncs)
    }))
  )
}

/** How many of `noted` are `tag` observations with `fields`. */
function count<T extends DecodeObservation["_tag"]>(
  noted: ReadonlyArray<{ readonly observation: DecodeObservation }>,
  tag: T,
  fields: Partial<Data.TaggedEnum.Value<DecodeObservation, T>> = {}
) {
  return noted.filter(({ observation }) => {
    const values = new Map(Object.entries(observation))
    return (
      observation._tag === tag && Object.entries(fields).every(([key, value]) => values.get(key) === value)
    )
  }).length
}

/** The deliveries `frames` decode to, each numbered by its place from 1. */
function decoded(frames: ReadonlyArray<FeedFrame>) {
  return said(frames).pipe(Effect.map(({ deliveries }) => deliveries))
}

const at = DateTime.makeUnsafe("2026-10-04T18:00:00Z")

function poll(channel: string, body: string): FeedFrame {
  return { receivedAt: at, feed: "poll", channel, kind: "response", body }
}

function checkpoint(channel: string, mid: number, document: unknown): FeedFrame {
  return {
    receivedAt: at,
    feed: "fastcast",
    channel,
    kind: "checkpoint",
    sourceId: mid,
    body: JSON.stringify(document)
  }
}

/** A `P` on `channel`, its patches sent as an array, one of the three ways FastCast spells them. */
function message(channel: string, mid: number, patches: ReadonlyArray<object>): FeedFrame {
  const pl = JSON.stringify({ ts: 1791136341731, pl: patches })
  return {
    receivedAt: at,
    feed: "fastcast",
    channel,
    kind: "message",
    sourceId: mid,
    body: JSON.stringify({ op: "P", tc: channel, mid, pl })
  }
}

function playsMessage(mid: number, patches: ReadonlyArray<object>, channel = ariAtNygPlays) {
  return message(channel, mid, patches)
}

function plays(...ids: ReadonlyArray<string>) {
  return Object.fromEntries(ids.map((id) => [id, playEntities[id] ?? {}]))
}

/** The recorded socket texts as FastCast frames them, each `H` followed by the recorded checkpoint. */
function recorded(texts: ReadonlyArray<string>): ReadonlyArray<FeedFrame> {
  return texts.flatMap((body) => {
    const { op, tc, mid } = decodeEnvelope(body)
    const frame: FeedFrame = {
      receivedAt: at,
      feed: "fastcast",
      channel: tc ?? "socket",
      kind: "message",
      body,
      ...(mid === undefined ? {} : { sourceId: mid })
    }
    return op === "H" && tc !== undefined && mid !== undefined
      ? [frame, { ...frame, kind: "checkpoint", body: checkpointBody }]
      : [frame]
  })
}

const decodeEnvelope = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ op: Schema.String, tc: Schema.optional(Schema.String), mid: Schema.optional(Schema.Int) })
  )
)

// Each game as the last pushed snapshot of it.
function lastPushed(deliveries: ReadonlyArray<{ readonly delivery: Delivery }>) {
  return new Map<string, GameSnapshot>(
    deliveries.flatMap(({ delivery }) =>
      delivery._tag === "Snapshot" ? [[delivery.snapshot.id, delivery.snapshot] as const] : []
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
  return delivery._tag === "Plays" ? delivery.plays.map((play) => play.id) : []
}

/** The NFL listed, then FastCast's C, S, H, and the H's checkpoint: frames 1 to 5, the scoreboard topic synced. */
function synced(): ReadonlyArray<FeedFrame> {
  return [poll("nfl", scoreboardBody), ...recorded(socketTexts.slice(0, 3))]
}

/** FastCast's C and S, then a patch and an idle message before any checkpoint. */
function beforeAnyCheckpoint(): ReadonlyArray<FeedFrame> {
  return recorded([...socketTexts.slice(0, 2), socketTexts[3] ?? "", socketTexts[6] ?? ""])
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
function moveRecordingFrames(): ReadonlyArray<FeedFrame> {
  const game = "gp-football-nfl-401872971"
  const messages = moveRecording.messages.map(
    ({ op, tc, mid, ts, pl }): FeedFrame => ({
      receivedAt: at,
      feed: "fastcast",
      channel: tc,
      kind: "message",
      sourceId: mid,
      body: JSON.stringify({ op, tc, mid, pl: JSON.stringify({ ts, pl }) })
    })
  )
  return [checkpoint(game, moveRecording.checkpoint.mid, moveRecording.checkpoint.body), ...messages]
}
