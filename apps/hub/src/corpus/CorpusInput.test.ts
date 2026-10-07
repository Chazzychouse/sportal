import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { GameId } from "@sportal/domain/Game"
import { PlayId } from "@sportal/domain/Play"
import { liveSnapshot, play, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Equal, Exit, Schema } from "effect"
import { Decoded } from "../provider/Provider.ts"
import { CorpusInput, CorpusLine, Had } from "./CorpusInput.ts"

const game = GameId.make("1")
const listing = Delivery.cases.Listing.make({
  league: "fbs",
  games: [snapshot(), liveSnapshot({ id: GameId.make("2") })]
})
const first = play({ id: PlayId.make("a"), sequence: 1 })
const second = play({ id: PlayId.make("b"), sequence: 2, text: "Rush for 2 yards" })
const changed = play({ id: PlayId.make("a"), sequence: 1, text: "Rush for 1 yard (corrected)" })
const third = play({ id: PlayId.make("c"), sequence: 3 })

const decodeds = [
  decoded(1, [listing]),
  decoded(2, [Delivery.cases.Listing.make({ league: "fbs", games: [...listing.games] })]),
  decoded(3, [Delivery.cases.Snapshot.make({ snapshot: liveSnapshot(), from: "push" })]),
  decoded(4, [Delivery.cases.Plays.make({ game, plays: [first, second] })]),
  decoded(5, [Delivery.cases.Plays.make({ game, plays: [changed, second, third] })])
]

describe("CorpusLine", () => {
  it.effect(
    "says each frame's deliveries against what the day had, listings to poll and the rest to push",
    () =>
      Effect.gen(function* () {
        const { lines } = yield* linesOf(decodeds)
        assert.deepStrictEqual(
          lines.map(({ file, line }) => [file, line.seq, line.input._tag]),
          [
            ["poll", 1, "ListingChanged"],
            ["poll", 2, "ListingUnchanged"],
            ["push", 3, "Snapshot"],
            ["push", 4, "PlaysChanged"],
            ["push", 5, "PlaysChanged"]
          ]
        )
        const [, , , whole, delta] = lines.map(({ line }) => line.input)
        assert.deepStrictEqual(
          whole,
          CorpusInput.cases.PlaysChanged.make({ game, upserts: [first, second], removed: [] })
        )
        assert.deepStrictEqual(
          delta,
          CorpusInput.cases.PlaysChanged.make({ game, upserts: [changed, third], removed: [] })
        )
      })
  )

  it.effect("reads back as exactly the deliveries each frame said", () =>
    Effect.gen(function* () {
      const { lines } = yield* linesOf(decodeds)
      const read = deliveriesOf(lines.map(({ line }) => line))
      assert.lengthOf(read, decodeds.length)
      assert.deepStrictEqual(
        read.map((deliveries, index) => Equal.equals(deliveries, decodeds[index]?.deliveries)),
        decodeds.map(() => true)
      )
    })
  )

  it.effect("rebuilds a game's whole list in play order from upserts", () =>
    Effect.gen(function* () {
      const plays = [
        decoded(1, [Delivery.cases.Plays.make({ game, plays: [first, third] })]),
        decoded(2, [Delivery.cases.Plays.make({ game, plays: [first, second, third] })])
      ]
      const { lines } = yield* linesOf(plays)
      const [, rebuilt] = deliveriesOf(lines.map(({ line }) => line))
      assert.deepStrictEqual(
        rebuilt?.flatMap((delivery) => (delivery._tag === "Plays" ? delivery.plays.map(({ id }) => id) : [])),
        ["a", "b", "c"]
      )
    })
  )

  it.effect("a play the game no longer lists is removed, and reads back without it", () =>
    Effect.gen(function* () {
      const dropping = [
        decoded(1, [Delivery.cases.Plays.make({ game, plays: [first, second] })]),
        decoded(2, [Delivery.cases.Plays.make({ game, plays: [second] })])
      ]
      const { lines } = yield* linesOf(dropping)
      assert.deepStrictEqual(
        lines[1]?.line.input,
        CorpusInput.cases.PlaysChanged.make({ game, upserts: [], removed: [first.id] })
      )
      const read = deliveriesOf(lines.map(({ line }) => line))
      assert.isTrue(Equal.equals(read[1], dropping[1]?.deliveries))
    })
  )

  it.effect("a poll snapshot is a defect, so a decoder that sends one fails the build", () =>
    Effect.gen(function* () {
      const exit = yield* CorpusLine.of(
        decoded(1, [Delivery.cases.Snapshot.make({ snapshot: liveSnapshot(), from: "poll" })]),
        Had.empty
      ).pipe(Effect.exit)
      assert.isTrue(Exit.hasDies(exit))
    })
  )

  it.effect("round-trips each line through its JSON form", () =>
    Effect.gen(function* () {
      const wire = Schema.fromJsonString(CorpusLine)
      const { lines } = yield* linesOf(decodeds)
      for (const { line } of lines) {
        assert.deepStrictEqual(yield* Schema.decodeEffect(wire)(yield* Schema.encodeEffect(wire)(line)), line)
      }
    })
  )
})

function decoded(seq: number, deliveries: ReadonlyArray<Delivery>): Decoded {
  return new Decoded({
    seq,
    at: DateTime.makeUnsafe(Date.UTC(2026, 9, 3, 16, 0, seq)),
    deliveries,
    resyncs: [],
    observations: []
  })
}

/** Every frame's lines, in order, with the file each sits in, `Had` threaded from the day's start. */
function linesOf(frames: ReadonlyArray<Decoded>) {
  return Effect.reduce(
    frames,
    () => ({ lines: [] as ReadonlyArray<{ file: "poll" | "push"; line: CorpusLine }>, had: Had.empty }),
    ({ lines, had }, frame) =>
      CorpusLine.of(frame, had).pipe(
        Effect.map((next) => ({
          lines: [
            ...lines,
            ...next.poll.map((line) => ({ file: "poll" as const, line })),
            ...next.push.map((line) => ({ file: "push" as const, line }))
          ],
          had: next.had
        }))
      )
  )
}

/** Each frame's deliveries, a frame to each line here, `Had` threaded from the day's start. */
function deliveriesOf(lines: ReadonlyArray<CorpusLine>): ReadonlyArray<ReadonlyArray<Delivery>> {
  return lines.reduce(
    ({ read, had }, line) => {
      const next = CorpusLine.deliveries([line], had)
      return { read: [...read, next.deliveries], had: next.had }
    },
    { read: [] as ReadonlyArray<ReadonlyArray<Delivery>>, had: Had.empty }
  ).read
}
