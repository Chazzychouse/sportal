import { assert, describe, it } from "@effect/vitest"
import { Delivery } from "@sportal/domain/Delivery"
import { liveSnapshot, snapshot } from "@sportal/domain/TestGame"
import { Effect, Exit, Schedule, Schema } from "effect"
import { Provider, ProviderError } from "../Provider.ts"
import { SnapshotPayload } from "./SnapshotPayload.ts"
import * as SnapshotProvider from "./SnapshotProvider.ts"

describe("SnapshotProvider", () => {
  it.effect("a poll's frame is a Listing of the games of that league, on its channel", () =>
    Effect.gen(function* () {
      const nfl = [liveSnapshot()]
      const provider = yield* Provider
      const frame = yield* provider.poll("nfl")
      assert.deepStrictEqual([frame.feed, frame.kind, frame.channel], ["snapshot", "response", "nfl"])
      assert.deepStrictEqual(
        yield* Schema.decodeEffect(SnapshotPayload)(frame.body),
        Delivery.cases.Listing.make({ league: "nfl", games: nfl })
      )
    }).pipe(
      Effect.provide(
        SnapshotProvider.layer({
          games: (league) => Effect.succeed(league === "nfl" ? [liveSnapshot()] : [snapshot()]),
          polling: Schedule.spaced("10 seconds")
        })
      )
    )
  )

  it.effect("`games` that fails fails the poll with its ProviderError", () =>
    Effect.gen(function* () {
      const error = new ProviderError({ reason: "Refused", league: "fbs", cause: "no" })
      const exit = yield* Effect.exit(Provider.use((provider) => provider.poll("fbs"))).pipe(
        Effect.provide(
          SnapshotProvider.layer({ games: () => Effect.fail(error), polling: Schedule.spaced("10 seconds") })
        )
      )
      assert.deepStrictEqual(exit, Exit.fail(error))
    })
  )

  it.effect("its polling is the given Schedule", () => {
    const polling = Schedule.spaced("3 seconds")
    return Effect.gen(function* () {
      assert.strictEqual((yield* Provider).polling, polling)
    }).pipe(Effect.provide(SnapshotProvider.layer({ games: () => Effect.succeed([]), polling })))
  })
})
