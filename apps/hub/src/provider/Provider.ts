import { Delivery } from "@sportal/domain/Delivery"
import { GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Context, DateTime, Effect, Schema, Stream } from "effect"
import type { Frame } from "../feed/Frame.ts"

/** A provider's scoreboard: polled as frames, and what those and its live feed's frames say, decoded. */
export class Provider extends Context.Service<
  Provider,
  {
    slate(league: LeagueId): Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderError>
    /** One poll of `league`, as received. */
    poll(league: LeagueId): Effect.Effect<Omit<Frame, "seq">, ProviderError>
    /**
     * What each frame said, in order: a poll response is a `Listing`, a pushed game a `Snapshot`, a plays document
     * change a `Plays`. A frame that does not decode is logged with its `seq`, counted, and skipped.
     */
    decode(frames: Stream.Stream<Frame>): Stream.Stream<{ delivery: Delivery; at: DateTime.Utc; seq: number }>
  }
>()("sportal/hub/Provider") {
  /**
   * A provider whose poll is `slate`'s games as JSON, and whose decode reads them back as each league's listing. For
   * the scenario provider and test doubles, until Ingest polls through `poll`.
   */
  static fromSlate(
    slate: (league: LeagueId) => Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderError>
  ): Provider["Service"] {
    return Provider.of({
      slate,
      poll: (league) =>
        Effect.all({ games: slate(league), receivedAt: DateTime.now }).pipe(
          Effect.flatMap(({ games, receivedAt }) =>
            encodeGames(games).pipe(
              Effect.map(
                (body) => ({ receivedAt, feed: "poll", channel: league, kind: "response", body }) as const
              ),
              Effect.mapError((cause) => new ProviderError({ league, cause }))
            )
          )
        ),
      decode: (frames) =>
        frames.pipe(
          Stream.filterMapEffect((frame) =>
            Effect.all({ league: decodeLeague(frame.channel), games: decodeGames(frame.body) }).pipe(
              Effect.map(({ league, games }) => ({
                delivery: Delivery.Listing({ league, games }),
                at: frame.receivedAt,
                seq: frame.seq
              })),
              Effect.result
            )
          )
        )
    })
  }
}

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  league: LeagueId,
  cause: Schema.Defect()
}) {}

const Games = Schema.fromJsonString(Schema.Array(GameSnapshot))
const encodeGames = Schema.encodeEffect(Games)
const decodeGames = Schema.decodeUnknownEffect(Games)
const decodeLeague = Schema.decodeUnknownEffect(LeagueId)
