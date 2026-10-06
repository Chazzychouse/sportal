import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Context, Schema, type Stream } from "effect"
import type { Frame } from "../feed-log/Frame.ts"

/** A provider's push connection, carrying updates for live games between polls. */
export class LiveFeed extends Context.Service<
  LiveFeed,
  {
    /**
     * Every frame, as received, for the leagues' scoreboards and for each game in `wanted` (the current games). Each
     * channel in `resync` is asked for its checkpoint again, if this connection follows it. Fails when the connection
     * cannot go on.
     */
    frames(
      leagues: ReadonlyArray<LeagueId>,
      wanted: Stream.Stream<ReadonlyArray<GameSnapshot>>,
      resync: Stream.Stream<string>
    ): Stream.Stream<Omit<Frame, "seq">, LiveFeedError>
  }
>()("sportal/hub/LiveFeed") {}

/** The live feed's connection could not continue: refused, closed, or silent. */
export class LiveFeedError extends Schema.TaggedError<LiveFeedError>()("LiveFeedError", {
  reason: Schema.Literals(["Refused", "Closed", "Silent"]),
  cause: Schema.Defect()
}) {}
