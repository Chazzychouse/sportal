import { Game, type GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Array as Arr, Data, Effect, HashMap, Metric, Option, Record } from "effect"
import { Delivery } from "../../slate/Delivery.ts"
import * as EspnDecoder from "./EspnDecoder.ts"
import * as FastCastDocument from "./FastCastDocument.ts"
import { Frame } from "./Frame.ts"
import { tcOf } from "./Topic.ts"

/**
 * What ESPN has said, every frame folded in once: each FastCast topic's document, and each league's listed games, as its
 * last poll listed them, each moved forward by every push since.
 */
export class EspnState extends Data.Class<{
  readonly documents: typeof FastCastDocument.empty
  readonly listings: HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>
}> {
  static readonly empty: EspnState = new EspnState({
    documents: FastCastDocument.empty,
    listings: HashMap.empty()
  })

  /**
   * This state after `frame`, and what the frame said. A poll is its league's `Listing` of the games it shows; the
   * listing it keeps holds, for a game a push moved past the poll, the pushed one (`Game#listed`). A scoreboard topic's
   * change is a `Snapshot` of each listed game it touched, advanced to it (FastCast has no short names), and moves that
   * game forward in its listing; a game no listing has is not delivered. A game topic's change is a `Plays` of the
   * game's whole list, in `Play.order`. An event or a play that does not decode is skipped. A frame that does not decode
   * says nothing, leaves the state as it was, and is logged.
   */
  take(frame: Frame): Effect.Effect<readonly [EspnState, ReadonlyArray<Delivery>]> {
    return taken(this, frame)
  }

  /** Every listed game, as the state has it. */
  games(): ReadonlyArray<GameSnapshot> {
    return [...HashMap.values(this.listings)].flat()
  }
}

const taken = Effect.fnUntraced(
  function* (state: EspnState, frame: Frame) {
    return yield* Frame.$match(frame, {
      Polled: ({ league, body }) => listed(state, league, body),
      Pushed: () => pushed(state, frame),
      Checkpoint: () => pushed(state, frame)
    })
  },
  (effect, state, frame) =>
    Effect.catch(effect, (cause) =>
      Effect.logWarning("EspnState: skipped a frame that does not decode", cause).pipe(
        Effect.annotateLogs(annotationsOf(frame)),
        Effect.as([state, noDeliveries] as const)
      )
    )
)

const listed = Effect.fnUntraced(function* (state: EspnState, league: LeagueId, body: string) {
  const scoreboard = yield* EspnDecoder.byLeague[league].decodeScoreboard(body)
  const games = yield* EspnDecoder.gamesOf(league, scoreboard.events)

  const had = Option.getOrElse(HashMap.get(state.listings, league), () => [])
  const kept = games.map((game) => keptOver(had, game))
  const next = new EspnState({ ...state, listings: HashMap.set(state.listings, league, kept) })
  return [next, [Delivery.cases.Listing.make({ league, games })]] as const
})

/** A polled `game` as its listing keeps it: the one `had` held when a push moved it past the poll (`Game#listed`). */
function keptOver(had: ReadonlyArray<GameSnapshot>, game: GameSnapshot): GameSnapshot {
  return Option.match(
    Arr.findFirst(had, (each) => each.id === game.id),
    {
      onNone: () => game,
      onSome: (pushed) => Game.of(pushed).listed(game).snapshot
    }
  )
}

const noDeliveries: ReadonlyArray<Delivery> = []

const pushed = Effect.fnUntraced(function* (state: EspnState, frame: Frame) {
  const { documents, change } = yield* FastCastDocument.advance(state.documents, frame)

  const advanced = new EspnState({ ...state, documents })
  return yield* Option.match(change, {
    onNone: () => Effect.succeed([advanced, noDeliveries] as const),
    onSome: FastCastDocument.Change.$match({
      Scoreboard: ({ league, events }) =>
        Effect.flatMap(EspnDecoder.gamesOf(league, events), (games) => {
          const [next, deliveries, behind] = movedForward(advanced, league, games)
          return Effect.as(
            Effect.forEach(behind, (game) => pushBehind(league, game), { discard: true }),
            [next, deliveries] as const
          )
        }),
      Game: ({ league, game, plays }) =>
        Effect.map(
          EspnDecoder.playsOf(league, plays),
          (sorted) => [advanced, [Delivery.cases.Plays.make({ game, plays: sorted })]] as const
        ),
      Reset: () => Effect.succeed([advanced, noDeliveries] as const)
    })
  })
})

/** Logs and counts a push `game` that is behind the game its `league` lists, which the listing takes anyway. */
function pushBehind(league: LeagueId, game: GameSnapshot) {
  return Effect.logInfo("EspnState: a push is behind its listed game; the listing takes it").pipe(
    Effect.annotateLogs({ game: game.id, league, matchup: game.matchup() }),
    Effect.andThen(Metric.update(Metric.withAttributes(pushesBehind, { league }), 1))
  )
}

/**
 * `state` with each pushed game its league lists moved forward in the listing, a `Snapshot` of each, and the pushed
 * games that were behind their listed game. A push behind its listed game is still taken: the listing goes back to it.
 * `pushed` logs and counts those.
 */
function movedForward(
  state: EspnState,
  league: LeagueId,
  games: ReadonlyArray<GameSnapshot>
): readonly [EspnState, ReadonlyArray<Delivery>, ReadonlyArray<GameSnapshot>] {
  const listing = Option.getOrElse(HashMap.get(state.listings, league), () => [])
  const advanced = games.flatMap((game) =>
    Arr.findFirst(listing, (listedGame) => listedGame.id === game.id).pipe(
      Option.map((listedGame) => listedGame.advancedTo(game)),
      Option.toArray
    )
  )
  if (advanced.length === 0) return [state, noDeliveries, []]

  const behind = advanced.filter((game) =>
    listing.some((listedGame) => listedGame.id === game.id && game.isBehind(listedGame))
  )
  const moved = listing.map((listedGame) => advanced.find((game) => game.id === listedGame.id) ?? listedGame)
  const next = new EspnState({ ...state, listings: HashMap.set(state.listings, league, moved) })
  return [next, advanced.map((snapshot) => Delivery.cases.Snapshot.make({ snapshot })), behind]
}

/** What a log of `frame` is annotated with: its kind, and its league or its topic's name. */
function annotationsOf(frame: Frame): Readonly<Record<string, string>> {
  return Frame.$match(frame, {
    Polled: ({ league }) => ({ frame: "Polled", league }),
    Pushed: ({ topic }) => ({ frame: "Pushed", ...Record.getSomes({ topic: Option.map(topic, tcOf) }) }),
    Checkpoint: ({ topic }) => ({ frame: "Checkpoint", topic: tcOf(topic) })
  })
}

const pushesBehind = Metric.counter("sportal_push_behind_listing", {
  description: "Pushed snapshots behind their listed game, which the listing takes anyway, by league",
  incremental: true
})
