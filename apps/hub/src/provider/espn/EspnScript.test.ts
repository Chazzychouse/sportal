import { assert, describe, it } from "@effect/vitest"
import { GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { SlateObservation } from "@sportal/domain/SlateObservation"
import { DateTime, Effect, Schema } from "effect"
import type { FeedFrame } from "../../Frame.ts"
import { ScenarioScript } from "../../scenario/ScenarioScript.ts"
import { latestOf, slateFollowing, takenOf } from "../../TestLiveSlate.ts"
import { decodedFrames } from "../TestDecoder.ts"
import * as EspnDecode from "./EspnDecode.ts"
import { scenarioOf } from "./EspnScript.ts"

// An NFL game that scores a touchdown and its extra point and goes to halftime, and a ranked FBS game that kicks off,
// runs a rush, a sack, a punt, an interception, a touchdown and a two-point try, and goes final.
const script = ScenarioScript.build("written-as-espn", [
  {
    id: "401000001",
    home: "KC",
    away: "BUF",
    league: "nfl",
    network: "CBS",
    kickoff: "-1:00:00",
    timeline: [
      [
        "0:00",
        {
          status: "live",
          period: 2,
          clock: "1:10",
          score: [7, 3],
          timeouts: [2, 3],
          ball: { team: "away", yardLine: 30, down: 2, distance: 8 }
        }
      ],
      [
        "0:40",
        {
          clock: "0:52",
          score: [7, 9],
          ball: null,
          play: {
            _tag: "Completion",
            touchdown: true,
            yards: 30,
            text: "Allen pass to Kincaid for 30 yards, touchdown"
          }
        }
      ],
      ["0:50", { score: [7, 10], play: { _tag: "ExtraPoint", good: true, yards: 0 } }],
      ["1:20", { status: "halftime", clock: "0:00" }]
    ]
  },
  {
    id: "402000001",
    home: "UGA",
    away: "ALA",
    network: "ESPN",
    kickoff: "0:20",
    ranking: { home: 5, away: 2 },
    timeline: [
      [
        "0:20",
        {
          status: "live",
          period: 1,
          clock: "15:00",
          ball: { team: "home", yardLine: 75, down: 1, distance: 10 }
        }
      ],
      [
        "0:40",
        {
          clock: "14:31",
          ball: { team: "home", yardLine: 71, down: 2, distance: 6 },
          play: { _tag: "Rush", touchdown: false, yards: 4 }
        }
      ],
      [
        "1:00",
        {
          clock: "13:55",
          ball: { team: "home", yardLine: 78, down: 3, distance: 13 },
          play: { _tag: "Sack", fumbleLost: false, yards: -7 }
        }
      ],
      [
        "1:20",
        {
          clock: "13:40",
          ball: { team: "away", yardLine: 64, down: 1, distance: 10 },
          play: { _tag: "Punt", return: "none", yards: 42 }
        }
      ],
      [
        "1:40",
        {
          clock: "11:02",
          ball: { team: "home", yardLine: 58, down: 1, distance: 10 },
          play: { _tag: "Interception", return: "none", yards: 0 }
        }
      ],
      [
        "1:50",
        { clock: "10:40", score: [6, 0], ball: null, play: { _tag: "Rush", touchdown: true, yards: 58 } }
      ],
      ["1:55", { score: [8, 0], play: { _tag: "TwoPointTry", by: "rush", yards: 3 } }],
      ["2:00", { status: "final", period: 4, clock: "0:00", score: [31, 17], ball: null }]
    ]
  }
])

const gameTopics = ["gp-football-nfl-401000001", "gp-football-college-football-402000001"]

describe("scenarioOf", () => {
  it("should write a scenario of the script's name", () => {
    const scenario = scenarioOf(script)

    assert.strictEqual(scenario.name, "written-as-espn")
  })

  it("should start with a poll", () => {
    const { frames } = scenarioOf(script)

    assert.deepStrictEqual([frames[0]?.feed, frames[0]?.kind], ["poll", "response"])
  })

  it("should start at the script's origin", () => {
    const scenario = scenarioOf(script)

    assert.deepStrictEqual(scenario.origin(), script.origin)
  })

  it("should write frames in the order they were received", () => {
    const { frames } = scenarioOf(script)

    const received = frames.map((frame) => DateTime.toEpochMillis(frame.receivedAt))
    assert.deepStrictEqual(
      received,
      received.toSorted((a, b) => a - b)
    )
  })

  it.effect.each(script.steps.map((step, index) => ({ at: step.at, index, step })))(
    "should play, through the ESPN decoder, to the slate and each game's plays so far at $at ms",
    ({ at, index, step }) =>
      Effect.gen(function* () {
        const { frames } = scenarioOf(script)
        const following = slateFollowing(throughStep(frames, index), { decoder: EspnDecode.layer })

        const current = yield* latestOf(following)

        assert.deepStrictEqual(
          onWire(slateOnWire(current.games(LeagueId.literals))),
          onWire(slateOnWire(step.slate)),
          `the slate at ${at}`
        )
        for (const game of step.slate) {
          const held = current.live.get(game.id)
          // The slate lets a game go once it is over, and its plays with it.
          if (held === undefined) assert.strictEqual(game.progress(), "over", `${game.id} at ${at}`)
          else
            assert.deepStrictEqual(
              onWire(playsOnWire(held.plays)),
              onWire(playsOnWire(writtenPlaysThrough(index, game.id))),
              `${game.id}'s plays at ${at}`
            )
        }
      })
  )

  it("should write each game's plays on its own topic", () => {
    const { frames } = scenarioOf(script)

    const channels = new Set(messagesOf(frames).map((frame) => frame.channel))
    assert.deepStrictEqual([...channels], gameTopics)
  })

  it("should number each topic's messages 1, 2, 3 … in their bodies", () => {
    const { frames } = scenarioOf(script)

    const topics = topicsOf(frames)
    const numbered = topics.map((onTopic) => onTopic.map((frame) => Schema.decodeSync(Mid)(frame.body).mid))
    assert.deepStrictEqual(numbered, countedFromOne(topics))
  })

  it("should number each topic's messages 1, 2, 3 … as their source ids", () => {
    const { frames } = scenarioOf(script)

    const topics = topicsOf(frames)
    const numbered = topics.map((onTopic) => onTopic.map((frame) => frame.sourceId))
    assert.deepStrictEqual(numbered, countedFromOne(topics))
  })

  it("should checkpoint each game's topic once", () => {
    const { frames } = scenarioOf(script)

    assert.strictEqual(checkpointsOf(frames).length, 2)
  })

  it.each(gameTopics)("should checkpoint %s after the first poll that lists its game", (topic) => {
    const { frames } = scenarioOf(script)

    const checkpointAt = frames.findIndex((frame) => frame.kind === "checkpoint" && frame.channel === topic)
    const game = topic.split("-").at(-1) ?? ""
    const firstPoll = frames.findIndex(
      (frame) =>
        frame.feed === "poll" &&
        Schema.decodeSync(Listed)(frame.body).events.some((event) => event.id === game)
    )
    assert.isAtLeast(firstPoll, 0, `a poll lists ${game}`)
    assert.isAbove(checkpointAt, firstPoll, topic)
  })

  it.each(gameTopics)("should checkpoint %s before its first play", (topic) => {
    const { frames } = scenarioOf(script)

    const checkpointAt = frames.findIndex((frame) => frame.kind === "checkpoint" && frame.channel === topic)
    const firstPlay = frames.findIndex((frame) => frame.kind === "message" && frame.channel === topic)
    assert.isBelow(checkpointAt, firstPlay, topic)
  })

  it("should give each checkpoint source id 0", () => {
    const { frames } = scenarioOf(script)

    assert.deepStrictEqual(
      checkpointsOf(frames).map((checkpoint) => checkpoint.sourceId),
      [0, 0]
    )
  })

  it.effect("should decode without a frame, event, or play that does not decode, or a reset", () =>
    Effect.gen(function* () {
      const { frames } = scenarioOf(script)

      const decoded = yield* decodedFrames(frames)

      assert.deepStrictEqual(
        decoded.flatMap(({ observations }) =>
          observations.filter(({ _tag }) => _tag !== "Received" && _tag !== "Pushed").map(({ _tag }) => _tag)
        ),
        []
      )
    }).pipe(Effect.provide(EspnDecode.layer))
  )

  it.effect("should decode with no game dropped", () =>
    Effect.gen(function* () {
      const { frames } = scenarioOf(script)

      const { observations } = yield* takenOf(frames)

      assert.deepStrictEqual(observations.filter(SlateObservation.$is("Dropped")), [])
    }).pipe(Effect.provide(EspnDecode.layer))
  )

  it.effect("should decode one plays delivery per game's checkpoint and per play", () =>
    Effect.gen(function* () {
      const { frames } = scenarioOf(script)
      const games = new Set(script.steps.flatMap(({ slate }) => slate.map(({ id }) => id))).size
      const plays = script.steps.flatMap(({ plays }) => plays).length

      const decoded = yield* decodedFrames(frames)

      assert.strictEqual(
        decoded.flatMap(({ deliveries }) => deliveries.filter(({ _tag }) => _tag === "Plays")).length,
        games + plays
      )
    }).pipe(Effect.provide(EspnDecode.layer))
  )

  it("should write a script's Kickoff return touchdown as ESPN's type 32", () => {
    const returned = scenarioOf(kickoffReturnScript())

    const message = returned.frames.find((frame) => frame.kind === "message")
    assert.deepStrictEqual(Schema.decodeUnknownSync(Added)(message?.body).pl.pl[0]?.value.type, {
      id: "32",
      text: "Kickoff Return Touchdown"
    })
  })
})

// Compared as they go on the wire, where a field that is undefined is not there, as it is not in ESPN's JSON.
const slateOnWire = Schema.encodeSync(Schema.fromJsonString(Schema.Array(GameSnapshot)))
const playsOnWire = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Play)))
const onWire = Schema.decodeSync(Schema.fromJsonString(Schema.Json))

