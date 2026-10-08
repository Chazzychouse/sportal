import type { GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { Array as Arr, Effect, HashMap, Option, Record, Schema, Stream } from "effect"
import { Delivery } from "../../slate/Delivery.ts"
import { EspnEvent } from "./EspnEvent.ts"
import { Scoreboard } from "./EspnPayload.ts"
import * as EspnPlay from "./EspnPlay.ts"
import * as FastCastDocument from "./FastCastDocument.ts"
import type { Frame } from "./Frame.ts"

/**
 * ESPN's decode, read by every ESPN provider. A poll response is its league's `Listing`. A scoreboard topic's change is
 * a pushed `Snapshot` of each game it touched, advanced to the game its league last listed (FastCast has no short
 * names); a game no listing has is not delivered. A game topic's change is a `Plays` of the game's whole list, in
 * `Play.order`. An event or a play that does not decode is skipped. A frame that does not decode says nothing, and is
 * logged.
 */
export function decode(frames: Stream.Stream<Frame>): Stream.Stream<ReadonlyArray<Delivery>> {
  return frames.pipe(
    Stream.mapAccumEffect(
      (): State => ({ listings: HashMap.empty(), documents: FastCastDocument.empty }),
      (state, frame) =>
        (frame.source === "poll" ? listed(state, frame) : pushed(state, frame)).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("EspnDecoder: skipped a frame that does not decode", cause).pipe(
              Effect.annotateLogs({ source: frame.source, channel: frame.channel, kind: frame.kind }),
              Effect.as([state, noDeliveries] as const)
            )
          ),
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

/** Each league's last listing, and the FastCast topics' documents. */
interface State {
  readonly listings: HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly documents: typeof FastCastDocument.empty
}

const listed = Effect.fnUntraced(function* (state: State, frame: Frame) {
  const league = yield* decodeLeague(frame.channel)
  const scoreboard = yield* byLeague[league].decodeScoreboard(frame.body)
  const games = yield* gamesOf(league, scoreboard.events)

  const next: State = { ...state, listings: HashMap.set(state.listings, league, games) }
  return [next, [Delivery.cases.Listing.make({ league, games })]] as const
})

const decodeLeague = Schema.decodeUnknownEffect(LeagueId)

const noDeliveries: ReadonlyArray<Delivery> = []

const pushed = Effect.fnUntraced(function* (state: State, frame: Frame) {
  const { documents, change } = yield* FastCastDocument.advance(state.documents, frame)
  const said = Option.match(change, {
    onNone: () => Effect.succeed(noDeliveries),
    onSome: FastCastDocument.Change.$match({
      Scoreboard: ({ league, events }) =>
        Effect.map(gamesOf(league, events), (games) => advancedToListed(state.listings, games)),
      Game: ({ league, game, plays }) =>
        Effect.map(playsOf(league, plays), (sorted) => [Delivery.cases.Plays.make({ game, plays: sorted })]),
      Reset: () => Effect.succeed(noDeliveries)
    })
  })
  const deliveries = yield* said

  return [{ ...state, documents }, deliveries] as const
})

/** The events as games; an event that does not decode is skipped, and the rest still delivered. */
export const gamesOf = Effect.fnUntraced(function* (league: LeagueId, events: ReadonlyArray<unknown>) {
  const decoded = yield* Effect.forEach(events, (event) => Effect.option(byLeague[league].decodeEvent(event)))
  return Arr.getSomes(decoded)
})

/** Each pushed game as its league's listed game advanced to it; a game no listing has is left out. */
function advancedToListed(
  listings: HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>,
  games: ReadonlyArray<GameSnapshot>
): ReadonlyArray<Delivery> {
  return games.flatMap((game) =>
    HashMap.get(listings, game.league).pipe(
      Option.flatMap(Arr.findFirst((listedGame) => listedGame.id === game.id)),
      Option.map((listedGame) => Delivery.cases.Snapshot.make({ snapshot: listedGame.advancedTo(game) })),
      Option.toArray
    )
  )
}

/** The game's plays, in `Play.order`; a play that does not decode is skipped. */
const playsOf = Effect.fnUntraced(function* (
  league: LeagueId,
  entities: Readonly<Record<string, Schema.Json>>
) {
  const decoded = yield* Effect.forEach(Record.values(entities), (entity) =>
    Effect.option(byLeague[league].decodePlay(entity))
  )
  return Arr.getSomes(decoded).toSorted(Play.order)
})
