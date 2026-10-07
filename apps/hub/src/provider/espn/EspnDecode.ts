import { Delivery } from "@sportal/domain/Delivery"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { Array as Arr, Effect, Layer, Option, Record, Result, Schema, Stream } from "effect"
import type { Frame } from "../../Frame.ts"
import { Decoder } from "../Decoder.ts"
import { Decoded, Notice } from "../Provider.ts"
import { EspnEvent } from "./EspnEvent.ts"
import * as EspnPlay from "./EspnPlay.ts"
import * as FastCastDocument from "./FastCastDocument.ts"

/**
 * ESPN's decode as the `Decoder`: what each ESPN frame said, one `Decoded` per frame, in order. A poll response is its
 * league's `Listing`. A scoreboard topic's change is a pushed `Snapshot` of each game it touched, advanced to the game
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

function listed(state: State, frame: Frame): Effect.Effect<readonly [State, Decoded]> {
  return Effect.all({ league: decodeLeague(frame.channel), scoreboard: decodeScoreboard(frame.body) }).pipe(
    Effect.flatMap(({ league, scoreboard }) =>
      gamesOf(league, scoreboard.events, frame.feed).pipe(
        Effect.map(
          ({ games, noticed }) =>
            [
              { ...state, listings: new Map([...state.listings, [league, games]]) },
              said(frame, { deliveries: [Delivery.cases.Listing.make({ league, games })], notices: noticed })
            ] as const
        )
      )
    ),
    Effect.catch((cause) => Effect.succeed([state, undecodable(frame, cause)] as const))
  )
}

const decodeLeague = Schema.decodeUnknownEffect(LeagueId)
const decodeScoreboard = Schema.decodeUnknownEffect(Schema.fromJsonString(Scoreboard))

function pushed(state: State, frame: Frame): Effect.Effect<readonly [State, Decoded]> {
  return FastCastDocument.advance(state.documents, frame).pipe(
    Effect.flatMap(({ documents, change, noticed }): Effect.Effect<readonly [State, Decoded]> => {
      const moved = { ...state, documents }
      return Option.match(change, {
        onNone: () => Effect.succeed([moved, said(frame, { notices: noticed })] as const),
        onSome: (changed) => {
          switch (changed._tag) {
            case "Scoreboard":
              return gamesOf(changed.league, changed.events, frame.feed).pipe(
                Effect.map(({ games, noticed: undecoded }) => {
                  const { deliveries, unlisted } = advancedToListed(state.listings, games)
                  return [
                    moved,
                    said(frame, {
                      deliveries,
                      notices: [
                        ...noticed,
                        ...undecoded,
                        Notice.Pushed({ league: changed.league, games: games.length }),
                        ...unlisted.map((game) => Notice.Unlisted({ league: game.league, game: game.id }))
                      ]
                    })
                  ] as const
                })
              )
            case "Game":
              return playsOf(moved, changed.league, changed.game, changed.plays).pipe(
                Effect.map(
                  ({ state: next, noticed: notes, plays }) =>
                    [next, said(frame, { deliveries: [plays], notices: [...noticed, ...notes] })] as const
                )
              )
            case "Reset":
              return Effect.succeed([
                moved,
                said(frame, { resyncs: [frame.channel], notices: noticed })
              ] as const)
          }
        }
      })
    }),
    Effect.catch((cause) => Effect.succeed([state, undecodable(frame, cause)] as const))
  )
}

function said(
  frame: Frame,
  of: {
    readonly deliveries?: ReadonlyArray<Delivery>
    readonly resyncs?: ReadonlyArray<string>
    readonly notices?: ReadonlyArray<Notice>
  }
): Decoded {
  return new Decoded({
    seq: frame.seq,
    at: frame.receivedAt,
    deliveries: of.deliveries ?? [],
    resyncs: of.resyncs ?? [],
    notices: of.notices ?? []
  })
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
        plays: Delivery.cases.Plays.make({ game, plays: plays.toSorted(Play.order) })
      }
    })
  )
}

const decodePlay = {
  nfl: Schema.decodeUnknownEffect(EspnPlay.Play("nfl")),
  fbs: Schema.decodeUnknownEffect(EspnPlay.Play("fbs"))
}

function undecodable(frame: Frame, cause: unknown): Decoded {
  return said(frame, {
    notices: [Notice.FrameUndecoded({ feed: frame.feed, channel: frame.channel, kind: frame.kind, cause })]
  })
}
