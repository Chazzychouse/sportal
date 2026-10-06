import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import type { Delivery } from "@sportal/domain/Delivery"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import { PlayId } from "@sportal/domain/Play"
import { DateTime, Effect, Metric, Record, Schema, Stream } from "effect"
import { Frame } from "../../feed/Frame.ts"
import { counted, recordingLogs, withMetrics } from "../../TestTelemetry.ts"
import * as EspnDecode from "./EspnDecode.ts"
import * as EspnPayload from "./EspnPayload.ts"

// Recorded from ESPN on 2026-10-04: the NFL checkpoint at 17:52Z, every socket text on its topic after it until
// 18:00Z, each line one text as it arrived, and the scoreboard polled at 18:00Z.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
const checkpointBody = fixture("nfl-fastcast-checkpoint-2026-10-04T1752Z.json")
const socketTexts = Schema.decodeUnknownSync(Schema.Array(Schema.fromJsonString(Schema.String)))(
  fixture("nfl-fastcast-messages-2026-10-04T1752Z.jsonl").trim().split("\n")
)
const scoreboardBody = fixture("nfl-scoreboard-2026-10-04T1800Z.json")
const playEntities = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)))
)(fixture("nfl-plays-2026-10-04.json"))
// Recorded from ESPN on 2026-10-04 on BUF at NE's game topic: the two plays its messages 819–822 patch, as they stood
// after message 818, and those messages as the recorder kept them. Message 819 opens with a `move` outside the plays.
const moveRecording = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      checkpoint: Schema.Struct({ mid: Schema.Int, body: Schema.Json }),
      messages: Schema.Array(
        Schema.Struct({
          op: Schema.String,
          tc: Schema.String,
          mid: Schema.Int,
          ts: Schema.Number,
          pl: Schema.String
        })
      )
    })
  )
)(fixture("nfl-gp-move-2026-10-04.json"))

const ariAtNyg = "s:20~l:28~e:401872966~c:401872966"
const ariAtNygPlays = "gp-football-nfl-401872966"

