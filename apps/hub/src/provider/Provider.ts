import type { Delivery } from "@sportal/domain/Delivery"
import { LeagueId } from "@sportal/domain/League"
import { Context, type DateTime, type Effect, Schema, type Stream } from "effect"
import type { Frame } from "../feed/Frame.ts"

/** A provider's scoreboard: polled as frames, and what those and its live feed's frames say, decoded. */
export class Provider extends Context.Service<
  Provider,
  {
    /** One poll of `league`, as received. */
    poll(league: LeagueId): Effect.Effect<Omit<Frame, "seq">, ProviderError>
    /**
     * What each frame said, in order: a poll response is a `Listing`, a pushed game a `Snapshot`, a plays document
     * change a `Plays`, each `Delivered`. A live feed topic whose document had to be dropped (a missed message, a
     * patch that will not apply) is a `Resync` of its channel, so the live feed can ask for its checkpoint again. Each
     * carries the `seq` of the frame that said it. A frame that does not decode is logged with its `seq`, counted, and
     * skipped.
     */
    decode(frames: Stream.Stream<Frame>): Stream.Stream<
      | {
          readonly _tag: "Delivered"
          readonly delivery: Delivery
          readonly at: DateTime.Utc
          readonly seq: number
        }
      | { readonly _tag: "Resync"; readonly channel: string; readonly seq: number }
    >
  }
>()("sportal/hub/Provider") {}

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  league: LeagueId,
  cause: Schema.Defect()
}) {}
