import { assert, describe, it } from "@effect/vitest"
import { GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { SlateObservation } from "@sportal/domain/Slate"
import { DateTime, Effect, Schema } from "effect"
import type { FeedFrame } from "../../Frame.ts"
import { Slate } from "../../Slate.ts"
import { ScenarioScript } from "../../scenario/ScenarioScript.ts"
import { decodedFrames, slateFollowing, takenOf } from "../../TestFeed.ts"
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

const scenario = scenarioOf(script)
const { frames } = scenario

/** The frames up to and including step `index`'s: every one before the next step's polls. */
const throughStep = (index: number): ReadonlyArray<FeedFrame> => {
  const next = script.steps[index + 1]
  if (next === undefined) return frames
  const before = DateTime.toEpochMillis(script.origin) + next.at
  return frames.filter((frame) => DateTime.toEpochMillis(frame.receivedAt) < before)
}

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

describe("scenarioOf", () => {
  it("should write a scenario of the script's name", () => {
    assert.strictEqual(scenario.name, "written-as-espn")
  })

  it("should start with a poll", () => {
    assert.deepStrictEqual([frames[0]?.feed, frames[0]?.kind], ["poll", "response"])
  })

  it("should start at the script's origin", () => {
    assert.deepStrictEqual(scenario.origin(), script.origin)
  })

  it("should write frames in the order they were received", () => {
    const received = frames.map((frame) => DateTime.toEpochMillis(frame.receivedAt))

    assert.deepStrictEqual(
      received,
      received.toSorted((a, b) => a - b)
    )
  })

  it.effect(
    "should play, through the ESPN decoder, to each step's slate and each game's plays so far",
    () =>
      Effect.forEach(
        script.steps,
        (step, index) =>
          Effect.gen(function* () {
            const slate = yield* Slate
            const current = yield* slate.latest

            assert.deepStrictEqual(
              onWire(slateOnWire(current.games(LeagueId.literals))),
              onWire(slateOnWire(step.slate)),
              `the slate at ${step.at}`
            )
            for (const game of step.slate) {
              const written = script.steps
                .slice(0, index + 1)
                .flatMap(({ plays }) => plays.filter((play) => play.game === game.id).map(({ play }) => play))
              const held = current.live.get(game.id)
              // The slate lets a game go once it is over, and its plays with it.
              if (held === undefined) assert.strictEqual(game.progress(), "over", `${game.id} at ${step.at}`)
              else
                assert.deepStrictEqual(
                  onWire(playsOnWire(held.plays)),
                  onWire(playsOnWire(written)),
                  `${game.id}'s plays at ${step.at}`
                )
            }
          }).pipe(Effect.provide(slateFollowing(throughStep(index), { decoder: EspnDecode.layer }))),
        { discard: true }
      ),
    { timeout: 30_000 }
  )

  it("should write each game's plays on its own topic", () => {
    const channels = new Set(messages.map((frame) => frame.channel))

    assert.deepStrictEqual(
      [...channels],
      ["gp-football-nfl-401000001", "gp-football-college-football-402000001"]
    )
  })

  it("should number each topic's messages 1, 2, 3 … in their bodies", () => {
    const numbered = topics.map((onTopic) => onTopic.map((frame) => Schema.decodeSync(Mid)(frame.body).mid))

    assert.deepStrictEqual(numbered, countedFromOne)
  })

  it("should number each topic's messages 1, 2, 3 … as their source ids", () => {
    const numbered = topics.map((onTopic) => onTopic.map((frame) => frame.sourceId))

    assert.deepStrictEqual(numbered, countedFromOne)
  })

  it("should checkpoint each game's topic once", () => {
    assert.strictEqual(checkpoints.length, 2)
  })

  it("should checkpoint each game's topic after the first poll that lists it", () => {
    const after = checkpoints.map((checkpoint) => {
      const game = checkpoint.channel.split("-").at(-1) ?? ""
      const firstPoll = frames.findIndex(
        (frame) =>
          frame.feed === "poll" &&
          Schema.decodeSync(Listed)(frame.body).events.some((event) => event.id === game)
      )
      return firstPoll >= 0 && frames.indexOf(checkpoint) > firstPoll
    })

    assert.deepStrictEqual(after, [true, true])
  })

  it("should checkpoint each game's topic before its first play", () => {
    const before = checkpoints.map(
      (checkpoint) =>
        frames.indexOf(checkpoint) <
        frames.findIndex((frame) => frame.kind === "message" && frame.channel === checkpoint.channel)
    )

    assert.deepStrictEqual(before, [true, true])
  })

  it("should give each checkpoint source id 0", () => {
    assert.deepStrictEqual(
      checkpoints.map((checkpoint) => checkpoint.sourceId),
      [0, 0]
    )
  })

  it.effect("should decode with no frame, event, or play that does not decode, and no reset", () =>
    Effect.gen(function* () {
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
      const { observations } = yield* takenOf(frames)

      assert.deepStrictEqual(observations.filter(SlateObservation.$is("Dropped")), [])
    }).pipe(Effect.provide(EspnDecode.layer))
  )

  it.effect("should decode one plays delivery per game's checkpoint and per play", () =>
    Effect.gen(function* () {
      const decoded = yield* decodedFrames(frames)

      assert.strictEqual(
        decoded.flatMap(({ deliveries }) => deliveries.filter(({ _tag }) => _tag === "Plays")).length,
        new Set(script.steps.flatMap(({ slate }) => slate.map(({ id }) => id))).size +
          script.steps.flatMap(({ plays }) => plays).length
      )
    }).pipe(Effect.provide(EspnDecode.layer))
  )

  it("should write a script's Kickoff return touchdown as ESPN's type 32", () => {
    const returned = scenarioOf(
      ScenarioScript.build("kickoff-return", [
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
    )

    const message = returned.frames.find((frame) => frame.kind === "message")

    assert.deepStrictEqual(Schema.decodeUnknownSync(Added)(message?.body).pl.pl[0]?.value.type, {
      id: "32",
      text: "Kickoff Return Touchdown"
    })
  })
})

const messages = frames.filter((frame) => frame.kind === "message")
const topics = [...new Set(messages.map((frame) => frame.channel))].map((channel) =>
  messages.filter((frame) => frame.channel === channel)
)
const checkpoints = frames.filter((frame) => frame.kind === "checkpoint")
// 1, 2, 3 … on each topic.
const countedFromOne: ReadonlyArray<ReadonlyArray<number | undefined>> = topics.map((onTopic) =>
  onTopic.map((_, index) => index + 1)
)
