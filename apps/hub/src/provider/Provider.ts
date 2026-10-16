import type { CalendarDate } from "@sportal/api/GamesQuery"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import type { Play } from "@sportal/domain/Play"
import { type Cause, Context, Data, Effect, Layer, Queue, Schema, Stream } from "effect"

/**
 * A provider of game data. It runs itself: it decides when to poll, what to follow on its push, and when to reconnect,
 * and reads each frame it receives with its own decode. Nothing tells it what to do.
 */
export class Provider extends Context.Service<
  Provider,
  {
    /**
     * What the frames it receives said, one delivery each, in the order received, for as long as it runs; a frame that
     * says nothing delivers nothing. Never fails.
     */
    readonly deliveries: Stream.Stream<Delivery>
    /** Every game of day `date` in every league it serves, as its scoreboard for that day lists them. */
    readonly listing: (date: CalendarDate) => Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderUnavailable>
    /** Game `game` of `league`'s plays so far, in `Play.order`, read from its summary. */
    readonly plays: (
      league: LeagueId,
      game: GameId
    ) => Effect.Effect<ReadonlyArray<Play>, ProviderUnavailable>
  }
>()("sportal/hub/provider/Provider") {
  /**
   * A provider whose frames are what a test offers `frames`, each saying its deliveries, taken one at a time: it takes
   * the next only once its reader has taken what the one before said. They end when `frames` ends. `answers` gives its
   * listings and plays; each not given fails as unavailable.
   */
  static layerTest(
    frames: Queue.Dequeue<ReadonlyArray<Delivery>, Cause.Done>,
    answers: Partial<Pick<Provider["Service"], "listing" | "plays">> = {}
  ): Layer.Layer<Provider> {
    return Layer.succeed(
      Provider,
      Provider.of({
        deliveries: Stream.fromEffectRepeat(Queue.take(frames)).pipe(Stream.flattenIterable),
        listing: () =>
          Effect.fail(new ProviderUnavailable({ reason: "Unanswered", cause: "No listing in this test" })),
        plays: () =>
          Effect.fail(new ProviderUnavailable({ reason: "Unanswered", cause: "No plays in this test" })),
        ...answers
      })
    )
  }
}

/** What a frame said: a league's listing, or one game's whole list of plays. */
export type Delivery = Data.TaggedEnum<{
  Listing: { readonly league: LeagueId; readonly games: ReadonlyArray<GameSnapshot> }
  Plays: { readonly game: GameId; readonly plays: ReadonlyArray<Play> }
}>
export const Delivery = Data.taggedEnum<Delivery>()

/**
 * The provider could not be followed or asked: FastCast refused, closed, or went silent (`FastCast` logs it and opens
 * the socket again), or a request for a listing or plays went `Unanswered`.
 */
export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()("ProviderUnavailable", {
  reason: Schema.Literals(["Refused", "Closed", "Silent", "Unanswered"]),
  cause: Schema.Defect()
}) {}
