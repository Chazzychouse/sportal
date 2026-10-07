import { assert, describe, it } from "@effect/vitest"
import type { GameEvent } from "@sportal/domain/GameEvent"
import type { SlateObservation } from "@sportal/domain/SlateObservation"
import { Chunk, Context, Effect, Layer, Schema, Stream } from "effect"
import { inArchive, stepped } from "../provider/espn/TestEspnArchive.ts"
import * as TestSnapshotFeed from "../TestSnapshotFeed.ts"
import { Archive, type ArchivedGame } from "./Archive.ts"
import { CorpusDay, CorpusDays } from "./CorpusDay.ts"
import { CorpusLine } from "./CorpusInput.ts"
import * as CorpusRun from "./CorpusRun.ts"
import * as Synthesis from "./Synthesis.ts"
import { golden, inCorpus, local } from "./TestCorpus.ts"

describe("Synthesis.day", () => {
  // NE–BUF's archived day is synthesized once for every test, and run once for the tests of its run.
  it.layer(neBufSynthesizedLayer())("NE–BUF's archived day", (it) => {
    it.effect("should synthesize NE–BUF's day as its golden poll and push files, line for line", () =>
      Effect.gen(function* () {
        const { poll, push } = yield* NeBufSynthesized

        assert.deepStrictEqual(
          push.map((line) => encodeLine(line)),
          golden("push")
        )
        assert.deepStrictEqual(
          poll.map((line) => encodeLine(line)),
          golden("poll")
        )
      })
    )

    it.effect("should number its frames 1 to n with no gaps", () =>
      Effect.gen(function* () {
        const { poll, push } = yield* NeBufSynthesized

        const lines = [...push, ...poll].toSorted(CorpusLine.byArrival)
        const seqs = [...new Set(lines.map(({ seq }) => seq))]

        assert.deepStrictEqual(
          seqs,
          Array.from({ length: seqs.length }, (_, i) => i + 1)
        )
      })
    )

    it.effect("should give each file's lines in arrival order", () =>
      Effect.gen(function* () {
        const { poll, push } = yield* NeBufSynthesized

        assert.deepStrictEqual(push, push.toSorted(CorpusLine.byArrival))
        assert.deepStrictEqual(poll, poll.toSorted(CorpusLine.byArrival))
      })
    )

    it.effect("should number a push before a poll at the same instant", () =>
      Effect.gen(function* () {
        const { poll, push } = yield* NeBufSynthesized

        const pushedAt = new Map(push.map(({ at, seq }) => [at.epochMilliseconds, seq]))

        assert.isTrue(
          poll.every(({ at, seq }) => (pushedAt.get(at.epochMilliseconds) ?? 0) < seq),
          "a poll at a push's instant comes after it"
        )
        assert.isTrue(pushedAt.size > 0 && poll.some(({ at }) => pushedAt.has(at.epochMilliseconds)))
      })
    )

    it.layer(neBufRunLayer())("played through a corpus run", (it) => {
      it.effect("should add each team's scores up to its final", () =>
        Effect.gen(function* () {
          const { games } = yield* NeBufSynthesized
          const run = yield* NeBufRun
          const [game] = games
          assert.isDefined(game)

          const scored = (team: string) =>
            run.events
              .flatMap(({ what }) =>
                what._tag === "ScoreChanged" && what.team === team ? [what.points] : []
              )
              .reduce((a, b) => a + b, 0)

          assert.deepStrictEqual(
            [scored(game.final.home.team.id), scored(game.final.away.team.id)],
            [game.final.home.score, game.final.away.score]
          )
        })
      )

      it.effect("should go to halftime and final once each, and play every play", () =>
        Effect.gen(function* () {
          const { games } = yield* NeBufSynthesized
          const run = yield* NeBufRun
          const [game] = games
          assert.isDefined(game)

          const told = toldOf(run.events)

          assert.deepStrictEqual(
            [told("WentToHalftime"), told("WentFinal"), told("Played")],
            [1, 1, game.plays.length]
          )
        })
      )

      it.effect("should tell a timeout taken", () =>
        Effect.gen(function* () {
          const run = yield* NeBufRun

          const told = toldOf(run.events)

          assert.isTrue(told("TimeoutTaken") > 0)
        })
      )

      it.effect("should stall nothing, holding no snapshot and falling back to none", () =>
        Effect.gen(function* () {
          const run = yield* NeBufRun

          const stalled = run.observations.flatMap((observation) =>
            observation._tag === "Took" &&
            (observation.outcome === "held" || observation.outcome === "fellBack")
              ? [observation.outcome]
              : []
          )

          assert.deepStrictEqual(stalled, [])
        })
      )
    })
  })
})

