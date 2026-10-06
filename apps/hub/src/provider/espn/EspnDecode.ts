import { Delivery } from "@sportal/domain/Delivery"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { Team, TeamId } from "@sportal/domain/Team"
import { Array as Arr, DateTime, Effect, Metric, Option, Result, Schema, Stream } from "effect"
import type { Frame } from "../../feed/Frame.ts"
import * as EspnPayload from "./EspnPayload.ts"
import * as EspnPlay from "./EspnPlay.ts"
import * as EspnSnapshot from "./EspnSnapshot.ts"
import * as FastCastDocument from "./FastCastDocument.ts"
import * as FastCastPayload from "./FastCastPayload.ts"

/**
 * What each ESPN frame said, in order. A poll response is its league's `Listing`. A scoreboard topic's change is a
 * pushed `Snapshot` of each game it touched, advanced to the game its league last listed (FastCast has no short
 * names); a game no listing has is counted and not delivered. A game topic's change is a `Plays` of the game's whole
 * list, in `Play.order`. A frame that does not decode is logged with its `seq`, counted, and skipped.
 */
export function decode(
  frames: Stream.Stream<Frame>
): Stream.Stream<{ delivery: Delivery; at: DateTime.Utc; seq: number }> {
  return frames.pipe(
    Stream.mapAccumEffect(
      (): State => ({ listings: new Map(), documents: FastCastDocument.empty, loggedTypes: new Set() }),
      (state, frame) =>
        (frame.feed === "poll" ? listed(state, frame) : pushed(state, frame)).pipe(
          Effect.map(
            ([next, deliveries]) =>
              [
                next,
                deliveries.map((delivery) => ({ delivery, at: frame.receivedAt, seq: frame.seq }))
              ] as const
          )
        )
    )
  )
}

/** The snapshots in one ESPN scoreboard; an event that does not decode is skipped and logged. */
export function slateOf(
  league: LeagueId,
  scoreboard: typeof EspnPayload.Scoreboard.Type
): Effect.Effect<ReadonlyArray<GameSnapshot>> {
  return Effect.forEach(scoreboard.events, (raw) =>
    Option.match(decodeScoreboardEvent(raw), {
      onNone: () =>
        Effect.logWarning("EspnDecode: skipped an event that failed to decode", raw).pipe(
          Effect.as(Option.none())
        ),
      onSome: (event) => Effect.succeed(toSnapshot(league, event))
    })
  ).pipe(Effect.map(Arr.getSomes), Effect.withSpan("EspnDecode.slateOf"))
}

/**
 * The pushed games of each scoreboard change in `frames`, as FastCast spelled them. Only for `LiveFeed.games`, until
 * Ingest takes deliveries.
 */
export function pushedGames<E>(
  frames: Stream.Stream<Frame, E>
): Stream.Stream<ReadonlyArray<GameSnapshot>, E> {
  return frames.pipe(
    Stream.mapAccumEffect(
      () => FastCastDocument.empty,
      (
        documents,
        frame
      ): Effect.Effect<
        readonly [typeof FastCastDocument.empty, ReadonlyArray<ReadonlyArray<GameSnapshot>>]
      > =>
        FastCastDocument.advance(documents, frame).pipe(
          Effect.flatMap(([next, change]) =>
            (Option.isSome(change) && change.value.topic === "scoreboard"
              ? snapshotsOf(change.value.league, change.value.events)
              : Effect.succeed([])
            ).pipe(Effect.map((games) => [next, games.length === 0 ? [] : [games]] as const))
          ),
          Effect.catch((cause) => undecodable(frame, cause).pipe(Effect.as([documents, []] as const)))
        )
    )
  )
}

/** Each league's last listing, the FastCast topics' documents, and the unknown play types already logged. */
type State = {
  readonly listings: ReadonlyMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly documents: typeof FastCastDocument.empty
  readonly loggedTypes: ReadonlySet<string>
}

function listed(state: State, frame: Frame): Effect.Effect<readonly [State, ReadonlyArray<Delivery>]> {
  return Effect.all({ league: decodeLeague(frame.channel), scoreboard: decodeScoreboard(frame.body) }).pipe(
    Effect.flatMap(({ league, scoreboard }) =>
      slateOf(league, scoreboard).pipe(
        Effect.map(
          (games) =>
            [
              { ...state, listings: new Map([...state.listings, [league, games]]) },
              [Delivery.Listing({ league, games })]
            ] as const
        )
      )
    ),
    Effect.catch((cause) => undecodable(frame, cause).pipe(Effect.as([state, []] as const)))
  )
}

