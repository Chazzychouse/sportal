import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Context, Layer, Schema, Stream } from "effect"

/** A provider's push connection, carrying updates for live games between polls. */
export class LiveFeed extends Context.Service<
  LiveFeed,
  {
    /** One element per update: the games it touched, or every game on a checkpoint. Fails when the feed cannot go on. */
    games(leagues: ReadonlyArray<LeagueId>): Stream.Stream<ReadonlyArray<GameSnapshot>, LiveFeedError>
  }
>()("sportal/hub/LiveFeed") {
  /** A live feed that never pushes. */
  static readonly none: Layer.Layer<LiveFeed> = Layer.succeed(
    LiveFeed,
    LiveFeed.of({ games: () => Stream.never })
  )
}

/** The live feed could not continue: refused, closed, silent, a missed message, or an update it could not apply. */
export class LiveFeedError extends Schema.TaggedError<LiveFeedError>()("LiveFeedError", {
  reason: Schema.Literals(["Refused", "Closed", "Silent", "Gap", "Unapplicable"]),
  cause: Schema.Defect()
}) {}