/** NE–BUF of 2026-10-04 from ESPN's archive, the only game of the day with plays, and the day synthesized from it. */
class NeBufSynthesized extends Context.Service<
  NeBufSynthesized,
  {
    readonly games: ReadonlyArray<ArchivedGame>
    readonly poll: ReadonlyArray<CorpusLine>
    readonly push: ReadonlyArray<CorpusLine>
  }
>()("test/NeBufSynthesized") {}

function neBufSynthesizedLayer() {
  return Layer.effect(
    NeBufSynthesized,
    Effect.gen(function* () {
      const games = yield* archived

      const { poll, push } = yield* Synthesis.day(games)

      return { games, poll, push }
    })
  )
}

// NE–BUF of 2026-10-04 from ESPN's archive (its recorded scoreboard and summary), the only game of the day with plays.
const archived = inArchive({}, () => stepped(Archive.use((archive) => archive.games("nfl", "2026-10-04"))))

const encodeLine = Schema.encodeSync(Schema.fromJsonString(CorpusLine))

/** The synthesized NE–BUF day's events and observations, in order, as a corpus run of it gives them. */
class NeBufRun extends Context.Service<
  NeBufRun,
  { readonly events: ReadonlyArray<GameEvent>; readonly observations: ReadonlyArray<SlateObservation> }
>()("test/NeBufRun") {}

function neBufRunLayer() {
  return Layer.effect(
    NeBufRun,
    Effect.gen(function* () {
      const { poll, push } = yield* NeBufSynthesized

      return yield* inCorpus(TestSnapshotFeed.decoder, () =>
        Effect.gen(function* () {
          const days = yield* CorpusDays
          const day = new CorpusDay({
            date: "2026-10-04",
            kind: "backfilled",
            format: CorpusLine.format,
            leagues: ["nfl"],
            games: 1,
            built: local("2026-10-07T12:00:00")
          })

          yield* days.write(day, { poll: Stream.fromIterable(poll), push: Stream.fromIterable(push) })

          return yield* CorpusRun.day("2026-10-04", kept)
        })
      )
    })
  )
}

/** How many of `events` are of the kind `tag`. */
function toldOf(events: ReadonlyArray<GameEvent>) {
  return (tag: GameEvent["what"]["_tag"]) => events.filter(({ what }) => what._tag === tag).length
}

// The day's events and observations both, in order.
const kept: CorpusRun.Subject<
  { readonly events: Chunk.Chunk<GameEvent>; readonly observations: Chunk.Chunk<SlateObservation> },
  { readonly events: ReadonlyArray<GameEvent>; readonly observations: ReadonlyArray<SlateObservation> }
> = {
  initial: { events: Chunk.empty(), observations: Chunk.empty() },
  step: (seen, { events, observations }) => ({
    events: Chunk.appendAll(seen.events, Chunk.fromIterable(events)),
    observations: Chunk.appendAll(seen.observations, Chunk.fromIterable(observations))
  }),
  done: ({ events, observations }) => ({
    events: Chunk.toReadonlyArray(events),
    observations: Chunk.toReadonlyArray(observations)
  })
}
