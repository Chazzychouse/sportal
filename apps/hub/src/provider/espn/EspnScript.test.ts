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
          play: { kind: "pass", yards: 30, text: "Allen pass to Kincaid for 30 yards, touchdown" }
        }
      ],
      ["0:50", { score: [7, 10], play: { kind: "extraPoint", yards: 0 } }],
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
          play: { kind: "rush", yards: 4 }
        }
      ],
      [
        "1:00",
        {
          clock: "13:55",
          ball: { team: "home", yardLine: 78, down: 3, distance: 13 },
          play: { kind: "sack", yards: -7 }
        }
      ],
      [
        "1:20",
        {
          clock: "13:40",
          ball: { team: "away", yardLine: 64, down: 1, distance: 10 },
          play: { kind: "punt", yards: 42 }
        }
      ],
      [
        "1:40",
        {
          clock: "11:02",
          ball: { team: "home", yardLine: 58, down: 1, distance: 10 },
          play: { kind: "interception", yards: 0 }
        }
      ],
      ["1:50", { clock: "10:40", score: [6, 0], ball: null, play: { kind: "rush", yards: 58 } }],
      ["1:55", { score: [8, 0], play: { kind: "twoPoint", yards: 3 } }],
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
const Listed = Schema.fromJsonString(
  Schema.Struct({ events: Schema.Array(Schema.Struct({ id: Schema.String })) })
)

describe("scenarioOf", () => {
  it("writes a scenario of the script's name, starting with a poll at the script's origin", () => {
    assert.strictEqual(scenario.name, "written-as-espn")
    assert.deepStrictEqual([frames[0]?.feed, frames[0]?.kind], ["poll", "response"])
    assert.deepStrictEqual(scenario.origin(), script.origin)
  })

  it("writes frames in the order they were received", () => {
    const received = frames.map((frame) => DateTime.toEpochMillis(frame.receivedAt))
    assert.deepStrictEqual(
      received,
      received.toSorted((a, b) => a - b)
    )
  })

  it.effect(
    "plays, through the ESPN decoder, to each step's slate and each game's plays so far",
    () =>
      Effect.forEach(
        script.steps,
        (step, index) =>
          Effect.gen(function* () {
            const current = yield* (yield* Slate).latest
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

  it("numbers each topic's messages 1, 2, 3 …, in their bodies and as their source ids", () => {
    const messages = frames.filter((frame) => frame.kind === "message")
    const channels = [...new Set(messages.map((frame) => frame.channel))]
    assert.deepStrictEqual(channels, ["gp-football-nfl-401000001", "gp-football-college-football-402000001"])
    for (const channel of channels) {
      const onTopic = messages.filter((frame) => frame.channel === channel)
      const numbered = onTopic.map((_, index) => index + 1)
      assert.deepStrictEqual(
        onTopic.map((frame) => Schema.decodeUnknownSync(Mid)(frame.body).mid),
        numbered
      )
      assert.deepStrictEqual(
        onTopic.map((frame) => frame.sourceId),
        numbered
      )
    }
  })

  it("checkpoints each game's topic after the first poll that lists it and before its first play", () => {
    const checkpoints = frames.filter((frame) => frame.kind === "checkpoint")
    assert.strictEqual(checkpoints.length, 2)
    for (const checkpoint of checkpoints) {
      const game = checkpoint.channel.split("-").at(-1) ?? ""
      const firstPoll = frames.findIndex(
        (frame) =>
          frame.feed === "poll" &&
          Schema.decodeUnknownSync(Listed)(frame.body).events.some((event) => event.id === game)
      )
      const firstPlay = frames.findIndex(
        (frame) => frame.kind === "message" && frame.channel === checkpoint.channel
      )
      const at = frames.indexOf(checkpoint)
      assert.isAtLeast(firstPoll, 0)
      assert.isAbove(at, firstPoll)
      assert.isBelow(at, firstPlay)
      assert.strictEqual(checkpoint.sourceId, 0)
    }
  })

  it.effect(
    "decodes with no frame, event, or play that does not decode, no reset, and no plays dropped",
    () =>
      Effect.gen(function* () {
        const decoded = yield* decodedFrames(frames)
        assert.deepStrictEqual(
          decoded.flatMap(({ observations }) =>
            observations
              .filter(({ _tag }) => _tag !== "Received" && _tag !== "Pushed")
              .map(({ _tag }) => _tag)
          ),
          []
        )
        const { observations } = yield* takenOf(frames)
        assert.deepStrictEqual(observations.filter(SlateObservation.$is("Dropped")), [])
        assert.strictEqual(
          decoded.flatMap(({ deliveries }) => deliveries.filter(({ _tag }) => _tag === "Plays")).length,
          // One per game's checkpoint, and one per play.
          new Set(script.steps.flatMap(({ slate }) => slate.map(({ id }) => id))).size +
            script.steps.flatMap(({ plays }) => plays).length
        )
      }).pipe(Effect.provide(EspnDecode.layer))
  )
})
