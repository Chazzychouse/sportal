import type { GameSnapshot } from "@sportal/domain/Game"
import { DateTime, Effect, Option, Stream } from "effect"
import { Source } from "./Source.ts"

/** The source's availability as it is now, at the clock's time. */
export const availabilityNow = Effect.gen(function* () {
  const source = yield* Source
  const now = yield* DateTime.now

  const latest = yield* Stream.runHead(source.availability)
  const availabilityOf = Option.getOrThrow(latest)
  return (game: GameSnapshot) => availabilityOf(game, now)
})