const Mid = Schema.fromJsonString(Schema.Struct({ mid: Schema.Int }))
// A game topic's message that adds a play entity, as `scenarioOf` writes one.
const Added = Schema.fromJsonString(
  Schema.Struct({
    pl: Schema.fromJsonString(
      Schema.Struct({
        pl: Schema.Array(
          Schema.Struct({
            value: Schema.Struct({ type: Schema.Struct({ id: Schema.String, text: Schema.String }) })
          })
        )
      })
    )
  })
)
const Listed = Schema.fromJsonString(
  Schema.Struct({ events: Schema.Array(Schema.Struct({ id: Schema.String })) })
)

/** `frames` up to and including step `index`'s: every one before the next step's polls. */
function throughStep(frames: ReadonlyArray<FeedFrame>, index: number): ReadonlyArray<FeedFrame> {
  const next = script.steps[index + 1]
  if (next === undefined) return frames
  const before = DateTime.toEpochMillis(script.origin) + next.at
  return frames.filter((frame) => DateTime.toEpochMillis(frame.receivedAt) < before)
}

/** The plays the script ran for `game` through step `index`. */
function writtenPlaysThrough(index: number, game: string) {
  return script.steps
    .slice(0, index + 1)
    .flatMap(({ plays }) => plays.filter((play) => play.game === game).map(({ play }) => play))
}

