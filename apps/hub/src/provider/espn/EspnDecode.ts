import { Delivery } from "@sportal/domain/Delivery"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { Array as Arr, Effect, Layer, Option, Record, Result, Schema, Stream } from "effect"
import type { FeedFrame, Frame } from "../../Frame.ts"
import { Decoded, DecodeObservation, Decoder } from "../Decoder.ts"
import { EspnEvent } from "./EspnEvent.ts"
import { Scoreboard } from "./EspnPayload.ts"
import * as EspnPlay from "./EspnPlay.ts"
import * as EspnSummary from "./EspnSummary.ts"
import * as FastCastDocument from "./FastCastDocument.ts"

/**
 * ESPN's decode as the `Decoder`. A poll response is its league's `Listing`. A scoreboard topic's change is a pushed `Snapshot` of each game it touched, advanced to the game
 * its league last listed (FastCast has no short names); a game no listing has is noted `Unlisted` and not delivered. A
 * game topic's change is a `Plays` of the game's whole list, in `Play.order`. A topic whose document was sent back to
 * waiting for a checkpoint is a resync of it. A frame that does not decode is noted `FrameUndecoded` and says no
 * deliveries. Logs and counts nothing.
 */
export const layer = Layer.succeed(
  Decoder,
  Decoder.of({
    decode: (frames) =>
      frames.pipe(
        Stream.mapAccumEffect(
          (): State => ({
            listings: new Map(),
            documents: FastCastDocument.empty,
            notedTypes: new Set(),
            notedPlays: new Set()
          }),
          (state, frame) =>
            (frame.feed === "poll" ? listed(state, frame) : pushed(state, frame)).pipe(
              Effect.map(([next, decoded]) => [next, [decoded]] as const)
            )
        )
      )
  })
)

/**
 * Each league's decode of what ESPN sends for it: an event of either feed, a play entity, a game summary, and the
 * site scoreboard's JSON.
 */
export const decoders = Record.fromIterableWith(LeagueId.literals, (league) => [
  league,
  decodersOf(league)
  // Effect types a record built from keys as keyed by any string; every league is a key, as its test asserts.
]) as Readonly<Record<LeagueId, ReturnType<typeof decodersOf>>>

function decodersOf(league: LeagueId) {
  return {
    decodeEvent: Schema.decodeUnknownEffect(EspnEvent(league)),
    decodePlay: Schema.decodeUnknownEffect(EspnPlay.FootballPlay(league)),
    decodeSummary: Schema.decodeUnknownEffect(EspnSummary.Summary(league)),
    decodeScoreboard: Schema.decodeUnknownEffect(Schema.fromJsonString(Scoreboard))
  }
}

/**
 * Each league's last listing, the FastCast topics' documents, the unknown play types already noted, and the plays
 * already noted as not decoding.
 */
type State = {
  readonly listings: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly documents: typeof FastCastDocument.empty
  readonly notedTypes: ReadonlySet<string>
  readonly notedPlays: ReadonlySet<string>
}

function listed(state: State, frame: Frame): Effect.Effect<readonly [State, Decoded]> {
  return decodeLeague(frame.channel).pipe(
    Effect.flatMap((league) =>
      Effect.map(decoders[league].decodeScoreboard(frame.body), (scoreboard) => ({ league, scoreboard }))
    ),
    Effect.flatMap(({ league, scoreboard }) =>
      gamesOf(league, scoreboard.events, "poll").pipe(
        Effect.map(
          ({ games, observed }) =>
            [
              { ...state, listings: new Map([...state.listings, [league, games]]) },
              Decoded.of(frame, {
                deliveries: [Delivery.cases.Listing.make({ league, games })],
                observations: observed
              })
            ] as const
        )
      )
    ),
    Effect.catch((cause) => Effect.succeed([state, Decoded.undecodable(frame, cause)] as const))
  )
}

const decodeLeague = Schema.decodeUnknownEffect(LeagueId)

