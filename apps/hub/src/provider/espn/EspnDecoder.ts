import { Delivery } from "@sportal/domain/Delivery"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { Array as Arr, Effect, Layer, Option, Record, Result, Schema, Stream } from "effect"
import type { Frame, LoggedFrame } from "../../Frame.ts"
import { Decoded, DecodeObservation, Decoder } from "../Decoder.ts"
import { EspnEvent } from "./EspnEvent.ts"
import { Scoreboard } from "./EspnPayload.ts"
import * as EspnPlay from "./EspnPlay.ts"
import * as EspnSummary from "./EspnSummary.ts"
import * as FastCastDocument from "./FastCastDocument.ts"

/**
 * ESPN's decode as the `Decoder`. A poll response is its league's `Listing`. A scoreboard topic's change is a pushed
 * `Snapshot` of each game it touched, advanced to the game its league last listed (FastCast has no short names); a
 * game no listing has is noted `Unlisted` and not delivered. A game topic's change is a `Plays` of the game's whole
 * list, in `Play.order`. A topic whose document was sent back to waiting for a checkpoint is a resync of it. A frame
 * that does not decode is noted `FrameUndecoded` and says no deliveries. Logs and counts nothing.
 */
export const layer: Layer.Layer<Decoder> = Layer.succeed(
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
            (frame.source === "poll" ? listed(state, frame) : pushed(state, frame)).pipe(
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
export const byLeague: { readonly [L in LeagueId]: ReturnType<typeof leagueDecode> } = {
  nfl: leagueDecode("nfl"),
  fbs: leagueDecode("fbs")
}

function leagueDecode(league: LeagueId) {
  return {
    decodeEvent: Schema.decodeUnknownEffect(EspnEvent(league)),
    decodePlay: Schema.decodeUnknownEffect(EspnPlay.FootballPlay(league)),
    decodeSummary: Schema.decodeUnknownEffect(EspnSummary.SummaryPlays(league)),
    decodeScoreboard: Schema.decodeUnknownEffect(Schema.fromJsonString(Scoreboard))
  }
}

/**
 * Each league's last listing, the FastCast topics' documents, the unknown play types already noted, and the plays
 * already noted as not decoding.
 */
interface State {
  readonly listings: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly documents: typeof FastCastDocument.empty
  readonly notedTypes: ReadonlySet<string>
  readonly notedPlays: ReadonlySet<string>
}

const listed = Effect.fnUntraced(
  function* (state: State, frame: LoggedFrame) {
    const league = yield* decodeLeague(frame.channel)
    const scoreboard = yield* byLeague[league].decodeScoreboard(frame.body)
    const { games, observed } = yield* gamesOf(league, scoreboard.events, "poll")

    const next: State = { ...state, listings: new Map([...state.listings, [league, games]]) }
    const decoded = Decoded.of(frame, {
      deliveries: [Delivery.cases.Listing.make({ league, games })],
      observations: observed
    })
    return [next, decoded] as const
  },
  (listing, state, frame) =>
    Effect.catch(listing, (cause) => Effect.succeed([state, Decoded.undecodable(frame, cause)] as const))
)

const decodeLeague = Schema.decodeUnknownEffect(LeagueId)

const pushed = Effect.fnUntraced(
  function* (state: State, frame: LoggedFrame) {
    const { documents, change, observed } = yield* FastCastDocument.advance(state.documents, frame)
    const moved: State = { ...state, documents }
    if (Option.isNone(change)) {
      return [moved, Decoded.of(frame, { observations: observed })] as const
    }

    const changed = change.value
    switch (changed._tag) {
      case "Scoreboard": {
        const { games, observed: undecoded } = yield* gamesOf(changed.league, changed.events, "push")
        const { deliveries, unlisted } = advancedToListed(state.listings, games)
        const unlistedNotes = unlisted.map((game) =>
          DecodeObservation.Unlisted({ league: game.league, game: game.id })
        )
        const decoded = Decoded.of(frame, {
          deliveries,
          observations: [
            ...observed,
            ...undecoded,
            DecodeObservation.Pushed({ league: changed.league, games: games.length }),
            ...unlistedNotes
          ]
        })
        return [moved, decoded] as const
      }
      case "Game": {
        const played = yield* playsOf(moved, changed.league, changed.game, changed.plays)
        const decoded = Decoded.of(frame, {
          deliveries: [played.plays],
          observations: [...observed, ...played.observed]
        })
        return [played.state, decoded] as const
      }
      case "Reset":
        return [moved, Decoded.of(frame, { resyncs: [frame.channel], observations: observed })] as const
    }
  },
  (advancing, state, frame) =>
    Effect.catch(advancing, (cause) => Effect.succeed([state, Decoded.undecodable(frame, cause)] as const))
)

/** The events as games; an event that does not decode is noted and skipped, and the rest still delivered. */
const gamesOf = Effect.fnUntraced(function* (
  league: LeagueId,
  events: ReadonlyArray<unknown>,
  source: Frame["source"]
) {
  const decoded = yield* Effect.forEach(events, (event) =>
    byLeague[league].decodeEvent(event).pipe(
      Effect.map(Result.succeed),
      Effect.catch((cause) =>
        Effect.succeed(Result.fail(DecodeObservation.EventUndecoded({ league, source, cause })))
      )
    )
  )
  const [games, observed] = Arr.separate(decoded)
  return { games, observed }
})

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
const playsOf = Effect.fnUntraced(function* (
  state: State,
  league: LeagueId,
  game: GameId,
  entities: Readonly<Record<string, Schema.Json>>
) {
  const unknown = EspnPlay.unknownTypes(Record.values(entities)).filter(
    (type) => !state.notedTypes.has(type.id)
  )
  const decoded = yield* Effect.forEach(Record.toEntries(entities), ([id, entity]) =>
    byLeague[league].decodePlay(entity).pipe(
      Effect.map(Result.succeed),
      Effect.catch((cause) => Effect.succeed(Result.fail({ id, cause })))
    )
  )
  const [plays, skipped] = Arr.separate(decoded)

  const next: State = {
    ...state,
    notedTypes: new Set([...state.notedTypes, ...unknown.map((type) => type.id)]),
    notedPlays: new Set([...state.notedPlays, ...skipped.map(({ id }) => id)])
  }
  const observed = [
    ...skipped
      .filter(({ id }) => !state.notedPlays.has(id))
      .map(({ id, cause }) => DecodeObservation.PlayUndecoded({ league, game, play: id, cause })),
    ...unknown.map((type) => DecodeObservation.PlayTypeUnknown(type))
  ]
  return {
    state: next,
    observed,
    plays: Delivery.cases.Plays.make({ game, plays: plays.toSorted(Play.order) })
  }
})
