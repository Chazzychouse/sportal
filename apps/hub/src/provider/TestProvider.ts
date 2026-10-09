import type { LeagueId } from "@sportal/domain/League"
import { Effect, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Delivery, Provider } from "./Provider.ts"

/**
 * The games the provided `Provider`'s first listing of `league` lists. It waits on the live clock for at most 2
 * seconds, so a provider whose first poll of `league` failed fails the test, saying so, rather than hanging it.
 */
export const listedBy = Effect.fn("TestProvider.listedBy")(function* (league: LeagueId) {
  const provider = yield* Provider
  const listing = yield* provider.deliveries.pipe(
    Stream.flatMap(Stream.fromIterable),
    Stream.filter(Delivery.$is("Listing")),
    Stream.filter((delivery) => delivery.league === league),
    Stream.runHead,
    Effect.raceFirst(
      Effect.sleep("2 seconds").pipe(
        TestClock.withLive,
        Effect.andThen(
          Effect.die(new Error(`the provider delivered no listing of ${league} within 2 seconds`))
        )
      )
    )
  )

  return Option.match(listing, { onNone: () => [], onSome: ({ games }) => games })
})
