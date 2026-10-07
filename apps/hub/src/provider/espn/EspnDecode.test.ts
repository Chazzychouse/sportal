import { readFileSync } from "node:fs"
import { assert, describe, layer } from "@effect/vitest"
import type { Delivery } from "@sportal/domain/Delivery"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { PlayId } from "@sportal/domain/Play"
import { type Data, DateTime, Effect, Metric, Option, Record, Schema } from "effect"
import type { FeedFrame } from "../../Frame.ts"
import { decodedFrames } from "../../TestFeed.ts"
import { recordingLogs, withMetrics } from "../../TestTelemetry.ts"
import type { Notice } from "../Provider.ts"
import * as EspnDecode from "./EspnDecode.ts"
import { EspnEvent } from "./EspnEvent.ts"

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

const ariAtNyg = "s:20~l:28~e:401872966~c:401872966"
const ariAtNygPlays = "gp-football-nfl-401872966"

layer(EspnDecode.layer)("EspnDecode", (it) => {
  // Each recorded feed as it decoded when both feeds' events were read by one transform: the poll's listings, the
  // checkpoint's pushes, and the checkpoint's events each read alone.
  describe("the recorded feeds decode to the same games", () => {
    const expected = Schema.decodeSync(
      Schema.fromJsonString(Schema.Struct({ deliveries: Schema.Json, checkpointEvents: Schema.Json }))
    )(fixture("decoded-snapshots.json"))
    const encoded = (value: unknown) => JSON.parse(JSON.stringify(value))
    const encode = Schema.encodeSync(GameSnapshot)

    it.effect("each listing and push", () =>
      Effect.gen(function* () {
        const all = yield* decoded([
          poll("fbs", fixture("fbs-scoreboard-live.json")),
          poll("nfl", scoreboardBody),
          checkpoint(
            "event-football-nfl",
            1,
            yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(checkpointBody)
          )
        ])

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

    it("each checkpoint event alone", () => {
      const events = Schema.decodeSync(
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
      const decodeEvent = Schema.decodeUnknownSync(EspnEvent("nfl"))

      assert.deepStrictEqual(
        encoded(events.map((event) => encode(decodeEvent(event)))),
        expected.checkpointEvents
      )
    })
  })

  it.effect("a poll response is its league's listing", () =>
    Effect.gen(function* () {
      const [listing] = yield* decoded([poll("nfl", scoreboardBody)])

      assert.strictEqual(listing?.seq, 1)
      assert.strictEqual(listing?.delivery._tag, "Listing")
      assert.strictEqual(listing?.delivery._tag === "Listing" ? listing.delivery.games.length : 0, 16)
    })
  )

  it.effect("a checkpoint is a pushed snapshot of every listed game on it, advanced to its listed game", () =>
    Effect.gen(function* () {
      const deliveries = yield* decoded([poll("nfl", scoreboardBody), ...recorded(socketTexts.slice(0, 3))])
      const pushed = deliveries.flatMap(({ delivery }) => (delivery._tag === "Snapshot" ? [delivery] : []))

      assert.strictEqual(pushed.length, 16)
      assert.isTrue(pushed.every((delivery) => delivery.from === "push"))
      // FastCast has no short names: each pushed game keeps its listed game's.
      const nyg = pushed.find((delivery) => delivery.snapshot.id === "401872966")?.snapshot
      assert.strictEqual(nyg?.home.team.shortName, "Giants")
    })
  )

  it("a checkpoint event carries its teams' colors", () => {
    const events = Schema.decodeSync(
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
    const decodeEvent = Schema.decodeUnknownSync(EspnEvent("nfl"))
    const ari = events.map((event) => decodeEvent(event)).find((game) => game.id === "401872966")?.away.team

    assert.strictEqual(ari?.color, "a40227")
    assert.strictEqual(ari?.alternateColor, "ffffff")
  })

  it.effect("the checkpoint and every message after it end each live game where the scoreboard had it", () =>
    Effect.gen(function* () {
      const pushed = lastPushed(yield* decoded([poll("nfl", scoreboardBody), ...recorded(socketTexts)]))
      const polled = (yield* decoded([poll("nfl", scoreboardBody)])).flatMap(({ delivery }) =>
        delivery._tag === "Listing" ? delivery.games : []
      )
      const live = polled.filter((game) => game.progress() === "live")

      assert.strictEqual(live.length, 8)
      assert.deepStrictEqual(
        live.map((game) => [game.matchup(), inPlay(pushed.get(game.id))]),
        live.map((game) => [game.matchup(), inPlay(game)])
      )
    })
  )

  it.effect(
    "orients the yard line for the team with the ball, and keeps it where the scoreboard drops it",
    () =>
      Effect.gen(function* () {
        const pushed = lastPushed(yield* decoded([poll("nfl", scoreboardBody), ...recorded(socketTexts)]))

        assert.strictEqual(pushed.get("401872971")?.situation?.possession, "nfl:2")
        assert.strictEqual(pushed.get("401872971")?.situation?.yardLine, 58)
        assert.strictEqual(pushed.get("401872968")?.situation?.possession, "nfl:27")
      })
  )

  it.effect("a pushed game no listing has is not delivered, and is noted Unlisted", () =>
    Effect.gen(function* () {
      const { deliveries, noted } = yield* said(recorded(socketTexts.slice(0, 3)))

      assert.deepStrictEqual(deliveries, [])
      assert.strictEqual(count(noted, "Unlisted", { league: "nfl" }), 16)
    })
  )

  it.effect("a copy adds the value read at its source", () =>
    Effect.gen(function* () {
      // ARI at NYG: the away team (competitor 0) had 14, the home team 6.
      const copy = message("event-football-nfl", 4286638, [
        { op: "copy", from: `${ariAtNyg}/competitors/1/score`, path: `${ariAtNyg}/competitors/0/score` }
      ])
      const deliveries = yield* decoded([
        poll("nfl", scoreboardBody),
        ...recorded(socketTexts.slice(0, 3)),
        copy
      ])

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

  it.effect("a missed message sends only that topic back to waiting for a checkpoint, noted Reset Gap", () =>
    Effect.gen(function* () {
      const skipped = [...socketTexts.slice(0, 20), ...socketTexts.slice(21)]
      const { deliveries, noted } = yield* said([
        poll("nfl", scoreboardBody),
        ...recorded(skipped),
        poll("nfl", scoreboardBody)
      ])

      assert.strictEqual(count(noted, "Reset", { league: "nfl", reason: "Gap" }), 1)
      // Frames 2–5 are C, S, H, and its checkpoint, so text 21, the first after the gap, is frame 23.
      const snapshotSeqs = deliveries.flatMap(({ seq, delivery }) =>
        delivery._tag === "Snapshot" ? [seq] : []
      )
      assert.isNotEmpty(snapshotSeqs)
      assert.isTrue(snapshotSeqs.every((seq) => seq < 23))
      assert.strictEqual(deliveries.at(-1)?.delivery._tag, "Listing", "the scoreboard poll still decodes")
    })
  )

  it.effect("a patch or an idle message before any checkpoint gives nothing and fails nothing", () =>
    Effect.gen(function* () {
      const early = recorded([...socketTexts.slice(0, 2), socketTexts[3] ?? "", socketTexts[6] ?? ""])

      assert.deepStrictEqual(yield* decoded([poll("nfl", scoreboardBody), ...early]).pipe(Effect.map(tags)), [
        "Listing"
      ])
    })
  )

  it.effect(
    "a patch that will not apply sends its topic back to waiting for a checkpoint, and is noted",
    () =>
      Effect.gen(function* () {
        const unapplicable = message("event-football-nfl", 4286638, [
          { op: "replace", path: `${ariAtNyg}/competitors/5/score`, value: "21" }
        ])
        const copyFromNothing = message("event-football-nfl", 4286639, [
          { op: "copy", from: `${ariAtNyg}/competitors/5/score`, path: `${ariAtNyg}/competitors/0/score` }
        ])
        const { deliveries, noted } = yield* said([
          poll("nfl", scoreboardBody),
          ...recorded(socketTexts.slice(0, 3)),
          unapplicable,
          copyFromNothing
        ])

        assert.deepStrictEqual(
          deliveries.filter(({ seq }) => seq > 5),
          []
        )
        assert.strictEqual(count(noted, "Reset", { league: "nfl", reason: "Unapplicable" }), 1)
      })
  )

  it.effect("removing a whole event the document does not have changes nothing", () =>
    Effect.gen(function* () {
      const { deliveries, noted } = yield* said([
        poll("nfl", scoreboardBody),
        ...recorded(socketTexts.slice(0, 3)),
        message("event-football-nfl", 4286638, [{ op: "remove", path: "s:20~l:28~e:1~c:1" }]),
        message("event-football-nfl", 4286639, [
          { op: "replace", path: `${ariAtNyg}/competitors/0/score`, value: "17" }
        ])
      ])

      assert.deepStrictEqual(
        deliveries.filter(({ seq }) => seq > 5).map(({ seq, delivery }) => [seq, delivery._tag]),
        [[7, "Snapshot"]]
      )
      assert.strictEqual(count(noted, "Reset"), 0)
    })
  )

  it.effect("a message that does not decode on a synced topic resets the topic, and is noted", () =>
    Effect.gen(function* () {
      const { deliveries, noted } = yield* said([
        poll("nfl", scoreboardBody),
        ...recorded(socketTexts.slice(0, 3)),
        message("event-football-nfl", 4286638, [{ op: "test", path: `${ariAtNyg}/clock`, value: "1:00" }]),
        message("event-football-nfl", 4286639, [
          { op: "replace", path: `${ariAtNyg}/competitors/0/score`, value: "17" }
        ])
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

  it.effect("a topic sent back to waiting asks for its checkpoint again, once per reset", () =>
    Effect.gen(function* () {
      const synced = [poll("nfl", scoreboardBody), ...recorded(socketTexts.slice(0, 3))]
      const gap = [...synced, ...recorded(socketTexts.slice(4, 6))]
      const unapplicable = [
        ...synced,
        message("event-football-nfl", 4286638, [
          { op: "replace", path: `${ariAtNyg}/competitors/5/score`, value: "21" }
        ]),
        message("event-football-nfl", 4286639, [
          { op: "replace", path: `${ariAtNyg}/competitors/0/score`, value: "17" }
        ])
      ]
      const undecodable = [
        ...synced,
        message("event-football-nfl", 4286638, [{ op: "test", path: `${ariAtNyg}/clock`, value: "1:00" }])
      ]
      const playsGap = [
        checkpoint(ariAtNygPlays, 99, { entities: {} }),
        playsMessage(101, [{ op: "add", path: "/entities/plays", value: plays("401872966237") }])
      ]

      assert.deepStrictEqual(yield* resyncs(gap), ["event-football-nfl"])
      assert.deepStrictEqual(yield* resyncs(unapplicable), ["event-football-nfl"])
      assert.deepStrictEqual(yield* resyncs(undecodable), ["event-football-nfl"])
      assert.deepStrictEqual(yield* resyncs(playsGap), [ariAtNygPlays])
    })
  )

  it.effect("a topic that was never synced asks for nothing", () =>
    Effect.gen(function* () {
      const early = recorded([...socketTexts.slice(0, 2), socketTexts[3] ?? "", socketTexts[6] ?? ""])

      assert.deepStrictEqual(yield* resyncs([poll("nfl", scoreboardBody), ...early]), [])
    })
  )

  it.effect(
    "a checkpoint that does not decode leaves its topic waiting, noted FrameUndecoded, with no Resync",
    () =>
      Effect.gen(function* () {
        const unreadable = [
          poll("nfl", scoreboardBody),
          checkpoint("event-football-nfl", 7, { sports: "not a scoreboard" }),
          message("event-football-nfl", 8, [
            { op: "replace", path: `${ariAtNyg}/competitors/0/score`, value: "17" }
          ])
        ]
        const { deliveries, noted } = yield* said(unreadable)

        assert.deepStrictEqual(yield* resyncs(unreadable), [])
        assert.deepStrictEqual(
          deliveries.map(({ seq }) => seq),
          [1],
          "the message after it is not applied"
        )
        assert.strictEqual(count(noted, "FrameUndecoded", { feed: "fastcast", kind: "checkpoint" }), 1)
      })
  )

  it.effect("the next checkpoint that decodes syncs it", () =>
    Effect.gen(function* () {
      const all = yield* decodedFrames([
        poll("nfl", scoreboardBody),
        checkpoint("event-football-nfl", 7, { sports: "not a scoreboard" }),
        checkpoint("event-football-nfl", 4286637, JSON.parse(checkpointBody)),
        // ARI at NYG: the away team (competitor 0) had 14, the home team 6.
        message("event-football-nfl", 4286638, [
          { op: "copy", from: `${ariAtNyg}/competitors/1/score`, path: `${ariAtNyg}/competitors/0/score` }
        ])
      ])

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

  it.effect("decode touches no metric and logs nothing", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
      const unknownType = { ...playEntities["40187297063"], type: { id: "999", text: "Something New" } }
      const brokenPlay = { ...Record.remove(playEntities["401872966237"] ?? {}, "statYardage"), id: "1" }
      const skipped = [...socketTexts.slice(0, 20), ...socketTexts.slice(21)]
      const { noted } = yield* said([
        poll("nfl", "not json"),
        poll("nfl", JSON.stringify({ events: [{ id: "broken" }] })),
        ...recorded(socketTexts.slice(0, 3)),
        poll("nfl", scoreboardBody),
        ...recorded(skipped.slice(3)),
        checkpoint(ariAtNygPlays, 99, {
          entities: { plays: { "40187297063": unknownType, "1": brokenPlay } }
        })
      ]).pipe(Effect.provide(layer))

      assert.sameMembers(
        [...new Set(noted.map(({ notice }) => notice._tag))],
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
      assert.deepStrictEqual(yield* Metric.snapshot, [])
      assert.deepStrictEqual(logs, [])
    }).pipe(withMetrics)
  )

  it.effect("notes each message by league and op, and the games pushed", () =>
    Effect.gen(function* () {
      const { noted } = yield* said([poll("nfl", scoreboardBody), ...recorded(socketTexts)])
      const received = noted.flatMap(({ notice }) =>
        notice._tag === "Received" ? [`${Option.getOrElse(notice.league, () => "none")} ${notice.op}`] : []
      )
      const pushed = noted.flatMap(({ notice }) =>
        notice._tag === "Pushed" && notice.league === "nfl" ? [notice.games] : []
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
    "an event that does not decode is skipped and noted by league and feed, and the rest listed",
    () =>
      Effect.gen(function* () {
        const { events } = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ events: Schema.Array(Schema.Json) }))
        )(scoreboardBody)
        const {
          deliveries: [listing],
          noted
        } = yield* said([poll("nfl", JSON.stringify({ events: [{ id: "broken" }, ...events] }))])

        assert.strictEqual(
          listing?.delivery._tag === "Listing" ? listing.delivery.games.length : 0,
          events.length
        )
        assert.strictEqual(count(noted, "EventUndecoded", { league: "nfl", feed: "poll" }), 1)
      })
  )

  it.effect("a frame that does not decode is noted FrameUndecoded with its seq, and skipped", () =>
    Effect.gen(function* () {
      const { deliveries, noted } = yield* said([poll("nfl", "not json"), poll("nfl", scoreboardBody)])

      assert.deepStrictEqual(
        deliveries.map(({ seq }) => seq),
        [2]
      )
      assert.deepStrictEqual(
        noted.flatMap(({ notice, seq }) =>
          notice._tag === "FrameUndecoded" ? [[seq, notice.feed, notice.channel, notice.kind]] : []
        ),
        [[1, "poll", "nfl", "response"]]
      )
    })
  )

  describe("a game's plays", () => {
    it.effect("a checkpoint and an add of plays give the game's whole list, in sequence order", () =>
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

        assert.deepStrictEqual(deliveries.map(playIds), [[], ["40187297063", "401872966237", "401872966271"]])
        assert.deepStrictEqual(
          deliveries.map(({ delivery }) => (delivery._tag === "Plays" ? delivery.game : undefined)),
          [GameId.make("401872966"), GameId.make("401872966")]
        )
      })
    )

    it.effect("a replaced text, a removed play, and a copy within the plays each give the new list", () =>
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

    it.effect("a move within the plays takes the value from its source", () =>
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
      "a recorded move outside the plays keeps the topic synced, and the plays after it still arrive",
      () =>
        Effect.gen(function* () {
          const game = "gp-football-nfl-401872971"
          const { deliveries, noted } = yield* said([
            checkpoint(game, moveRecording.checkpoint.mid, moveRecording.checkpoint.body),
            ...moveRecording.messages.map(
              ({ op, tc, mid, ts, pl }): FeedFrame => ({
                receivedAt: at,
                feed: "fastcast",
                channel: tc,
                kind: "message",
                sourceId: mid,
                body: JSON.stringify({ op, tc, mid, pl: JSON.stringify({ ts, pl }) })
              })
            )
          ])

          assert.isTrue(
            moveRecording.messages[0]?.pl.includes('"op":"move"'),
            "the first recorded message has a move"
          )
          assert.deepStrictEqual(
            deliveries.map(({ seq }) => seq),
            [1, 2, 5],
            "the checkpoint, message 819, and message 822 change the plays"
          )
          assert.include(
            deliveries[1]?.delivery._tag === "Plays"
              ? deliveries[1].delivery.plays.find((play) => play.id === "401872971792")?.text
              : undefined,
            "PENALTY on BUF-C.McGovern"
          )
          assert.include(deliveries.map(playIds).at(-1) ?? [], PlayId.make("4018729711662"))
          assert.strictEqual(count(noted, "Reset"), 0)
          assert.strictEqual(count(noted, "FrameUndecoded"), 0)
        })
    )

    it.effect("a play that does not decode is left out, noted once, and the rest delivered", () =>
      Effect.gen(function* () {
        const broken = {
          ...Record.remove(playEntities["401872966237"] ?? {}, "statYardage"),
          id: "401872966999"
        }
        const { deliveries, noted } = yield* said([
          checkpoint(ariAtNygPlays, 99, {
            entities: { plays: { ...plays("401872966237", "401872966271"), "401872966999": broken } }
          }),
          playsMessage(100, [
            { op: "replace", path: "/entities/plays/401872966271/text", value: "Corrected" }
          ])
        ])

        assert.deepStrictEqual(deliveries.map(playIds), [
          ["401872966237", "401872966271"],
          ["401872966237", "401872966271"]
        ])
        assert.strictEqual(count(noted, "PlayUndecoded", { league: "nfl", play: "401872966999" }), 1)
        assert.strictEqual(count(noted, "PlayUndecoded"), 1)
      })
    )

    it.effect("a patch outside the plays gives nothing and fails nothing", () =>
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

    it.effect("a gap on one game's topic leaves the other games and the scoreboard decoding", () =>
      Effect.gen(function* () {
        const other = "gp-football-nfl-401872971"
        const { deliveries, noted } = yield* said([
          poll("nfl", scoreboardBody),
          ...recorded(socketTexts.slice(0, 3)),
          checkpoint(ariAtNygPlays, 99, { entities: {} }),
          checkpoint(other, 99, { entities: {} }),
          playsMessage(101, [{ op: "add", path: "/entities/plays", value: plays("401872966237") }]),
          playsMessage(100, [{ op: "add", path: "/entities/plays", value: plays("401872971330") }], other),
          message("event-football-nfl", 4286638, [
            { op: "replace", path: `${ariAtNyg}/competitors/0/score`, value: "17" }
          ])
        ])
        const after = deliveries.filter(({ seq }) => seq > 7)

        assert.deepStrictEqual(
          after.map(({ delivery }) => delivery._tag),
          ["Plays", "Snapshot"]
        )
        assert.deepStrictEqual(after.map(playIds)[0], ["401872971330"])
        assert.strictEqual(count(noted, "Reset", { league: "nfl", reason: "Gap" }), 1)
      })
    )

    it.effect("notes a play type the table does not know once", () =>
      Effect.gen(function* () {
        const unknown = { ...playEntities["40187297063"], type: { id: "999", text: "Something New" } }
        const { noted } = yield* said([
          checkpoint(ariAtNygPlays, 99, { entities: { plays: { "40187297063": unknown } } }),
          playsMessage(100, [{ op: "replace", path: "/entities/plays/40187297063/text", value: "Again" }])
        ])

        assert.strictEqual(count(noted, "PlayTypeUnknown", { id: "999", text: "Something New" }), 1)
        assert.strictEqual(count(noted, "PlayTypeUnknown"), 1)
      })
    )
  })

  describe("one Decoded per frame", () => {
    it.effect("a message that changes no document is a Decoded with only its Received notice", () =>
      Effect.gen(function* () {
        const [only, ...rest] = yield* decodedFrames([
          message("event-football-nfl", 1, [{ op: "replace", path: "/x", value: "1" }])
        ])

        assert.deepStrictEqual(rest, [])
        assert.strictEqual(only?.seq, 1)
        assert.deepStrictEqual(only?.deliveries, [])
        assert.deepStrictEqual(only?.resyncs, [])
        assert.deepStrictEqual(
          only?.notices.map((notice) => notice._tag),
          ["Received"]
        )
      })
    )

    it.effect("a poll that does not decode is a Decoded with no deliveries and one FrameUndecoded", () =>
      Effect.gen(function* () {
        const all = yield* decodedFrames([poll("nfl", "not json")])

        assert.strictEqual(all.length, 1)
        assert.deepStrictEqual(all[0]?.deliveries, [])
        assert.deepStrictEqual(
          all[0]?.notices.map((notice) => notice._tag),
          ["FrameUndecoded"]
        )
      })
    )

    it.effect("a scoreboard push is a Decoded of each pushed game's Snapshot, noted Pushed", () =>
      Effect.gen(function* () {
        const all = yield* decodedFrames([poll("nfl", scoreboardBody), ...recorded(socketTexts.slice(0, 3))])
        const pushing = all.find((one) => one.notices.some((notice) => notice._tag === "Pushed"))

        assert.strictEqual(pushing?.deliveries.length, 16)
        assert.isTrue(pushing?.deliveries.every((delivery) => delivery._tag === "Snapshot"))
      })
    )

    it.effect("a dropped document is a Decoded whose resyncs are its topic", () =>
      Effect.gen(function* () {
        const all = yield* decodedFrames([
          poll("nfl", scoreboardBody),
          ...recorded(socketTexts.slice(0, 3)),
          message("event-football-nfl", 4286638, [{ op: "test", path: `${ariAtNyg}/clock`, value: "1:00" }])
        ])

        assert.deepStrictEqual(all.at(-1)?.resyncs, ["event-football-nfl"])
      })
    )

    it.effect("N frames in give N Decoded out, with matching seqs", () =>
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
})

/** What `frames` decode to, each numbered by its place from 1: the deliveries, and what decoding noticed. */
function said(frames: ReadonlyArray<FeedFrame>) {
  return decodedFrames(frames).pipe(
    Effect.map((all) => ({
      deliveries: all.flatMap(({ seq, at, deliveries }) =>
        deliveries.map((delivery) => ({ seq, at, delivery }))
      ),
      noted: all.flatMap(({ seq, notices }) => notices.map((notice) => ({ seq, notice })))
    }))
  )
}

/** How many of `noted` are `tag` notices with `fields`. */
function count<T extends Notice["_tag"]>(
  noted: ReadonlyArray<{ readonly notice: Notice }>,
  tag: T,
  fields: Partial<Data.TaggedEnum.Value<Notice, T>> = {}
) {
  return noted.filter(({ notice }) => {
    const values = new Map(Object.entries(notice))
    return notice._tag === tag && Object.entries(fields).every(([key, value]) => values.get(key) === value)
  }).length
}

/** The deliveries `frames` decode to, each numbered by its place from 1. */
function decoded(frames: ReadonlyArray<FeedFrame>) {
  return said(frames).pipe(Effect.map(({ deliveries }) => deliveries))
}

/** The channels decoding `frames` asks to have checkpointed again, in order. */
function resyncs(frames: ReadonlyArray<FeedFrame>) {
  return decodedFrames(frames).pipe(Effect.map((all) => all.flatMap(({ resyncs }) => resyncs)))
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
