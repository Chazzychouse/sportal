import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import type { Play } from "@sportal/domain/Play"
import { Context, Data, Deferred, Effect, Layer, Option, Queue, Ref, Stream } from "effect"

/**
 * A provider of game data. It runs itself: it decides when to poll, what to follow on its push, and when to reconnect,
 * and reads each frame it receives with its own decode. Nothing tells it what to do.
 */
export class Provider extends Context.Service<
  Provider,
  {
    /**
     * What each frame it receives said, as its deliveries in the order the frame said them, one array per frame, in
     * the order received, for as long as it runs. Never fails.
     */
    readonly deliveries: Stream.Stream<ReadonlyArray<Delivery>>
  }
>()("sportal/hub/provider/Provider") {
  /** A provider whose frames said `deliveries`. */
  static layerTest(deliveries: Stream.Stream<ReadonlyArray<Delivery>>): Layer.Layer<Provider> {
    return Layer.succeed(Provider, Provider.of({ deliveries }))
  }

  /** A provider whose frames say what a test gives its `ProviderFeed`, and that feed. */
  static readonly layerTestFed: Layer.Layer<Provider | ProviderFeed> = Layer.effectContext(
    Effect.gen(function* () {
      const frames = yield* Queue.unbounded<{
        readonly deliveries: ReadonlyArray<Delivery>
        readonly taken: Deferred.Deferred<void>
      }>()
      const reading = yield* Ref.make(Option.none<Deferred.Deferred<void>>())

      // Each pull first marks the frame before it taken: the reader asks for the next only once it has taken that one.
      const next = Effect.gen(function* () {
        const previous = yield* Ref.get(reading)
        yield* Effect.forEach(Option.toArray(previous), (taken) => Deferred.succeed(taken, undefined))
        const frame = yield* Queue.take(frames)
        yield* Ref.set(reading, Option.some(frame.taken))
        return frame.deliveries
      })

      const deliver = Effect.fnUntraced(function* (deliveries: ReadonlyArray<Delivery>) {
        const taken = yield* Deferred.make<void>()
        yield* Queue.offer(frames, { deliveries, taken })
        yield* Deferred.await(taken)
      })

      return Context.make(ProviderFeed, ProviderFeed.of({ deliver })).pipe(
        Context.add(Provider, Provider.of({ deliveries: Stream.fromEffectRepeat(next) }))
      )
    })
  )
}

/** What a frame said: a league's listing, one game's snapshot, or one game's whole list of plays. */
export type Delivery = Data.TaggedEnum<{
  Listing: { readonly league: LeagueId; readonly games: ReadonlyArray<GameSnapshot> }
  Snapshot: { readonly snapshot: GameSnapshot }
  Plays: { readonly game: GameId; readonly plays: ReadonlyArray<Play> }
}>
export const Delivery = Data.taggedEnum<Delivery>()

/** What a test gives `Provider.layerTestFed`'s provider to say. */
export class ProviderFeed extends Context.Service<
  ProviderFeed,
  {
    /** One frame saying `deliveries`; returns once the provider's reader has taken it and asked for the next. */
    deliver(deliveries: ReadonlyArray<Delivery>): Effect.Effect<void>
  }
>()("sportal/hub/provider/ProviderFeed") {}
