import { Delivery } from "@sportal/domain/Delivery"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { Array as Arr, Effect, Option, Record, Result, Schema, Stream } from "effect"
import type { Frame } from "../../Frame.ts"
import { Decoded, Notice, type Provider } from "../Provider.ts"
import { EspnEvent } from "./EspnEvent.ts"
import * as EspnPlay from "./EspnPlay.ts"
import * as FastCastDocument from "./FastCastDocument.ts"

/**
 * What each ESPN frame said, in order. A poll response is its league's `Listing`. A scoreboard topic's change is a
 * pushed `Snapshot` of each game it touched, advanced to the game its league last listed (FastCast has no short
 * names); a game no listing has is noted `Unlisted` and not delivered. A game topic's change is a `Plays` of the
 * game's whole list, in `Play.order`. A topic whose document was sent back to waiting for a checkpoint is a `Resync`
 * of it. A frame that does not decode is noted `FrameUndecoded` and skipped. Logs and counts nothing.
 */
export const decode: Provider["Service"]["decode"] = (frames) =>
  frames.pipe(
    Stream.mapAccumEffect(
      (): State => ({
        listings: new Map(),
        documents: FastCastDocument.empty,
        notedTypes: new Set(),
        notedPlays: new Set()
      }),
      (state, frame) => (frame.feed === "poll" ? listed(state, frame) : pushed(state, frame))
    )
  )

/** The site scoreboard as polled: its events, each read by `EspnEvent`. */
const Scoreboard = Schema.Struct({ events: Schema.Array(Schema.Unknown) })

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

/** What one frame said, as `decode` gives it. */
type Said = ReadonlyArray<Decoded>

function listed(state: State, frame: Frame): Effect.Effect<readonly [State, Said]> {
  return Effect.all({ league: decodeLeague(frame.channel), scoreboard: decodeScoreboard(frame.body) }).pipe(
    Effect.flatMap(({ league, scoreboard }) =>
      gamesOf(league, scoreboard.events, frame.feed).pipe(
        Effect.map(
          ({ games, noticed }) =>
            [
              { ...state, listings: new Map([...state.listings, [league, games]]) },
              [...noted(frame, noticed), delivered(frame, Delivery.Listing({ league, games }))]
            ] as const
        )
      )
    ),
    Effect.catch((cause) => Effect.succeed([state, [undecodable(frame, cause)]] as const))
  )
}

const decodeLeague = Schema.decodeUnknownEffect(LeagueId)
const decodeScoreboard = Schema.decodeUnknownEffect(Schema.fromJsonString(Scoreboard))

function pushed(state: State, frame: Frame): Effect.Effect<readonly [State, Said]> {
  return FastCastDocument.advance(state.documents, frame).pipe(
    Effect.flatMap(({ documents, change, noticed }): Effect.Effect<readonly [State, Said]> => {
      const moved = { ...state, documents }
      const told = noted(frame, noticed)
      return Option.match(change, {
        onNone: () => Effect.succeed([moved, told] as const),
        onSome: (said) => {
          switch (said._tag) {
            case "Scoreboard":
              return gamesOf(said.league, said.events, frame.feed).pipe(
                Effect.map(({ games, noticed: undecoded }) => {
                  const { deliveries, unlisted } = advancedToListed(state.listings, games)
                  return [
                    moved,
                    [
                      ...told,
                      ...noted(frame, [
                        ...undecoded,
                        Notice.Pushed({ league: said.league, games: games.length }),
                        ...unlisted.map((game) => Notice.Unlisted({ league: game.league, game: game.id }))
                      ]),
                      ...deliveries.map((one) => delivered(frame, one))
                    ]
                  ] as const
                })
              )
            case "Game":
              return playsOf(moved, said.league, said.game, said.plays).pipe(
                Effect.map(
                  ({ state: next, noticed: notes, plays }) =>
                    [next, [...told, ...noted(frame, notes), delivered(frame, plays)]] as const
                )
              )
            case "Reset":
              return Effect.succeed([
                moved,
                [...told, Decoded.Resync({ channel: frame.channel, seq: frame.seq })]
              ] as const)
          }
        }
      })
    }),
    Effect.catch((cause) => Effect.succeed([state, [undecodable(frame, cause)]] as const))
  )
}

function delivered(frame: Frame, delivery: Delivery) {
  return Decoded.Delivered({ delivery, at: frame.receivedAt, seq: frame.seq })
}

function noted(frame: Frame, notices: ReadonlyArray<Notice>): Said {
  return notices.map((notice) => Decoded.Noted({ notice, seq: frame.seq }))
}

/** The events as games; an event that does not decode is noted and skipped, and the rest still delivered. */
function gamesOf(
  league: LeagueId,
  events: ReadonlyArray<unknown>,
  feed: Frame["feed"]
): Effect.Effect<{ readonly games: ReadonlyArray<GameSnapshot>; readonly noticed: ReadonlyArray<Notice> }> {
  return Effect.forEach(events, (event) =>
    decodeEvent[league](event).pipe(
      Effect.map(Result.succeed),
      Effect.catch((cause) => Effect.succeed(Result.fail(Notice.EventUndecoded({ league, feed, cause }))))
    )
  ).pipe(
    Effect.map((decoded) => {
      const [games, noticed] = Arr.separate(decoded)
      return { games, noticed }
    })
  )
}

const decodeEvent = {
  nfl: Schema.decodeUnknownEffect(EspnEvent("nfl")),
  fbs: Schema.decodeUnknownEffect(EspnEvent("fbs"))
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
          Result.succeed(Delivery.Snapshot({ snapshot: listedGame.advancedTo(game), from: "push" }))
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
  readonly noticed: ReadonlyArray<Notice>
  readonly plays: Delivery
}> {
  const unknown = EspnPlay.unknownTypes(Record.values(entities)).filter(
    (type) => !state.notedTypes.has(type.id)
  )
  return Effect.forEach(Record.toEntries(entities), ([id, entity]) =>
    decodePlay[league](entity).pipe(
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
        noticed: [
          ...skipped
            .filter(({ id }) => !state.notedPlays.has(id))
            .map(({ id, cause }) => Notice.PlayUndecoded({ league, game, play: id, cause })),
          ...unknown.map((type) => Notice.PlayTypeUnknown(type))
        ],
        plays: Delivery.Plays({ game, plays: plays.toSorted(Play.order) })
      }
    })
  )
}

const decodePlay = {
  nfl: Schema.decodeUnknownEffect(EspnPlay.Play("nfl")),
  fbs: Schema.decodeUnknownEffect(EspnPlay.Play("fbs"))
}

function undecodable(frame: Frame, cause: unknown): Decoded {
  return Decoded.Noted({
    notice: Notice.FrameUndecoded({ feed: frame.feed, channel: frame.channel, kind: frame.kind, cause }),
    seq: frame.seq
  })
}
