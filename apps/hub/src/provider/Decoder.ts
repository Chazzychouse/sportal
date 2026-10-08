import type { Delivery } from "@sportal/domain/Delivery"
import type { GameId } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Context, Data, type DateTime, Effect, Layer, type Option, Stream } from "effect"
import type { Frame, LoggedFrame } from "../Frame.ts"

/**
 * A provider's decode on its own: what each frame it delivered said. Its adapter provides it as a layer of its own, and
 * `HubMode` pairs it with its provider, so a recorded scenario decodes its frames as the provider that recorded them
 * would.
 */
export class Decoder extends Context.Service<
  Decoder,
  {
    /**
     * What each frame said: exactly one `Decoded` per frame, in the frames' order, never waiting on a later frame
     * (Ingest's `through` has no timeout, so polling depends on it), and never failing, logging or counting. A decode may
     * read frames ahead of what it has emitted. A poll response is a `Listing`, a pushed game a `Snapshot`, a plays
     * document change a `Plays`; a live feed topic whose document had to be dropped is a resync of its channel.
     */
    decode(frames: Stream.Stream<LoggedFrame>): Stream.Stream<Decoded>
  }
>()("sportal/hub/provider/Decoder") {
  /** The `Decoder` provided beside it, dying at a frame whose body is `body`. */
  static layerTestDying(body: string): Layer.Layer<Decoder, never, Decoder> {
    return Layer.effect(
      Decoder,
      Effect.map(Decoder, (decoder) =>
        Decoder.of({
          decode: (frames) =>
            decoder.decode(
              frames.pipe(
                Stream.tap((frame) => (frame.body === body ? Effect.die("decode died") : Effect.void))
              )
            )
        })
      )
    )
  }
}

/**
 * What one frame said: the deliveries in the order the frame said them, the live feed channels whose document was
 * dropped and so are to be checkpointed again, and what decode observed. A frame that said nothing is a `Decoded` with
 * three empty arrays. It never crosses the wire.
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
    frame: LoggedFrame,
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
  static undecodable(frame: LoggedFrame, cause: unknown): Decoded {
    return Decoded.of(frame, {
      observations: [
        DecodeObservation.FrameUndecoded({
          source: frame.source,
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
    readonly reason: ResetReason
    readonly detail: string
  }
  FrameUndecoded: {
    readonly source: Frame["source"]
    readonly channel: string
    readonly kind: string
    readonly cause: unknown
  }
  EventUndecoded: { readonly league: LeagueId; readonly source: Frame["source"]; readonly cause: unknown }
  PlayUndecoded: {
    readonly league: LeagueId
    readonly game: GameId
    readonly play: string
    readonly cause: unknown
  }
  PlayTypeUnknown: { readonly id: string; readonly text: string }
}>
export const DecodeObservation = Data.taggedEnum<DecodeObservation>()

/** Why a live feed topic's document was reset: a message was missed, or one would not apply to it. */
export type ResetReason = "Gap" | "Unapplicable"
