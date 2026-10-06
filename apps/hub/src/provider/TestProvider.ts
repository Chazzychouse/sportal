import { Delivery } from "@sportal/domain/Delivery"
import { GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { DateTime, Effect, Layer, Option, Ref, Schedule, Schema, Stream } from "effect"
import { type FeedFrame, Frame } from "../Frame.ts"
import { LiveGames } from "../LiveGames.ts"
import { Decoder } from "./Decoder.ts"
import { Decoded, type LiveFeed, type Polling, Provider, ProviderError } from "./Provider.ts"

/**
 * A provider that answers each poll with the next scripted response, and the last one after that, inside a
 * `provider.poll` span, with `decoder` beside it. A `"fail"` response fails the poll, and an empty script fails every
 * poll. Its push and polling are `polling`'s, unless `options` give them.
 */
export function scripted(
  responses: ReadonlyArray<ReadonlyArray<GameSnapshot> | "fail">,
  options: Parameters<typeof polling>[1] = {}
): Layer.Layer<Provider | Decoder> {
  return Layer.merge(
    Layer.effect(
      Provider,
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        return polled(
          (league) =>
            Ref.getAndUpdate(calls, (call) => call + 1).pipe(
              Effect.flatMap((call) => {
                const response = responses[Math.min(call, responses.length - 1)]
                return response === "fail" || response === undefined
                  ? Effect.fail(new ProviderError({ reason: "Unreachable", league, cause: "down" }))
                  : Effect.succeed(response)
              }),
              Effect.withSpan("provider.poll")
            ),
          options
        )
      })
    ),
    decoder
  )
}

/**
 * A provider whose poll is the games `games` answers, as a frame with those games as JSON for its body, with `decoder`
 * beside it. It never pushes and is polled every 10 seconds, unless `options` say otherwise.
 */
export function polling(
  games: (league: LeagueId) => Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderError>,
  options: {
    readonly polling?: Polling
    readonly push?: LiveFeed
  } = {}
): Layer.Layer<Provider | Decoder> {
  return Layer.merge(Layer.succeed(Provider, polled(games, options)), decoder)
}

/**
 * The decode of the test providers: a poll read back as its league's `Listing`, and a live feed frame as a pushed
 * `Snapshot` of each game in it, or, when it holds none, as a `Resync` of its channel. A frame that does not decode is
 * skipped.
 */
export const decoder = Layer.succeed(
  Decoder,
  Decoder.of({
    decode: (frames) =>
      frames.pipe(
        Stream.map((frame) =>
          Option.match(decodeGames(frame.body), { onNone: () => [], onSome: (games) => said(frame, games) })
        ),
        Stream.flattenIterable
      )
  })
)

/** `delivery` taken into the fold at the test clock's now, as the delivery of frame `seq` when given. */
export function taken(delivery: Delivery, seq?: number) {
  return Effect.flatMap(DateTime.now, (at) =>
    LiveGames.use((liveGames) => liveGames.take(delivery, at, Option.fromNullishOr(seq)))
  )
}

/** The games one poll of `league` lists, as the provider's `Decoder` reads it. */
export function listedBy(league: LeagueId) {
  return Effect.gen(function* () {
    const provider = yield* Provider
    const decoding = yield* Decoder
    const frame = new Frame({ ...(yield* provider.poll(league)), seq: 1 })
    const said = yield* decoding.decode(Stream.make(frame)).pipe(Stream.runCollect)
    return said.flatMap((one) =>
      one._tag === "Delivered" && one.delivery._tag === "Listing" ? one.delivery.games : []
    )
  })
}

/** A live feed frame of `games` on `channel`, received now; with no games, one its decode reads as a `Resync`. */
export function pushed(games: ReadonlyArray<GameSnapshot>, channel = "event-football-college-football") {
  return Effect.map(
    DateTime.now,
    (receivedAt): FeedFrame => ({
      receivedAt,
      feed: "fastcast",
      channel,
      kind: "message",
      body: encodeGames(games)
    })
  )
}

function polled(
  games: (league: LeagueId) => Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderError>,
  options: Parameters<typeof polling>[1] = {}
) {
  return Provider.of({
    push: options.push ?? (() => Stream.never),
    polling: options.polling ?? Schedule.spaced("10 seconds"),
    poll: (league) =>
      Effect.all({ games: games(league), receivedAt: DateTime.now }).pipe(
        Effect.map(({ games, receivedAt }) => ({
          receivedAt,
          feed: "poll",
          channel: league,
          kind: "response",
          body: encodeGames(games)
        }))
      )
  })
}

function said(frame: Frame, games: ReadonlyArray<GameSnapshot>): ReadonlyArray<Decoded> {
  const delivered = (delivery: Delivery) =>
    Decoded.Delivered({ delivery, at: frame.receivedAt, seq: frame.seq })
  if (frame.feed === "poll") {
    return Option.match(decodeLeague(frame.channel), {
      onNone: () => [],
      onSome: (league) => [delivered(Delivery.cases.Listing.make({ league, games }))]
    })
  }
  return games.length === 0
    ? [Decoded.Resync({ channel: frame.channel, seq: frame.seq })]
    : games.map((snapshot) => delivered(Delivery.cases.Snapshot.make({ snapshot, from: "push" })))
}

const Games = Schema.fromJsonString(Schema.Array(GameSnapshot))
const encodeGames = Schema.encodeSync(Games)
const decodeGames = Schema.decodeUnknownOption(Games)
const decodeLeague = Schema.decodeUnknownOption(LeagueId)
