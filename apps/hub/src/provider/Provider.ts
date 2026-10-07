import type { GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Context, Data, type Effect, type Schedule, Schema, type Stream } from "effect"
import type { FeedFrame } from "../Frame.ts"

/**
 * A provider of game data: its scoreboard polled as frames, its live feed pushing frames between polls, when it is
 * polled again, and how its push is reconnected. What those frames say is its `Decoder`'s, which its adapter provides
 * beside it.
 */
export class Provider extends Context.Service<
  Provider,
  {
    /** One poll of `league`, as received. */
    poll(league: LeagueId): Effect.Effect<FeedFrame, ProviderUnavailable>
    /** Its live feed. */
    readonly push: LiveFeed
    /**
     * When to poll again, given what the last poll left: the slate's games for the polled leagues, and the leagues that
     * failed. Ingest runs `poll` for each league repeated on it, and nothing else decides when.
     */
    readonly polling: Polling
    /** How its push is subscribed to again after it fails. Ingest retries the push on it, and nothing else does. */
    readonly reconnect: Schedule.Schedule<unknown, ProviderUnavailable>
  }
>()("sportal/hub/provider/Provider") {}

/**
 * A provider's push: every pushed frame, as received, for its leagues' scoreboards and for each game `demand` last
 * named, with each channel it resyncs asked for its checkpoint again if the push follows it. Fails when the push cannot
 * go on.
 */
export type LiveFeed = (
  demand: Stream.Stream<LiveFeedDemand>
) => Stream.Stream<FeedFrame, ProviderUnavailable>

/**
 * What the live feed should follow: the current games, whenever which games they are changes, and each channel whose
 * document must be read again from a checkpoint.
 */
export type LiveFeedDemand = Data.TaggedEnum<{
  Games: { readonly games: ReadonlyArray<GameSnapshot> }
  Resync: { readonly channel: string }
}>
export const LiveFeedDemand = Data.taggedEnum<LiveFeedDemand>()

/** When a provider is polled again, given the slate the last poll left and the leagues that failed in it. */
export type Polling = Schedule.Schedule<
  unknown,
  { readonly slate: ReadonlyArray<GameSnapshot>; readonly failed: ReadonlyArray<LeagueId> }
>

/**
 * A provider could not supply data: unreachable or refused for a poll of `league`, or a push refused, closed, or gone
 * silent (a push serves every league, so it has none).
 */
export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()("ProviderUnavailable", {
  reason: Schema.Literals(["Unreachable", "Refused", "Closed", "Silent"]),
  league: Schema.optional(LeagueId),
  cause: Schema.Defect()
}) {}
