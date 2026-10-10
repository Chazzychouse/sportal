import type { GameId, GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Play } from "@sportal/domain/Play"
import { Data, type DateTime, Effect, HashMap, HashSet, Option, Record, Schema } from "effect"
import { Delivery } from "../Provider.ts"
import * as EspnPlay from "./EspnPlay.ts"
import { Frame, Topic } from "./FastCast.ts"
import { DocumentChange, FastCastDocuments } from "./FastCastDocuments.ts"

/** Each followed FastCast game topic's document, and the plays decoded from it, every frame folded in once. */
export class GameTopics extends Data.Class<{
  readonly documents: FastCastDocuments
  readonly plays: HashMap.HashMap<GameId, HashMap.HashMap<string, Play>>
}> {
  static readonly empty: GameTopics = new GameTopics({
    documents: FastCastDocuments.empty,
    plays: HashMap.empty()
  })

  /**
   * These topics after `frame`, and what the frame said: a game topic's change is a `Plays` of the game's whole list,
   * in `Play.order`. A play that does not decode is skipped. A frame that does not decode says nothing, leaves the
   * topics as they were, and is logged.
   */
  take(frame: Frame): Effect.Effect<readonly [GameTopics, ReadonlyArray<Delivery>]> {
    return taken(this, frame)
  }

  /** These topics, keeping only those `kept` says, each with its document and the plays decoded from it. */
  retained(kept: (topic: Topic) => boolean): GameTopics {
    const documents = this.documents.retained(kept)
    const games = new Set([...HashMap.keys(documents.byTopic)].map((topic) => topic.game))
    return new GameTopics({ documents, plays: HashMap.filter(this.plays, (_, game) => games.has(game)) })
  }

  /** These topics, keeping only those of `games` that `Topic.wantedAt` wants at `now`. */
  retainedFor(games: Iterable<GameSnapshot>, now: DateTime.Utc): GameTopics {
    const wanted = Topic.wantedAt(games, now)
    return this.retained((topic) => HashSet.has(wanted, topic))
  }

  /** Whether `topic`'s document is synced: its checkpoint read, and every message since applied. */
  isSynced(topic: Topic): boolean {
    return this.documents.isSynced(topic)
  }
}

const taken = Effect.fnUntraced(
  function* (topics: GameTopics, frame: Frame) {
    const { documents, change } = yield* topics.documents.advance(frame)

    const advanced = new GameTopics({ ...topics, documents })
    return yield* Option.match(change, {
      onNone: () => Effect.succeed([advanced, noDeliveries] as const),
      onSome: DocumentChange.$match({
        Game: ({ league, game, plays, touched }) =>
          Effect.map(playsAfter(advanced, game, league, plays, touched), (byId) => {
            const next = new GameTopics({ ...advanced, plays: HashMap.set(advanced.plays, game, byId) })
            const list = [...HashMap.values(byId)].toSorted(Play.order)
            return [next, [Delivery.Plays({ game, plays: list })]] as const
          }),
        Reset: ({ topic, detail }) =>
          Effect.logWarning(`GameTopics: ${topic.tc()} lost its document (${detail})`).pipe(
            Effect.annotateLogs({ topic: topic.tc() }),
            Effect.as([advanced, noDeliveries] as const)
          )
      })
    })
  },
  (effect, topics, frame) =>
    Effect.catch(effect, (cause) =>
      Effect.logWarning("GameTopics: skipped a frame that does not decode", cause).pipe(
        Effect.annotateLogs(annotationsOf(frame)),
        Effect.as([topics, noDeliveries] as const)
      )
    )
)

const noDeliveries: ReadonlyArray<Delivery> = []

/**
 * Game `game`'s plays by id after a change: each touched entity decoded again, or dropped when it is gone or does
 * not decode; every entity when nothing says which were touched.
 */
const playsAfter = Effect.fnUntraced(function* (
  topics: GameTopics,
  game: GameId,
  league: LeagueId,
  entities: Readonly<Record<string, Schema.Json>>,
  touched: Option.Option<ReadonlyArray<string>>
) {
  const had = Option.match(touched, {
    onNone: () => HashMap.empty<string, Play>(),
    onSome: () => Option.getOrElse(HashMap.get(topics.plays, game), () => HashMap.empty<string, Play>())
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

/** What a log of `frame` is annotated with: its kind, and its topic's name. */
function annotationsOf(frame: Frame): Readonly<Record<string, string>> {
  return Frame.$match(frame, {
    Pushed: ({ topic }) => ({
      frame: "Pushed",
      ...Record.getSomes({ topic: Option.map(topic, (each) => each.tc()) })
    }),
    Checkpoint: ({ topic }) => ({ frame: "Checkpoint", topic: topic.tc() })
  })
}

// Each league's play entity decode, built once.
const decodePlay: { readonly [L in LeagueId]: ReturnType<typeof decodePlayOf> } = {
  nfl: decodePlayOf("nfl"),
  fbs: decodePlayOf("fbs")
}

function decodePlayOf(league: LeagueId) {
  return Schema.decodeUnknownEffect(EspnPlay.FootballPlay(league))
}
