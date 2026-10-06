import { Delivery } from "@sportal/domain/Delivery"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
import { Frame } from "./feed/Frame.ts"
import { Provider, ProviderError } from "./provider/Provider.ts"

/** A live game `id` in `period`, at 10:00 on the clock. */
export function game(id: string, period = 1) {
  return snapshot({ id: GameId.make(id), status: "live", period, clock: "10:00" })
}

/**
 * A provider that answers each poll with the next scripted response, and the last one after that, inside a
 * `provider.poll` span. A `"fail"` response fails the poll, and an empty script fails every poll.
 */
export function scripted(responses: ReadonlyArray<ReadonlyArray<GameSnapshot> | "fail">) {
  let call = 0
  return Layer.succeed(
    Provider,
    polling((league) => {
      const response = responses[Math.min(call++, responses.length - 1)]
      return (
        response === "fail" || response === undefined
          ? Effect.fail(new ProviderError({ league, cause: "down" }))
          : Effect.succeed(response)
      ).pipe(Effect.withSpan("provider.poll"))
    })
  )
}

/**
 * A provider whose poll is the games `games` answers, as a frame with those games as JSON for its body. Its decode
 * reads a poll back as its league's `Listing`, and a live feed frame as a pushed `Snapshot` of each game in it, or,
 * when it holds none, as a `Resync` of its channel. A frame that does not decode is skipped.
 */
export function polling(
  games: (league: LeagueId) => Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderError>
): Provider["Service"] {
  return Provider.of({
    poll: (league) =>
      Effect.all({ games: games(league), receivedAt: DateTime.now }).pipe(
        Effect.map(
          ({ games, receivedAt }) =>
            ({
              receivedAt,
              feed: "poll",
              channel: league,
              kind: "response",
              body: encodeGames(games)
            }) as const
        )
      ),
    decode: (frames) =>
      frames.pipe(
        Stream.map((frame) =>
          Option.match(decodeGames(frame.body), { onNone: () => [], onSome: (games) => said(frame, games) })
        ),
        Stream.flattenIterable
      )
  })
}

/** The games one poll of `league` lists, as the provider decodes it. */
export function listedBy(league: LeagueId) {
  return Effect.gen(function* () {
    const provider = yield* Provider
    const frame = new Frame({ ...(yield* provider.poll(league)), seq: 1 })
    const said = yield* provider.decode(Stream.make(frame)).pipe(Stream.runCollect)
    return said.flatMap((one) =>
      one._tag === "Delivered" && one.delivery._tag === "Listing" ? one.delivery.games : []
    )
  })
}

/** A live feed frame of `games` on `channel`, received now; with no games, one its decode reads as a `Resync`. */
export function pushed(games: ReadonlyArray<GameSnapshot>, channel = "event-football-college-football") {
  return Effect.map(
    DateTime.now,
    (receivedAt): Omit<Frame, "seq"> => ({
      receivedAt,
      feed: "fastcast",
      channel,
      kind: "message",
      body: encodeGames(games)
    })
  )
}

function said(
  frame: Frame,
  games: ReadonlyArray<GameSnapshot>
): ReadonlyArray<Stream.Success<ReturnType<Provider["Service"]["decode"]>>> {
  const delivered = (delivery: Delivery) =>
    ({ _tag: "Delivered", delivery, at: frame.receivedAt, seq: frame.seq }) as const
  if (frame.feed === "poll") {
    return Option.match(decodeLeague(frame.channel), {
      onNone: () => [],
      onSome: (league) => [delivered(Delivery.Listing({ league, games }))]
    })
  }
  return games.length === 0
    ? [{ _tag: "Resync", channel: frame.channel, seq: frame.seq } as const]
    : games.map((snapshot) => delivered(Delivery.Snapshot({ snapshot, from: "push" })))
}

const Games = Schema.fromJsonString(Schema.Array(GameSnapshot))
const encodeGames = Schema.encodeSync(Games)
const decodeGames = Schema.decodeUnknownOption(Games)
const decodeLeague = Schema.decodeUnknownOption(LeagueId)
