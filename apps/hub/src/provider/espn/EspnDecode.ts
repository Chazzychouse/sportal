import { Delivery } from "@sportal/domain/Delivery"
import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { Array as Arr, Effect, Metric, Option, Record, Result, Schema, Stream } from "effect"
import type { Frame } from "../../feed-log/Frame.ts"
import { Decoded, type Provider } from "../Provider.ts"
import { EspnEvent } from "./EspnEvent.ts"
import * as EspnPlay from "./EspnPlay.ts"
import * as FastCastDocument from "./FastCastDocument.ts"

/**
 * What each ESPN frame said, in order. A poll response is its league's `Listing`. A scoreboard topic's change is a
 * pushed `Snapshot` of each game it touched, advanced to the game its league last listed (FastCast has no short
 * names); a game no listing has is counted and not delivered. A game topic's change is a `Plays` of the game's whole
 * list, in `Play.order`. A topic whose document was sent back to waiting for a checkpoint is a `Resync` of it. A frame
 * that does not decode is logged with its `seq`, counted, and skipped.
 */
export const decode: Provider["Service"]["decode"] = (frames) =>
  frames.pipe(
    Stream.mapAccumEffect(
      (): State => ({
        listings: new Map(),
        documents: FastCastDocument.empty,
        loggedTypes: new Set(),
        undecodedPlays: new Set()
      }),
      (state, frame) => (frame.feed === "poll" ? listed(state, frame) : pushed(state, frame))
    )
  )

/** The snapshots in one ESPN scoreboard; an event that does not decode is skipped, logged, and counted. */
function slateOf(
  league: LeagueId,
  scoreboard: typeof Scoreboard.Type
): Effect.Effect<ReadonlyArray<GameSnapshot>> {
  return gamesOf(league, scoreboard.events).pipe(Effect.withSpan("EspnDecode.slateOf"))
}

/** The site scoreboard as polled: its events, each read by `EspnEvent`. */
const Scoreboard = Schema.Struct({ events: Schema.Array(Schema.Unknown) })

/**
 * Each league's last listing, the FastCast topics' documents, the unknown play types already logged, and the plays
 * already logged as not decoding.
 */
type State = {
  readonly listings: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly documents: typeof FastCastDocument.empty
  readonly loggedTypes: ReadonlySet<string>
  readonly undecodedPlays: ReadonlySet<string>
}

/** What one frame said, as `decode` gives it. */
type Said = ReadonlyArray<Decoded>

function listed(state: State, frame: Frame): Effect.Effect<readonly [State, Said]> {
  return Effect.all({ league: decodeLeague(frame.channel), scoreboard: decodeScoreboard(frame.body) }).pipe(
    Effect.flatMap(({ league, scoreboard }) =>
      slateOf(league, scoreboard).pipe(
        Effect.map(
          (games) =>
            [
              { ...state, listings: new Map([...state.listings, [league, games]]) },
              [delivered(frame, Delivery.Listing({ league, games }))]
            ] as const
        )
      )
    ),
    Effect.catch((cause) => undecodable(frame, cause).pipe(Effect.as([state, []] as const)))
  )
}

const decodeLeague = Schema.decodeUnknownEffect(LeagueId)
const decodeScoreboard = Schema.decodeUnknownEffect(Schema.fromJsonString(Scoreboard))

function pushed(state: State, frame: Frame): Effect.Effect<readonly [State, Said]> {
  return FastCastDocument.advance(state.documents, frame).pipe(
    Effect.flatMap(([documents, change]): Effect.Effect<readonly [State, Said]> => {
      const moved = { ...state, documents }
      return Option.match(change, {
        onNone: () => Effect.succeed([moved, []] as const),
        onSome: (said) => {
          switch (said._tag) {
            case "Scoreboard":
              return gamesOf(said.league, said.events).pipe(
                Effect.tap((games) =>
                  Metric.update(Metric.withAttributes(gamesPushed, { league: said.league }), games.length)
                ),
                Effect.flatMap((games) => advancedToListed(state.listings, games)),
                Effect.map((deliveries) => [moved, deliveries.map((one) => delivered(frame, one))] as const)
              )
            case "Game":
              return playsOf(moved, said.league, said.game, said.plays).pipe(
                Effect.map(
                  ([next, deliveries]) => [next, deliveries.map((one) => delivered(frame, one))] as const
                )
              )
            case "Reset":
              return Effect.succeed([
                moved,
                [Decoded.Resync({ channel: frame.channel, seq: frame.seq })]
              ] as const)
            case "Unreadable":
              return undecodable(frame, said.cause).pipe(Effect.as([moved, []] as const))
          }
        }
      })
    }),
    Effect.catch((cause) => undecodable(frame, cause).pipe(Effect.as([state, []] as const)))
  )
}

function delivered(frame: Frame, delivery: Delivery) {
  return Decoded.Delivered({ delivery, at: frame.receivedAt, seq: frame.seq })
}