function pushed(state: State, frame: Frame): Effect.Effect<readonly [State, Decoded]> {
  return FastCastDocument.advance(state.documents, frame).pipe(
    Effect.flatMap(({ documents, change, observed }): Effect.Effect<readonly [State, Decoded]> => {
      const moved = { ...state, documents }
      return Option.match(change, {
        onNone: () => Effect.succeed([moved, Decoded.of(frame, { observations: observed })] as const),
        onSome: (changed) => {
          switch (changed._tag) {
            case "Scoreboard":
              return gamesOf(changed.league, changed.events, "fastcast").pipe(
                Effect.map(({ games, observed: undecoded }) => {
                  const { deliveries, unlisted } = advancedToListed(state.listings, games)
                  return [
                    moved,
                    Decoded.of(frame, {
                      deliveries,
                      observations: [
                        ...observed,
                        ...undecoded,
                        DecodeObservation.Pushed({ league: changed.league, games: games.length }),
                        ...unlisted.map((game) =>
                          DecodeObservation.Unlisted({ league: game.league, game: game.id })
                        )
                      ]
                    })
                  ] as const
                })
              )
            case "Game":
              return playsOf(moved, changed.league, changed.game, changed.plays).pipe(
                Effect.map(
                  ({ state: next, observed: notes, plays }) =>
                    [
                      next,
                      Decoded.of(frame, { deliveries: [plays], observations: [...observed, ...notes] })
                    ] as const
                )
              )
            case "Reset":
              return Effect.succeed([
                moved,
                Decoded.of(frame, { resyncs: [frame.channel], observations: observed })
              ] as const)
          }
        }
      })
    }),
    Effect.catch((cause) => Effect.succeed([state, Decoded.undecodable(frame, cause)] as const))
  )
}

/** The events as games; an event that does not decode is noted and skipped, and the rest still delivered. */
function gamesOf(
  league: LeagueId,
  events: ReadonlyArray<unknown>,
  feed: FeedFrame["feed"]
): Effect.Effect<{
  readonly games: ReadonlyArray<GameSnapshot>
  readonly observed: ReadonlyArray<DecodeObservation>
}> {
  return Effect.forEach(events, (event) =>
    decoders[league].decodeEvent(event).pipe(
      Effect.map(Result.succeed),
      Effect.catch((cause) =>
        Effect.succeed(Result.fail(DecodeObservation.EventUndecoded({ league, feed, cause })))
      )
    )
  ).pipe(
    Effect.map((decoded) => {
      const [games, observed] = Arr.separate(decoded)
      return { games, observed }
    })
  )
}

/** Each pushed game as its league's listed game advanced to it; a game no listing has is unlisted. */
function advancedToListed(
  listings: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>,
  games: ReadonlyArray<GameSnapshot>
): { readonly deliveries: ReadonlyArray<Delivery>; readonly unlisted: ReadonlyArray<GameSnapshot> } {
  const [deliveries, unlisted] = Arr.partition(games, (game) =>
    Option.match(
      Option.fromUndefinedOr(listings.get(game.league)?.find((listedGame) => listedGame.id === game.id)),
      {
        onNone: () => Result.fail(game),
        onSome: (listedGame) =>
          Result.succeed(
            Delivery.cases.Snapshot.make({ snapshot: listedGame.advancedTo(game), from: "push" })
          )
      }
    )
  )
  return { deliveries, unlisted }
}

/**
 * The game's plays, in `Play.order`. A play that does not decode is skipped, and noted the first time; a play type
 * the table does not know is noted once.
 */
function playsOf(
  state: State,
  league: LeagueId,
  game: GameId,
  entities: Readonly<Record<string, Schema.Json>>
): Effect.Effect<{
  readonly state: State
  readonly observed: ReadonlyArray<DecodeObservation>
  readonly plays: Delivery
}> {
  const unknown = EspnPlay.unknownTypes(Record.values(entities)).filter(
    (type) => !state.notedTypes.has(type.id)
  )
  return Effect.forEach(Record.toEntries(entities), ([id, entity]) =>
    decoders[league].decodePlay(entity).pipe(
      Effect.map(Result.succeed),
      Effect.catch((cause) => Effect.succeed(Result.fail({ id, cause })))
    )
  ).pipe(
    Effect.map((decoded) => {
      const [plays, skipped] = Arr.separate(decoded)
      return {
        state: {
          ...state,
          notedTypes: new Set([...state.notedTypes, ...unknown.map((type) => type.id)]),
          notedPlays: new Set([...state.notedPlays, ...skipped.map(({ id }) => id)])
        },
        observed: [
          ...skipped
            .filter(({ id }) => !state.notedPlays.has(id))
            .map(({ id, cause }) => DecodeObservation.PlayUndecoded({ league, game, play: id, cause })),
          ...unknown.map((type) => DecodeObservation.PlayTypeUnknown(type))
        ],
        plays: Delivery.cases.Plays.make({ game, plays: plays.toSorted(Play.order) })
      }
    })
  )
}
