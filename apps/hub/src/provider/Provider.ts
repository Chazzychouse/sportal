import type { Delivery } from "@sportal/domain/Delivery"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import {
  Context,
  Data,
  type DateTime,
  type Effect,
  type Option,
  type Schedule,
  Schema,
  type Stream
} from "effect"
import type { FeedFrame, Frame } from "../Frame.ts"

/**
 * A provider of game data: its scoreboard polled as frames, its live feed pushing frames between polls, what those
 * frames say, decoded, and when it is polled again.
 */
export class Provider extends Context.Service<
  Provider,
  {
    /** One poll of `league`, as received. */
    poll(league: LeagueId): Effect.Effect<FeedFrame, ProviderError>
    /**
     * Every pushed frame, as received, for the leagues' scoreboards and for each game in `wanted` (the current games).
     * Each channel in `resync` is asked for its checkpoint again, if the push follows it. Fails when the push cannot go
     * on.
     */
    push(
      leagues: ReadonlyArray<LeagueId>,
      wanted: Stream.Stream<ReadonlyArray<GameSnapshot>>,
      resync: Stream.Stream<string>
    ): Stream.Stream<FeedFrame, ProviderError>
    /**
     * What each frame said, in order: a poll response is a `Listing`, a pushed game a `Snapshot`, a plays document
     * change a `Plays`, each `Delivered`. A live feed topic whose document had to be dropped (a missed message, a
     * patch that will not apply) is a `Resync` of its channel, so the live feed can ask for its checkpoint again.
     * Anything decode noticed, a frame that does not decode among it, is `Noted`. Each carries the `seq` of the frame
     * that said it. Never fails, logs, or counts.
     */
    decode(frames: Stream.Stream<Frame>): Stream.Stream<Decoded>
    /**
     * When to poll again, given what the last poll left: the fold's slate for the polled leagues, and the leagues that
     * failed. Ingest runs `poll` for each league repeated on it, and nothing else decides when.
     */
    readonly polling: Schedule.Schedule<
      unknown,
      { readonly slate: ReadonlyArray<GameSnapshot>; readonly failed: ReadonlyArray<LeagueId> }
    >
  }
>()("sportal/hub/Provider") {}

/** What one frame said: a delivery, a live feed channel to resync, or something decode noticed. */
export type Decoded = Data.TaggedEnum<{
  Delivered: { readonly delivery: Delivery; readonly at: DateTime.Utc; readonly seq: number }
  Resync: { readonly channel: string; readonly seq: number }
  Noted: { readonly notice: Notice; readonly seq: number }
}>
export const Decoded = Data.taggedEnum<Decoded>()

/**
 * Something decode noticed in a frame, for telemetry to tell: a live feed message received, games pushed, a pushed
 * game no listing has, a topic's document reset, a message of an op it does not know, or a frame, an event, or a play
 * that did not decode, or a play type it does not know. Nothing in it is particular to a sport.
 */
export type Notice = Data.TaggedEnum<{
  Received: {
    readonly league: Option.Option<LeagueId>
    readonly op: string
    readonly topic: Option.Option<string>
    readonly mid: Option.Option<number>
  }
  OpUnknown: { readonly body: string }
  Pushed: { readonly league: LeagueId; readonly games: number }
  Unlisted: { readonly league: LeagueId; readonly game: GameId }
  Reset: {
    readonly league: LeagueId
    readonly topic: string
    readonly reason: "Gap" | "Unapplicable" | "Unreadable"
    readonly detail: string
  }
  FrameUndecoded: {
    readonly feed: "poll" | "fastcast"
    readonly channel: string
    readonly kind: string
    readonly cause: unknown
  }
  EventUndecoded: { readonly league: LeagueId; readonly feed: "poll" | "fastcast"; readonly cause: unknown }
  PlayUndecoded: {
    readonly league: LeagueId
    readonly game: GameId
    readonly play: string
    readonly cause: unknown
  }
  PlayTypeUnknown: { readonly id: string; readonly text: string }
}>
export const Notice = Data.taggedEnum<Notice>()

/**
 * A provider could not supply data: unreachable or refused for a poll of `league`, or a push refused, closed, or gone
 * silent (a push serves every league, so it has none).
 */
export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  reason: Schema.Literals(["Unreachable", "Refused", "Closed", "Silent"]),
  league: Schema.optional(LeagueId),
  cause: Schema.Defect()
}) {}