/** The events as games; an event that does not decode is logged and counted, and the rest still delivered. */
function gamesOf(
  league: LeagueId,
  events: ReadonlyArray<unknown>
): Effect.Effect<ReadonlyArray<GameSnapshot>> {
  return Effect.forEach(events, (event) =>
    decodeEvent[league](event).pipe(
      Effect.asSome,
      Effect.catch((issue) =>
        Effect.logWarning("EspnDecode: skipped an event that failed to decode", issue).pipe(
          Effect.annotateLogs({ league }),
          Effect.andThen(Metric.update(Metric.withAttributes(undecodedEvents, { league }), 1)),
          Effect.as(Option.none())
        )
      )
    )
  ).pipe(Effect.map(Arr.getSomes))
}

const decodeEvent = {
  nfl: Schema.decodeUnknownEffect(EspnEvent("nfl")),
  fbs: Schema.decodeUnknownEffect(EspnEvent("fbs"))
}

/** Each pushed game as its league's listed game advanced to it; a game no listing has is counted and dropped. */
function advancedToListed(
  listings: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>,
  games: ReadonlyArray<GameSnapshot>
): Effect.Effect<ReadonlyArray<Delivery>> {
  const [advanced, unlisted] = Arr.partition(games, (game) =>
    Option.match(
      Option.fromUndefinedOr(listings.get(game.league)?.find((listedGame) => listedGame.id === game.id)),
      {
        onNone: () => Result.fail(game),
        onSome: (listedGame) =>
          Result.succeed(Delivery.Snapshot({ snapshot: listedGame.advancedTo(game), from: "push" }))
      }
    )
  )
  return Effect.forEach(
    unlisted,
    (game) => Metric.update(Metric.withAttributes(liveFeedUnlisted, { league: game.league }), 1),
    { discard: true }
  ).pipe(Effect.as(advanced))
}

/**
 * The game's plays, in `Play.order`. A play that does not decode is skipped, and logged and counted the first time;
 * a play type the table does not know is logged once.
 */
function playsOf(
  state: State,
  league: LeagueId,
  game: GameId,
  entities: Readonly<Record<string, Schema.Json>>
): Effect.Effect<readonly [State, ReadonlyArray<Delivery>]> {
  const unknown = EspnPlay.unknownTypes(Record.values(entities)).filter(
    (type) => !state.loggedTypes.has(type.id)
  )
  return Effect.forEach(Record.toEntries(entities), ([id, entity]) =>
    decodePlay[league](entity).pipe(
      Effect.map((play) => Result.succeed(play)),
      Effect.catch((issue) =>
        (state.undecodedPlays.has(id)
          ? Effect.void
          : Effect.logWarning(`EspnDecode: skipped play ${id}, which does not decode`, issue).pipe(
              Effect.annotateLogs({ league, game }),
              Effect.andThen(Metric.update(Metric.withAttributes(undecodedPlays, { league }), 1))
            )
        ).pipe(Effect.as(Result.fail(id)))
      )
    )
  ).pipe(
    Effect.tap(() =>
      Effect.forEach(
        unknown,
        (type) =>
          Effect.logInfo(
            `EspnDecode: ESPN play type ${type.id} (${type.text}) is not in the table; read as other`
          ),
        { discard: true }
      )
    ),
    Effect.map((decoded) => {
      const [plays, skipped] = Arr.separate(decoded)
      return [
        {
          ...state,
          loggedTypes: new Set([...state.loggedTypes, ...unknown.map((type) => type.id)]),
          undecodedPlays: new Set([...state.undecodedPlays, ...skipped])
        },
        [Delivery.Plays({ game, plays: plays.toSorted(Play.order) })]
      ] as const
    })
  )
}

const decodePlay = {
  nfl: Schema.decodeUnknownEffect(EspnPlay.Play("nfl")),
  fbs: Schema.decodeUnknownEffect(EspnPlay.Play("fbs"))
}

function undecodable(frame: Frame, cause: unknown): Effect.Effect<void> {
  return Effect.logError("EspnDecode: skipped a frame that does not decode", cause).pipe(
    Effect.annotateLogs({ seq: frame.seq, feed: frame.feed, channel: frame.channel, kind: frame.kind }),
    Effect.andThen(Metric.update(Metric.withAttributes(framesUndecoded, { feed: frame.feed }), 1))
  )
}

const framesUndecoded = Metric.counter("sportal_frames_undecoded", {
  description: "Frames that did not decode and were skipped, by feed",
  incremental: true
})

const gamesPushed = Metric.counter("sportal_live_feed_games", {
  description: "Game snapshots the live feed delivered, by league",
  incremental: true
})

const undecodedPlays = Metric.counter("sportal_live_feed_undecoded_plays", {
  description: "ESPN plays that did not decode and were left out of their game's list, each once, by league",
  incremental: true
})

const undecodedEvents = Metric.counter("sportal_live_feed_undecoded", {
  description: "ESPN events, polled or pushed, that did not decode and were skipped, by league",
  incremental: true
})

const liveFeedUnlisted = Metric.counter("sportal_live_feed_unlisted", {
  description: "Pushed games no poll has listed yet, so not sent",
  incremental: true
})