describe("EspnDecode", () => {
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

  it.effect("the checkpoint and every message after it end each live game where the scoreboard had it", () =>
    Effect.gen(function* () {
      const pushed = lastPushed(yield* decoded([poll("nfl", scoreboardBody), ...recorded(socketTexts)]))
      const polled = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EspnPayload.Scoreboard))(
        scoreboardBody
      ).pipe(Effect.flatMap((board) => EspnDecode.slateOf("nfl", board)))
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

  it.effect("a pushed game no listing has is not delivered, and is counted", () =>
    Effect.gen(function* () {
      const deliveries = yield* decoded(recorded(socketTexts.slice(0, 3)))

      assert.deepStrictEqual(deliveries, [])
      assert.strictEqual(yield* counted("sportal_live_feed_unlisted", { league: "nfl" }), 16)
    }).pipe(withMetrics)
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

  it.effect("a missed message sends only that topic back to waiting for a checkpoint, and is counted", () =>
    Effect.gen(function* () {
      const skipped = [...socketTexts.slice(0, 20), ...socketTexts.slice(21)]
      const deliveries = yield* decoded([
        poll("nfl", scoreboardBody),
        ...recorded(skipped),
        poll("nfl", scoreboardBody)
      ])

      assert.strictEqual(
        yield* counted("sportal_live_feed_document_resets", { league: "nfl", reason: "Gap" }),
        1
      )
      // Frames 2–5 are C, S, H, and its checkpoint, so text 21, the first after the gap, is frame 23.
      const snapshotSeqs = deliveries.flatMap(({ seq, delivery }) =>
        delivery._tag === "Snapshot" ? [seq] : []
      )
      assert.isNotEmpty(snapshotSeqs)
      assert.isTrue(snapshotSeqs.every((seq) => seq < 23))
      assert.strictEqual(deliveries.at(-1)?.delivery._tag, "Listing", "the scoreboard poll still decodes")
    }).pipe(withMetrics)
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
    "a patch that will not apply sends its topic back to waiting for a checkpoint, and is counted",
    () =>
      Effect.gen(function* () {
        const unapplicable = message("event-football-nfl", 4286638, [
          { op: "replace", path: `${ariAtNyg}/competitors/5/score`, value: "21" }
        ])
        const copyFromNothing = message("event-football-nfl", 4286639, [
          { op: "copy", from: `${ariAtNyg}/competitors/5/score`, path: `${ariAtNyg}/competitors/0/score` }
        ])
        const deliveries = yield* decoded([
          poll("nfl", scoreboardBody),
          ...recorded(socketTexts.slice(0, 3)),
          unapplicable,
          copyFromNothing
        ])

        assert.deepStrictEqual(
          deliveries.filter(({ seq }) => seq > 5),
          []
        )
        assert.strictEqual(
          yield* counted("sportal_live_feed_document_resets", { league: "nfl", reason: "Unapplicable" }),
          1
        )
      }).pipe(withMetrics)
  )

  it.effect("removing a whole event the document does not have changes nothing", () =>
    Effect.gen(function* () {
      const deliveries = yield* decoded([
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
      assert.isUndefined(yield* counted("sportal_live_feed_document_resets"))
    }).pipe(withMetrics)
  )

  it.effect("a message that does not decode on a synced topic resets the topic, and is counted", () =>
    Effect.gen(function* () {
      const deliveries = yield* decoded([
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
      assert.strictEqual(
        yield* counted("sportal_live_feed_document_resets", { league: "nfl", reason: "Unapplicable" }),
        1
      )
      assert.isUndefined(yield* counted("sportal_frames_undecoded"))
    }).pipe(withMetrics)
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

  it.effect("counts the messages by league and op, and the games pushed", () =>
    Effect.gen(function* () {
      yield* decoded([poll("nfl", scoreboardBody), ...recorded(socketTexts)])
      const byLeagueAndOp = (yield* Metric.snapshot).flatMap((metric) =>
        metric.id === "sportal_live_feed_messages" && metric.type === "Counter"
          ? [[metric.attributes?.league, metric.attributes?.op, metric.state.count]]
          : []
      )

      assert.sameDeepMembers(byLeagueAndOp, [
        [undefined, "C", 1],
        ["nfl", "S", 1],
        ["nfl", "H", 1],
        ["nfl", "R", 3],
        ["nfl", "P", 81],
        ["nfl", "I", 16]
      ])
      assert.isAbove(Number((yield* counted("sportal_live_feed_games", { league: "nfl" })) ?? 0), 16)
      assert.isUndefined(yield* counted("sportal_live_feed_undecoded"), "every event decodes")
    }).pipe(withMetrics)
  )

  it.effect("a frame that does not decode is logged with its seq, counted, and skipped", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
      const deliveries = yield* decoded([poll("nfl", "not json"), poll("nfl", scoreboardBody)]).pipe(
        Effect.provide(layer)
      )

      assert.deepStrictEqual(
        deliveries.map(({ seq }) => seq),
        [2]
      )
      assert.strictEqual(yield* counted("sportal_frames_undecoded", { feed: "poll" }), 1)
      assert.isTrue(logs.some((log) => log.level === "Error" && log.annotations.seq === 1))
    }).pipe(withMetrics)
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
          const deliveries = yield* decoded([
            checkpoint(game, moveRecording.checkpoint.mid, moveRecording.checkpoint.body),
            ...moveRecording.messages.map(
              ({ op, tc, mid, ts, pl }): Omit<Frame, "seq"> => ({
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
          assert.isUndefined(yield* counted("sportal_live_feed_document_resets"))
          assert.isUndefined(yield* counted("sportal_frames_undecoded"))
        }).pipe(withMetrics)
    )

    it.effect(
      "a play that does not decode is left out, logged once and counted, and the rest delivered",
      () =>
        Effect.gen(function* () {
          const { logs, layer } = recordingLogs()
          const broken = {
            ...Record.remove(playEntities["401872966237"] ?? {}, "statYardage"),
            id: "401872966999"
          }
          const deliveries = yield* decoded([
            checkpoint(ariAtNygPlays, 99, {
              entities: { plays: { ...plays("401872966237", "401872966271"), "401872966999": broken } }
            }),
            playsMessage(100, [
              { op: "replace", path: "/entities/plays/401872966271/text", value: "Corrected" }
            ])
          ]).pipe(Effect.provide(layer))

          assert.deepStrictEqual(deliveries.map(playIds), [
            ["401872966237", "401872966271"],
            ["401872966237", "401872966271"]
          ])
          assert.strictEqual(yield* counted("sportal_live_feed_undecoded_plays", { league: "nfl" }), 1)
          assert.strictEqual(
            logs.filter((log) => log.level === "Warn" && log.message.includes("401872966999")).length,
            1
          )
        }).pipe(withMetrics)
    )

    it.effect("a patch outside the plays gives nothing and fails nothing", () =>
      Effect.gen(function* () {
        const deliveries = yield* decoded([
          checkpoint(ariAtNygPlays, 99, { entities: {} }),
          playsMessage(100, [
            { op: "replace", path: "/boxscore/teams/0/statistics/0/displayValue", value: "12" }
          ]),
          playsMessage(101, [{ op: "add", path: "/entities/plays", value: plays("40187297063") }])
        ])

        assert.deepStrictEqual(deliveries.map(playIds), [[], ["40187297063"]])
        assert.isUndefined(yield* counted("sportal_live_feed_document_resets"))
      }).pipe(withMetrics)
    )

    it.effect("a gap on one game's topic leaves the other games and the scoreboard decoding", () =>
      Effect.gen(function* () {
        const other = "gp-football-nfl-401872971"
        const deliveries = yield* decoded([
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
        assert.strictEqual(
          yield* counted("sportal_live_feed_document_resets", { league: "nfl", reason: "Gap" }),
          1
        )
      }).pipe(withMetrics)
    )

    it.effect("logs a play type the table does not know once, at Info", () =>
      Effect.gen(function* () {
        const { logs, layer } = recordingLogs()
        const unknown = { ...playEntities["40187297063"], type: { id: "999", text: "Something New" } }
        yield* decoded([
          checkpoint(ariAtNygPlays, 99, { entities: { plays: { "40187297063": unknown } } }),
          playsMessage(100, [{ op: "replace", path: "/entities/plays/40187297063/text", value: "Again" }])
        ]).pipe(Effect.provide(layer))

        assert.strictEqual(
          logs.filter((log) => log.level === "Info" && log.message.includes("Something New")).length,
          1
        )
      })
    )
  })
})

/** The deliveries `frames` decode to, each numbered by its place from 1. */
function decoded(frames: ReadonlyArray<Omit<Frame, "seq">>) {
  return outputs(frames).pipe(
    Effect.map((all) => all.flatMap((output) => (output._tag === "Delivered" ? [output] : [])))
  )
}

/** The channels decoding `frames` asks to have checkpointed again, in order. */
function resyncs(frames: ReadonlyArray<Omit<Frame, "seq">>) {
  return outputs(frames).pipe(
    Effect.map((all) => all.flatMap((output) => (output._tag === "Resync" ? [output.channel] : [])))
  )
}

function outputs(frames: ReadonlyArray<Omit<Frame, "seq">>) {
  return EspnDecode.decode(
    Stream.fromIterable(frames.map((frame, index) => new Frame({ ...frame, seq: index + 1 })))
  ).pipe(Stream.runCollect)
}

const at = DateTime.makeUnsafe("2026-10-04T18:00:00Z")

function poll(channel: string, body: string): Omit<Frame, "seq"> {
  return { receivedAt: at, feed: "poll", channel, kind: "response", body }
}

function checkpoint(channel: string, mid: number, document: unknown): Omit<Frame, "seq"> {
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
function message(channel: string, mid: number, patches: ReadonlyArray<object>): Omit<Frame, "seq"> {
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
function recorded(texts: ReadonlyArray<string>): ReadonlyArray<Omit<Frame, "seq">> {
  return texts.flatMap((body) => {
    const { op, tc, mid } = decodeEnvelope(body)
    const frame: Omit<Frame, "seq"> = {
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
    isRedZone: game?.situation?.isRedZone,
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
