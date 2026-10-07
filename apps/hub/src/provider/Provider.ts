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
 * A provider of game data: its scoreboard polled as frames, its live feed pushing frames between polls, when it is
 * polled again, and how its push is reconnected. What those frames say is its `Decoder`'s, which its adapter provides
 * beside it.
 */
export class Provider extends Context.Service<
  Provider,
  {
    /** One poll of `league`, as received. */
    poll(league: LeagueId): Effect.Effect<FeedFrame, ProviderError>
    /** Its live feed. */
    readonly push: LiveFeed
    /**
     * When to poll again, given what the last poll left: the slate's games for the polled leagues, and the leagues that
     * failed. Ingest runs `poll` for each league repeated on it, and nothing else decides when.
     */
    readonly polling: Polling
    /** How its push is subscribed to again after it fails. Ingest retries the push on it, and nothing else does. */
    readonly reconnect: Schedule.Schedule<unknown, ProviderError>
  }
>()("sportal/hub/Provider") {}

/**
 * A provider's push: every pushed frame, as received, for its leagues' scoreboards and for each game `demand` last
 * named, with each channel it resyncs asked for its checkpoint again if the push follows it. Fails when the push cannot
 * go on.
 */
export type LiveFeed = (demand: Stream.Stream<LiveFeedDemand>) => Stream.Stream<FeedFrame, ProviderError>

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
 * What one frame said, as its provider decodes it, one per frame: the deliveries in the order the frame said them, the
 * live feed channels whose document was dropped and so are to be checkpointed again, and what decode observed. A frame
 * that said nothing is a `Decoded` with three empty arrays. It never crosses the wire.
 */
export class Decoded extends Data.Class<{
  readonly seq: number
  /** When the frame was received. */
  readonly at: DateTime.Utc
  readonly deliveries: ReadonlyArray<Delivery>
  readonly resyncs: ReadonlyArray<string>
  readonly observations: ReadonlyArray<DecodeObservation>
}> {
  /** What `frame` said: `of`'s deliveries, resyncs, and observations, each none unless given. */
  static of(
    frame: Frame,
    of: {
      readonly deliveries?: ReadonlyArray<Delivery>
      readonly resyncs?: ReadonlyArray<string>
      readonly observations?: ReadonlyArray<DecodeObservation>
    } = {}
  ): Decoded {
    return new Decoded({
      seq: frame.seq,
      at: frame.receivedAt,
      deliveries: of.deliveries ?? [],
      resyncs: of.resyncs ?? [],
      observations: of.observations ?? []
    })
  }

  /** A frame that did not decode: it says nothing but a `FrameUndecoded` observation of `cause`. */
  static undecodable(frame: Frame, cause: unknown): Decoded {
    return Decoded.of(frame, {
      observations: [
        DecodeObservation.FrameUndecoded({
          feed: frame.feed,
          channel: frame.channel,
          kind: frame.kind,
          cause
        })
      ]
    })
  }
}

/**
 * Something decode observed in a frame, for telemetry to tell: a live feed message received, games pushed, a pushed
 * game no listing has, a topic's document reset, a message of an op it does not know, or a frame, an event, or a play
 * that did not decode, or a play type it does not know. Nothing in it is particular to a sport.
 */
export type DecodeObservation = Data.TaggedEnum<{
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
    readonly reason: "Gap" | "Unapplicable"
    readonly detail: string
  }
  FrameUndecoded: {
    readonly feed: FeedFrame["feed"]
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
export const DecodeObservation = Data.taggedEnum<DecodeObservation>()

/**
 * A provider could not supply data: unreachable or refused for a poll of `league`, or a push refused, closed, or gone
 * silent (a push serves every league, so it has none).
 */
export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  reason: Schema.Literals(["Unreachable", "Refused", "Closed", "Silent"]),
  league: Schema.optional(LeagueId),
  cause: Schema.Defect()
}) {}
