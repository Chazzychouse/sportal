import { type DateTime, Effect, Option } from "effect"
import { Delivery } from "./Delivery.ts"
import type { GameSnapshot } from "./Game.ts"
import { LeagueId } from "./League.ts"
import type { Slate } from "./Slate.ts"

/**
 * `before` after `slate` is polled at `now`: each league's games as one listing in a frame of its own, as Ingest polls.
 * For tests that play a scenario poll by poll.
 */
export function polled(before: Slate, slate: ReadonlyArray<GameSnapshot>, now: DateTime.Utc): Slate {
  return Effect.runSync(
    Effect.reduce(
      LeagueId.literals,
      () => before,
      (held, league) =>
        held
          .take({
            deliveries: [
              Delivery.cases.Listing.make({ league, games: slate.filter((game) => game.league === league) })
            ],
            at: now,
            seq: Option.getOrElse(held.seq, () => 0) + 1
          })
          .pipe(Effect.map(({ next }) => next))
    )
  )
}
