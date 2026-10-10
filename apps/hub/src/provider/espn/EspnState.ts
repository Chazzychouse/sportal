import { type GameId, GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import {
  Array as Arr,
  Data,
  DateTime,
  Duration,
  Effect,
  HashMap,
  HashSet,
  Option,
  Record,
  Schema
} from "effect"
import { Delivery } from "../Provider.ts"
import { EspnEvent } from "./EspnEvent.ts"
import { Scoreboard } from "./EspnPayload.ts"
import * as EspnPlay from "./EspnPlay.ts"
import type { Wanted } from "./FastCast.ts"
import { DocumentChange, FastCastDocuments } from "./FastCastDocuments.ts"
import { Frame } from "./Frame.ts"
import { Topic } from "./Topic.ts"

/**
 * What ESPN has said, every frame folded in once: each game topic's document, and each league's listed games, as its
 * last poll showed them. Which snapshot wins is the Slate's rule, not the state's.
 */
export class EspnState extends Data.Class<{
  readonly documents: FastCastDocuments
  readonly listings: HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>
  readonly plays: HashMap.HashMap<GameId, HashMap.HashMap<string, Play>>
  readonly failedPolls: HashSet.HashSet<LeagueId>
}> {
  static readonly empty: EspnState = new EspnState({
    documents: FastCastDocuments.empty,
    listings: HashMap.empty(),
    plays: HashMap.empty(),
    failedPolls: HashSet.empty()
  })

  /**
   * This state after `frame`, and what the frame said. A poll is its league's `Listing` of the games it shows, as it
   * shows them. A game topic's change is a `Plays` of the game's whole list, in `Play.order`. An event or a play
   * that does not decode is skipped. A frame that does not decode says nothing, leaves the state as it was, and is logged.
   * A failed poll, or one whose scoreboard does not decode, marks its league's poll failed until a poll of it lists.
   * After any poll, failed or not, the state keeps documents and decoded plays only for the topics wanted at
   * the clock's now; a push or checkpoint prunes nothing.
   */
  take(frame: Frame): Effect.Effect<readonly [EspnState, ReadonlyArray<Delivery>]> {
    return Effect.flatMap(taken(this, frame), ([next, deliveries]) => {
      const wasPoll = Frame.$is("Polled")(frame) || Frame.$is("PollFailed")(frame)
      if (!wasPoll) return Effect.succeed([next, deliveries] as const)

      return Effect.map(DateTime.now, (now) => [next.retained(now), deliveries] as const)
    })
  }

  /** League `league`'s listed games, as the state has them; none before its first poll. */
  listing(league: LeagueId): ReadonlyArray<GameSnapshot> {
    return Option.getOrElse(HashMap.get(this.listings, league), () => [])
  }

  /** Every listed game, as the state has it. */
  games(): ReadonlyArray<GameSnapshot> {
    return [...HashMap.values(this.listings)].flat()
  }

  /**
   * What FastCast follows at `now`: the topic of each listed game live or kicking off within
   * `GameSnapshot.kickoffWindow`, each with whether its document is synced.
   */
  wanted(now: DateTime.Utc): Wanted {
    const topics = this.games()
      .filter((game) => game.isLiveOrKicksOffWithin(GameSnapshot.kickoffWindow, now))
      .map((game) => new Topic({ league: game.league, game: game.id }))
    return HashMap.fromIterable(
      topics.map(
        (topic) => [topic, this.documents.isSynced(topic) ? "Synced" : "AwaitingCheckpoint"] as const
      )
    )
  }

  /**
   * How long `league` waits after its latest poll has been taken, by its own listed games: 10 seconds while one is
   * live, a minute while one kicks off within `GameSnapshot.kickoffWindow`, and 15 minutes otherwise; at most 30
   * seconds while its last poll failed or did not decode, so its scoreboard is read again soon.
   */
  pollInterval(league: LeagueId, now: DateTime.Utc): Duration.Duration {
    const games = this.listing(league)
    const normal = games.some((game) => game.progress() === "live")
      ? Duration.seconds(10)
      : games.some((game) => game.isLiveOrKicksOffWithin(GameSnapshot.kickoffWindow, now))
        ? Duration.minutes(1)
        : Duration.minutes(15)
    return HashSet.has(this.failedPolls, league) ? Duration.min(normal, Duration.seconds(30)) : normal
  }

  /** This state keeping documents and decoded plays only for the topics wanted at `now`. */
  private retained(now: DateTime.Utc): EspnState {
    const wanted = this.wanted(now)
    const games = new Set([...HashMap.keys(wanted)].map((topic) => topic.game))
    return new EspnState({
      ...this,
      documents: this.documents.retained((topic) => HashMap.has(wanted, topic)),
      plays: HashMap.filter(this.plays, (_, game) => games.has(game))
    })
  }
}

const taken = Effect.fnUntraced(
  function* (state: EspnState, frame: Frame) {
    return yield* Frame.$match(frame, {
      Polled: ({ league, body }) => listed(state, league, body),
      PollFailed: ({ league }) => Effect.succeed([pollFailed(state, league), noDeliveries] as const),
      Pushed: (each) => pushed(state, each),
      Checkpoint: (each) => pushed(state, each)
    })
  },
  (effect, state, frame) =>
    Effect.catch(effect, (cause) =>
      Effect.logWarning("EspnState: skipped a frame that does not decode", cause).pipe(
        Effect.annotateLogs(annotationsOf(frame)),
        Effect.as([
          Frame.$is("Polled")(frame) ? pollFailed(state, frame.league) : state,
          noDeliveries
        ] as const)
      )
    )
)

/** `state` with `league`'s poll failed: its last poll brought nothing it could list. */
function pollFailed(state: EspnState, league: LeagueId): EspnState {
  return new EspnState({ ...state, failedPolls: HashSet.add(state.failedPolls, league) })
}

const listed = Effect.fnUntraced(function* (state: EspnState, league: LeagueId, body: string) {
  const scoreboard = yield* decodeScoreboard(body)
  const games = yield* gamesOf(league, scoreboard.events)

  const next = new EspnState({
    ...state,
    listings: HashMap.set(state.listings, league, games),
    failedPolls: HashSet.remove(state.failedPolls, league)
  })
  return [next, [Delivery.Listing({ league, games })]] as const
})

/** The events as games; an event that does not decode is skipped, and the rest still delivered. */
const gamesOf = Effect.fnUntraced(function* (league: LeagueId, events: ReadonlyArray<unknown>) {
  const decoded = yield* Effect.forEach(events, (event) => Effect.option(decodeEvent[league](event)))
  return Arr.getSomes(decoded)
})

const noDeliveries: ReadonlyArray<Delivery> = []

const pushed = Effect.fnUntraced(function* (
  state: EspnState,
  frame: Data.TaggedEnum.Value<Frame, "Pushed" | "Checkpoint">
) {
  const { documents, change } = yield* state.documents.advance(frame)

  const advanced = new EspnState({ ...state, documents })
  return yield* Option.match(change, {
    onNone: () => Effect.succeed([advanced, noDeliveries] as const),
    onSome: DocumentChange.$match({
      Game: ({ league, game, plays, touched }) =>
        Effect.map(playsAfter(advanced, game, league, plays, touched), (byId) => {
          const next = new EspnState({ ...advanced, plays: HashMap.set(advanced.plays, game, byId) })
          const list = [...HashMap.values(byId)].toSorted(Play.order)
          return [next, [Delivery.Plays({ game, plays: list })]] as const
        }),
      Reset: ({ topic, detail }) =>
        Effect.logWarning(`EspnState: ${topic.tc()} lost its document (${detail})`).pipe(
          Effect.annotateLogs({ topic: topic.tc() }),
          Effect.as([advanced, noDeliveries] as const)
        )
    })
  })
})

/**
 * Game `game`'s plays by id after a change: each touched entity decoded again, or dropped when it is gone or does
 * not decode; every entity when nothing says which were touched.
 */
const playsAfter = Effect.fnUntraced(function* (
  state: EspnState,
  game: GameId,
  league: LeagueId,
  entities: Readonly<Record<string, Schema.Json>>,
  touched: Option.Option<ReadonlyArray<string>>
) {
  const had = Option.match(touched, {
    onNone: () => HashMap.empty<string, Play>(),
    onSome: () => Option.getOrElse(HashMap.get(state.plays, game), () => HashMap.empty<string, Play>())
  })
  const ids = Option.getOrElse(touched, () => Record.keys(entities))
  return yield* Effect.reduce(
    ids,
    () => had,
    (byId, id) =>
      Option.match(Record.get(entities, id), {
        onNone: () => Effect.succeed(HashMap.remove(byId, id)),
        onSome: (entity) =>
          Effect.map(Effect.option(decodePlay[league](entity)), (play) =>
            Option.match(play, {
              onNone: () => HashMap.remove(byId, id),
              onSome: (decoded) => HashMap.set(byId, id, decoded)
            })
          )
      })
  )
})

/** What a log of `frame` is annotated with: its kind, and its league or its topic's name. */
function annotationsOf(frame: Frame): Readonly<Record<string, string>> {
  return Frame.$match(frame, {
    Polled: ({ league }) => ({ frame: "Polled", league }),
    PollFailed: ({ league }) => ({ frame: "PollFailed", league }),
    Pushed: ({ topic }) => ({
      frame: "Pushed",
      ...Record.getSomes({ topic: Option.map(topic, (each) => each.tc()) })
    }),
    Checkpoint: ({ topic }) => ({ frame: "Checkpoint", topic: topic.tc() })
  })
}

const decodeScoreboard = Schema.decodeUnknownEffect(Schema.fromJsonString(Scoreboard))

// Each league's decode, built once: a site event and a play entity.
const decodeEvent: { readonly [L in LeagueId]: ReturnType<typeof decodeEventOf> } = {
  nfl: decodeEventOf("nfl"),
  fbs: decodeEventOf("fbs")
}

function decodeEventOf(league: LeagueId) {
  return Schema.decodeUnknownEffect(EspnEvent(league))
}

const decodePlay: { readonly [L in LeagueId]: ReturnType<typeof decodePlayOf> } = {
  nfl: decodePlayOf("nfl"),
  fbs: decodePlayOf("fbs")
}

function decodePlayOf(league: LeagueId) {
  return Schema.decodeUnknownEffect(EspnPlay.FootballPlay(league))
}
