import type { GameEvent } from "@sportal/domain/GameEvent"
import { Slate, type Taken } from "@sportal/domain/Slate"
import { Chunk, type DateTime, Effect, Stream } from "effect"
import { CorpusDay, CorpusDays, type CorpusDayUnreadable } from "./CorpusDay.ts"

/**
 * Plays corpus day `date` through the slate on virtual time: each frame taken at its `at`, which first ticks every
 * instant due before it, then a tick to the next day's start. No clock runs: the slate's now is always the input's.
 * `subject` steps over each take and the last tick, a `Raised` observation among the rest, and gives what it has at
 * the end.
 */
export function day<S, A>(
  date: string,
  subject: Subject<S, A>
): Effect.Effect<A, CorpusDayUnreadable, CorpusDays | DateTime.CurrentTimeZone> {
  return Effect.gen(function* () {
    const { until } = yield* CorpusDay.bounds(date)
    const { frames } = yield* (yield* CorpusDays).read(date)
    const taken = yield* Stream.runFoldEffect(
      frames,
      () => ({ slate: Slate.empty, state: subject.initial }),
      ({ slate, state }, frame) =>
        Effect.map(slate.take(frame), (step) => ({ slate: step.next, state: subject.step(state, step) }))
    )
    const ended = yield* taken.slate.tick(until)
    return subject.done(subject.step(taken.state, ended))
  })
}

/** What a run plays a day through: a pure step over each take or tick of the slate, and what it gives at the end. */
export type Subject<S, A> = {
  readonly initial: S
  readonly step: (state: S, taken: Taken) => S
  readonly done: (state: S) => A
}

/** The subject this spec runs: the day's game events, in order. */
export const events: Subject<Chunk.Chunk<GameEvent>, ReadonlyArray<GameEvent>> = {
  initial: Chunk.empty(),
  step: (seen, { events }) =>
    events.length === 0 ? seen : Chunk.appendAll(seen, Chunk.fromIterable(events)),
  done: Chunk.toReadonlyArray
}
