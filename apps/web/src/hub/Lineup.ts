import { Duration, Effect, Schedule, Stream } from "effect"
import { Atom } from "effect/reactivity"
import { runtime } from "../WebRuntime.ts"
import { HubClient } from "./HubClient.ts"

/** One asking of the lineup, retried every minute until it succeeds. */
const askLineup = Effect.gen(function* () {
  const hub = yield* HubClient
  return yield* hub.lineup
}).pipe(Effect.retry(Schedule.spaced(Duration.minutes(1))))

/**
 * Every source's sports channels and what airs on them: asked while read and again every minute, so what is on now
 * stays current. A failed asking keeps the last answer and is asked again a minute later.
 */
export const lineup = runtime
  .atom(Stream.fromEffectSchedule(askLineup, Schedule.spaced(Duration.minutes(1))))
  .pipe(Atom.setIdleTTL(Duration.minutes(1)))
