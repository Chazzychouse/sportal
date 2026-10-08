import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { Array as Arr, Effect, HashMap, HashSet, Option, Record, Result, Schema, Stream } from "effect"
import type { Frame, LoggedFrame } from "../../Frame.ts"
import { Delivery } from "../../slate/Delivery.ts"
import { Decoded, DecodeObservation } from "../Provider.ts"
import { EspnEvent } from "./EspnEvent.ts"
import { Scoreboard } from "./EspnPayload.ts"
import * as EspnPlay from "./EspnPlay.ts"
import * as FastCastDocument from "./FastCastDocument.ts"

/**
 * ESPN's decode, the `decode` of every ESPN provider. A poll response is its league's `Listing`. A scoreboard topic's
 * change is a pushed `Snapshot` of each game it touched, advanced to the game its league last listed (FastCast has no
 * short names); a game no listing has is noted `Unlisted` and not delivered. A game topic's change is a `Plays` of the
 * game's whole list, in `Play.order`. A topic whose document was sent back to waiting for a checkpoint is noted
 * `Reset`, and FastCast reads its checkpoint again on its own. A frame that does not decode is noted `FrameUndecoded`
 * and says no deliveries. Logs and counts nothing.
 */
export function decode(frames: Stream.Stream<LoggedFrame>): Stream.Stream<Decoded> {
  return frames.pipe(
    Stream.mapAccumEffect(
      (): State => ({
        listings: HashMap.empty(),
        documents: FastCastDocument.empty,
        notedTypes: HashSet.empty(),
        notedPlays: HashSet.empty()
      }),
      (state, frame) =>
        (frame.source === "poll" ? listed(state, frame) : pushed(state, frame)).pipe(
          Effect.map(([next, decoded]) => [next, [decoded]] as const)
        )
    )
  )
}

/**
 * Each league's decode of what ESPN sends for it: an event of either feed, a play entity, and the site scoreboard's JSON.
 */
export const byLeague: { readonly [L in LeagueId]: ReturnType<typeof leagueDecode> } = {
  nfl: leagueDecode("nfl"),
  fbs: leagueDecode("fbs")
}

function leagueDecode(league: LeagueId) {
  return {
    decodeEvent: Schema.decodeUnknownEffect(EspnEvent(league)),
    decodePlay: Schema.decodeUnknownEffect(EspnPlay.FootballPlay(league)),
    decodeScoreboard: Schema.decodeUnknownEffect(Schema.fromJsonString(Scoreboard))
  }
}

/**
 * Each league's last listing, the FastCast topics' documents, the unknown play types already noted, and the plays
 * already noted as not decoding.
 */
interface State {
  readonly listings: HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly documents: typeof FastCastDocument.empty
  readonly notedTypes: HashSet.HashSet<string>
  readonly notedPlays: HashSet.HashSet<string>
}

const listed = Effect.fnUntraced(
  function* (state: State, frame: LoggedFrame) {
    const league = yield* decodeLeague(frame.channel)
    const scoreboard = yield* byLeague[league].decodeScoreboard(frame.body)
    const { games, observed } = yield* gamesOf(league, scoreboard.events, "poll")

    const next: State = { ...state, listings: HashMap.set(state.listings, league, games) }
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

    return yield* FastCastDocument.Change.$match(change.value, {
      Scoreboard: Effect.fnUntraced(function* ({ league, events }) {
        const { games, observed: undecoded } = yield* gamesOf(league, events, "push")
        const { deliveries, unlisted } = advancedToListed(state.listings, games)
        const unlistedNotes = unlisted.map((game) =>
          DecodeObservation.Unlisted({ league: game.league, game: game.id })
        )
        const decoded = Decoded.of(frame, {
          deliveries,
          observations: [
            ...observed,
            ...undecoded,
            DecodeObservation.Pushed({ league, games: games.length }),
            ...unlistedNotes
          ]
        })
        return [moved, decoded] as const
      }),
      Game: Effect.fnUntraced(function* ({ league, game, plays }) {
        const played = yield* playsOf(moved, league, game, plays)
        const decoded = Decoded.of(frame, {
          deliveries: [played.plays],
          observations: [...observed, ...played.observed]
        })
        return [played.state, decoded] as const
      }),
      Reset: () => Effect.succeed([moved, Decoded.of(frame, { observations: observed })] as const)
    })
  },
  (advancing, state, frame) =>
    Effect.catch(advancing, (cause) => Effect.succeed([state, Decoded.undecodable(frame, cause)] as const))
)

/** The events as games; an event that does not decode is noted and skipped, and the rest still delivered. */
export const gamesOf = Effect.fnUntraced(function* (
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
  listings: HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>,
  games: ReadonlyArray<GameSnapshot>
): { readonly deliveries: ReadonlyArray<Delivery>; readonly unlisted: ReadonlyArray<GameSnapshot> } {
  const [deliveries, unlisted] = Arr.partition(games, (game) =>
    Option.match(
      HashMap.get(listings, game.league).pipe(
        Option.flatMap(Arr.findFirst((listedGame) => listedGame.id === game.id))
      ),
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
    (type) => !HashSet.has(state.notedTypes, type.id)
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
    notedTypes: HashSet.union(state.notedTypes, HashSet.fromIterable(unknown.map((type) => type.id))),
    notedPlays: HashSet.union(state.notedPlays, HashSet.fromIterable(skipped.map(({ id }) => id)))
  }
  const observed = [
    ...skipped
      .filter(({ id }) => !HashSet.has(state.notedPlays, id))
      .map(({ id, cause }) => DecodeObservation.PlayUndecoded({ league, game, play: id, cause })),
    ...unknown.map((type) => DecodeObservation.PlayTypeUnknown(type))
  ]
  return {
    state: next,
    observed,
    plays: Delivery.cases.Plays.make({ game, plays: plays.toSorted(Play.order) })
  }
})
