import { Delivery } from "@sportal/domain/Delivery"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import type { FeedFrame } from "../../Frame.ts"
import { type Polling, Provider, type ProviderError } from "../Provider.ts"
import { SnapshotPayload } from "./SnapshotPayload.ts"

/**
 * A provider whose frames are our own deliveries, read back by `SnapshotDecode`. A poll of a league is `games(league)`
 * as a frame on that league's channel whose body is its `Listing`. It pushes `push`'s frames, none by default, and is
 * polled on `polling`.
 */
export function layer(options: {
  readonly games: (league: LeagueId) => Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderError>
  readonly push?: Stream.Stream<FeedFrame, ProviderError>
  readonly polling: Polling
}): Layer.Layer<Provider> {
  return Layer.succeed(
    Provider,
    Provider.of({
      poll: (league) =>
        Effect.all({ games: options.games(league), receivedAt: DateTime.now }).pipe(
          Effect.map(
            ({ games, receivedAt }): FeedFrame => ({
              receivedAt,
              feed: "snapshot",
              channel: league,
              kind: "response",
              body: encodePayload(Delivery.cases.Listing.make({ league, games }))
            })
          )
        ),
      push: () => options.push ?? Stream.never,
      polling: options.polling
    })
  )
}

const encodePayload = Schema.encodeSync(SnapshotPayload)