function messagesOf(frames: ReadonlyArray<FeedFrame>) {
  return frames.filter((frame) => frame.kind === "message")
}

/** The messages of each topic, a list per topic, in the order the topics first appear. */
function topicsOf(frames: ReadonlyArray<FeedFrame>) {
  const messages = messagesOf(frames)
  const channels = [...new Set(messages.map((frame) => frame.channel))]
  return channels.map((channel) => messages.filter((frame) => frame.channel === channel))
}

function checkpointsOf(frames: ReadonlyArray<FeedFrame>) {
  return frames.filter((frame) => frame.kind === "checkpoint")
}

/** 1, 2, 3 … on each topic. */
function countedFromOne(
  topics: ReadonlyArray<ReadonlyArray<FeedFrame>>
): ReadonlyArray<ReadonlyArray<number | undefined>> {
  return topics.map((onTopic) => onTopic.map((_, index) => index + 1))
}

/** A college game whose opening kickoff is returned for a touchdown. */
function kickoffReturnScript() {
  return ScenarioScript.build("kickoff-return", [
    {
      id: "402000002",
      home: "UGA",
      away: "ALA",
      timeline: [
        [
          "0:00",
          {
            status: "live",
            period: 1,
            clock: "15:00",
            ball: { team: "away", yardLine: 35, down: 1, distance: 10 }
          }
        ],
        [
          "0:30",
          {
            clock: "14:48",
            score: [0, 6],
            ball: null,
            play: { _tag: "Kickoff", returnTouchdown: true, yards: 98 }
          }
        ]
      ]
    }
  ])
}
