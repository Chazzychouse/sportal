import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import type { GameEvent } from "@sportal/domain/GameEvent"
import type { SlateObservation } from "@sportal/domain/Slate"
import { Chunk, Effect, Schema, Stream } from "effect"
import * as TestSnapshotFeed from "../TestSnapshotFeed.ts"
import { Archive } from "./Archive.ts"
import { CorpusDay, CorpusDays } from "./CorpusDay.ts"
import { CorpusLine } from "./CorpusInput.ts"
import * as CorpusRun from "./CorpusRun.ts"
import * as Synthesis from "./Synthesis.ts"
import { inArchive, inCorpus, local, stepped } from "./TestCorpus.ts"

// NE–BUF of 2026-10-04 from ESPN's archive (its recorded scoreboard and summary), the only game of the day with plays.
const archived = inArchive({}, () => stepped(Archive.use((archive) => archive.games("nfl", "2026-10-04"))))

// The day synthesized from it, as committed: read by eye against the synthesis's rules before it was.
const golden = (file: "poll" | "push") =>
  readFileSync(new URL(`./fixtures/2026-10-04-ne-buf.${file}.ndjson`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)

const encodeLine = Schema.encodeSync(Schema.fromJsonString(CorpusLine))

describe("Synthesis.day", () => {
  it.effect("synthesizes NE–BUF's day as its golden poll and push files, line for line", () =>
    Effect.gen(function* () {
      const { poll, push } = yield* Synthesis.day(yield* archived)

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

  it.effect(
    "numbers its frames 1 to n with no gaps, in arrival order, a push before a poll at one instant",
    () =>
      Effect.gen(function* () {
        const { poll, push } = yield* Synthesis.day(yield* archived)
        const lines = [...push, ...poll].toSorted(CorpusLine.byArrival)
        const seqs = [...new Set(lines.map(({ seq }) => seq))]

        assert.deepStrictEqual(
          seqs,
          Array.from({ length: seqs.length }, (_, i) => i + 1)
        )
        assert.deepStrictEqual(push, push.toSorted(CorpusLine.byArrival))
        assert.deepStrictEqual(poll, poll.toSorted(CorpusLine.byArrival))
        const pushedAt = new Map(push.map(({ at, seq }) => [at.epochMilliseconds, seq]))
        assert.isTrue(
          poll.every(({ at, seq }) => (pushedAt.get(at.epochMilliseconds) ?? 0) < seq),
          "a poll at a push's instant comes after it"
        )
        assert.isTrue(pushedAt.size > 0 && poll.some(({ at }) => pushedAt.has(at.epochMilliseconds)))
      })
  )

  it.effect(
    "plays sensibly through a corpus run: the scores add up, halftime and the final come once, nothing stalls",
    () =>
      Effect.gen(function* () {
        const games = yield* archived
        const { poll, push } = yield* Synthesis.day(games)
        const [game] = games
        assert.isDefined(game)

        const run = yield* inCorpus(TestSnapshotFeed.decoder, () =>
          Effect.gen(function* () {
            yield* (yield* CorpusDays).write(
              new CorpusDay({
                date: "2026-10-04",
                kind: "backfilled",
                format: CorpusLine.format,
                leagues: ["nfl"],
                games: 1,
                built: local("2026-10-07T12:00:00")
              }),
              { poll: Stream.fromIterable(poll), push: Stream.fromIterable(push) }
            )
            return yield* CorpusRun.day("2026-10-04", kept)
          })
        )

        const scored = (team: string) =>
          run.events
            .flatMap(({ what }) => (what._tag === "ScoreChanged" && what.team === team ? [what.points] : []))
            .reduce((a, b) => a + b, 0)
        const told = (tag: GameEvent["what"]["_tag"]) =>
          run.events.filter(({ what }) => what._tag === tag).length
        assert.deepStrictEqual(
          [scored(game.final.home.team.id), scored(game.final.away.team.id)],
          [game.final.home.score, game.final.away.score]
        )
        assert.deepStrictEqual(
          [told("WentToHalftime"), told("WentFinal"), told("Played")],
          [1, 1, game.plays.length]
        )
        assert.isTrue(told("TimeoutTaken") > 0)
        assert.deepStrictEqual(
          run.observations.flatMap((observation) =>
            observation._tag === "Took" &&
            (observation.outcome === "held" || observation.outcome === "fellBack")
              ? [observation.outcome]
              : []
          ),
          []
        )
      }),
    { timeout: 60_000 }
  )
})

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