const decodeLeague = Schema.decodeUnknownEffect(LeagueId)
const decodeScoreboard = Schema.decodeUnknownEffect(Schema.fromJsonString(EspnPayload.Scoreboard))

const decodeScoreboardEvent = Schema.decodeUnknownOption(EspnPayload.Event)

function toSnapshot(league: LeagueId, event: typeof EspnPayload.Event.Type): Option.Option<GameSnapshot> {
  const competition = event.competitions[0]
  const home = competition.competitors.find((c) => c.homeAway === "home")
  const away = competition.competitors.find((c) => c.homeAway === "away")
  const kickoff = DateTime.make(event.date)
  if (home === undefined || away === undefined || Option.isNone(kickoff)) return Option.none()

  const side = (competitor: typeof home) => ({
    team: new Team({
      id: TeamId.make(`${league}:${competitor.team.id}`),
      abbreviation: competitor.team.abbreviation,
      name: competitor.team.displayName,
      location: competitor.team.location ?? competitor.team.displayName,
      shortName: competitor.team.shortDisplayName ?? competitor.team.displayName,
      logo: competitor.team.logo
    }),
    score: competitor.score ?? 0,
    ranking: competitor.curatedRank?.current
  })

  return Option.some(
    new GameSnapshot({
      id: GameId.make(event.id),
      league,
      kickoff: DateTime.toUtc(kickoff.value),
      status: event.status.type,
      period: event.status.period,
      clock: event.status.displayClock,
      home: side(home),
      away: side(away),
      broadcasts: (competition.geoBroadcasts ?? []).flatMap((broadcast) =>
        EspnSnapshot.broadcast(broadcast.type.shortName, broadcast.media.shortName)
      ),
      situation:
        competition.situation === undefined
          ? undefined
          : EspnSnapshot.situation(league, competition.situation, home.team.id)
    })
  )
}

function pushed(state: State, frame: Frame): Effect.Effect<readonly [State, ReadonlyArray<Delivery>]> {
  return FastCastDocument.advance(state.documents, frame).pipe(
    Effect.flatMap(([documents, change]) => {
      const moved = { ...state, documents }
      return Option.match(change, {
        onNone: () => Effect.succeed([moved, []] as const),
        onSome: (said) =>
          said.topic === "scoreboard"
            ? snapshotsOf(said.league, said.events).pipe(
                Effect.flatMap((games) => advancedToListed(state.listings, games)),
                Effect.map((deliveries) => [moved, deliveries] as const)
              )
            : playsOf(moved, said.league, said.game, said.plays).pipe(
                Effect.catch((cause) => undecodable(frame, cause).pipe(Effect.as([moved, []] as const)))
              )
      })
    }),
    Effect.catch((cause) => undecodable(frame, cause).pipe(Effect.as([state, []] as const)))
  )
}

/** The events as games; an event that does not decode is logged and counted, and the rest still delivered. */
function snapshotsOf(
  league: LeagueId,
  events: ReadonlyArray<Schema.Json>
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
  ).pipe(
    Effect.map(Arr.getSomes),
    Effect.tap((games) => Metric.update(Metric.withAttributes(gamesPushed, { league }), games.length))
  )
}

const decodeEvent = {
  nfl: Schema.decodeUnknownEffect(FastCastPayload.Event("nfl")),
  fbs: Schema.decodeUnknownEffect(FastCastPayload.Event("fbs"))
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

function playsOf(
  state: State,
  league: LeagueId,
  game: GameId,
  entities: ReadonlyArray<Schema.Json>
): Effect.Effect<readonly [State, ReadonlyArray<Delivery>], Schema.SchemaError> {
  const unknown = EspnPlay.unknownTypes(entities).filter((type) => !state.loggedTypes.has(type.id))
  return decodePlays[league](entities).pipe(
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
    Effect.map(
      (plays) =>
        [
          { ...state, loggedTypes: new Set([...state.loggedTypes, ...unknown.map((type) => type.id)]) },
          [Delivery.Plays({ game, plays: plays.toSorted(Play.order) })]
        ] as const
    )
  )
}

const decodePlays = {
  nfl: Schema.decodeUnknownEffect(Schema.Array(EspnPlay.Play("nfl"))),
  fbs: Schema.decodeUnknownEffect(Schema.Array(EspnPlay.Play("fbs")))
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

const undecodedEvents = Metric.counter("sportal_live_feed_undecoded", {
  description: "Events the live feed changed in a way that no longer decodes, by league",
  incremental: true
})

const liveFeedUnlisted = Metric.counter("sportal_live_feed_unlisted", {
  description: "Pushed games no poll has listed yet, so not sent",
  incremental: true
})
