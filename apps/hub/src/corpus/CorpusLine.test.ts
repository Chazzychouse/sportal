import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { PlayId } from "@sportal/domain/Play"
import { liveSnapshot, play, snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Equal, Exit, Schema, Stream } from "effect"
import { Decoded } from "../provider/Provider.ts"
import { Delivery } from "../slate/Delivery.ts"
import { CorpusInput, CorpusLine } from "./CorpusLine.ts"

describe("CorpusLine", () => {
  it.effect(
    "should say each frame's deliveries against what the day had, listings to poll and the rest to push",
    () =>
      Effect.gen(function* () {
        const lines = yield* linesOf(decodeds)

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

  it.effect("should read back as exactly the deliveries each frame said", () =>
    Effect.gen(function* () {
      const lines = yield* linesOf(decodeds)

      const read = yield* deliveriesOf(lines.map(({ line }) => line))

      assert.lengthOf(read, decodeds.length)
      assert.deepStrictEqual(
        read.map((deliveries, index) => Equal.equals(deliveries, decodeds[index]?.deliveries)),
        decodeds.map(() => true)
      )
    })
  )

  it.effect("should rebuild a game's whole list in play order from upserts", () =>
    Effect.gen(function* () {
      const plays = [
        decoded(1, [Delivery.cases.Plays.make({ game, plays: [first, third] })]),
        decoded(2, [Delivery.cases.Plays.make({ game, plays: [first, second, third] })])
      ]
      const lines = yield* linesOf(plays)

      const [, rebuilt] = yield* deliveriesOf(lines.map(({ line }) => line))

      assert.deepStrictEqual(
        rebuilt?.flatMap((delivery) => (delivery._tag === "Plays" ? delivery.plays.map(({ id }) => id) : [])),
        ["a", "b", "c"]
      )
    })
  )

  it.effect("should remove a play the game no longer lists", () =>
    Effect.gen(function* () {
      const dropping = droppingFirst()

      const lines = yield* linesOf(dropping)

      assert.deepStrictEqual(
        lines[1]?.line.input,
        CorpusInput.cases.PlaysChanged.make({ game, upserts: [], removed: [first.id] })
      )
    })
  )

  it.effect("should read a removed play back without it", () =>
    Effect.gen(function* () {
      const dropping = droppingFirst()
      const lines = yield* linesOf(dropping)

      const read = yield* deliveriesOf(lines.map(({ line }) => line))

      assert.isTrue(Equal.equals(read[1], dropping[1]?.deliveries))
    })
  )

  it.effect("should die on a poll snapshot, so a decoder that sends one fails the build", () =>
    Effect.gen(function* () {
      const polled = decoded(1, [Delivery.cases.Snapshot.make({ snapshot: liveSnapshot(), from: "poll" })])

      const exit = yield* CorpusLine.ofDecoded(Stream.make(polled)).pipe(Effect.exit)

      assert.isTrue(Exit.hasDies(exit))
    })
  )

  it.effect("should round-trip each line through its JSON form", () =>
    Effect.gen(function* () {
      const wire = Schema.fromJsonString(CorpusLine)
      const lines = yield* linesOf(decodeds)

      const backs = yield* Effect.forEach(lines, ({ line }) =>
        Schema.encodeEffect(wire)(line).pipe(Effect.flatMap(Schema.decodeEffect(wire)))
      )

      for (const [index, { line }] of lines.entries()) {
        assert.deepStrictEqual(backs[index], line)
      }
    })
  )
})

describe("CorpusLine.ofDecoded", () => {
  it.effect("should split a day's lines into poll and push", () =>
    Effect.gen(function* () {
      const frames = [
        decoded(1, [listing]),
        decoded(2, [
          Delivery.cases.Plays.make({ game, plays: [first] }),
          Delivery.cases.Snapshot.make({ snapshot: liveSnapshot(), from: "push" })
        ]),
        decoded(3, [listing])
      ]

      const { poll, push } = yield* CorpusLine.ofDecoded(Stream.fromIterable(frames))

      assert.deepStrictEqual(
        poll.map(({ seq, input }) => [seq, input._tag]),
        [
          [1, "ListingChanged"],
          [3, "ListingUnchanged"]
        ]
      )
      assert.deepStrictEqual(
        push.map(({ seq, input }) => [seq, input._tag]),
        [
          [2, "PlaysChanged"],
          [2, "Snapshot"]
        ]
      )
    })
  )

  it.effect("should write an unchanged listing and an empty plays change for what did not change", () =>
    Effect.gen(function* () {
      const frames = [
        decoded(1, [listing]),
        decoded(2, [Delivery.cases.Plays.make({ game, plays: [first, second] })]),
        decoded(3, [Delivery.cases.Listing.make({ league: "fbs", games: [...listing.games] })]),
        decoded(4, [Delivery.cases.Plays.make({ game, plays: [first, second] })])
      ]

      const { poll, push } = yield* CorpusLine.ofDecoded(Stream.fromIterable(frames))

      assert.deepStrictEqual(
        poll.map(({ input }) => input),
        [
          CorpusInput.cases.ListingChanged.make({ league: "fbs", games: listing.games }),
          CorpusInput.cases.ListingUnchanged.make({ league: "fbs" })
        ]
      )
      assert.deepStrictEqual(
        push.map(({ input }) => input),
        [
          CorpusInput.cases.PlaysChanged.make({ game, upserts: [first, second], removed: [] }),
          CorpusInput.cases.PlaysChanged.make({ game, upserts: [], removed: [] })
        ]
      )
    })
  )
})

function decoded(seq: number, deliveries: ReadonlyArray<Delivery>): Decoded {
  return new Decoded({
    seq,
    at: DateTime.makeUnsafe(Date.UTC(2026, 9, 3, 16, 0, seq)),
    deliveries,
    observations: []
  })
}

/** Every frame's lines, by arrival, with the file each sits in. */
function linesOf(frames: ReadonlyArray<Decoded>) {
  return CorpusLine.ofDecoded(Stream.fromIterable(frames)).pipe(
    Effect.map(({ poll, push }) =>
      [
        ...poll.map((line) => ({ file: "poll" as const, line })),
        ...push.map((line) => ({ file: "push" as const, line }))
      ].toSorted((a, b) => CorpusLine.byArrival(a.line, b.line))
    )
  )
}

/** Each frame's deliveries, read back from its lines. */
function deliveriesOf(lines: ReadonlyArray<CorpusLine>) {
  return CorpusLine.decodedOf(lines).pipe(
    Stream.map(({ deliveries }) => deliveries),
    Stream.runCollect
  )
}

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

/** A game's plays, then the same without its first play. */
function droppingFirst() {
  return [
    decoded(1, [Delivery.cases.Plays.make({ game, plays: [first, second] })]),
    decoded(2, [Delivery.cases.Plays.make({ game, plays: [second] })])
  ]
}
