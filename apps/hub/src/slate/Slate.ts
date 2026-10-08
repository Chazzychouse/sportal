import { LiveMessage, type SlateChanged } from "@sportal/api/LiveMessage"
import { Game, type GameId, type GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Array as Arr, Data, type Option } from "effect"
import { Delivery } from "./Delivery.ts"

/**
 * The slate: the games each league's last listing names, in its order, each with its latest snapshot not behind the one
 * before it and its plays. Pure: `take` returns the next slate.
 */
export class Slate extends Data.Class<{
  /** The listed games: leagues in `LeagueId.literals` order, each league's in its listing's order. */
  readonly games: ReadonlyArray<Game>
}> {
  static readonly empty: Slate = new Slate({ games: [] })

  /**
   * Takes one frame's deliveries, in order. A listing replaces its league's games with the ones it names, each taken
   * into the game the slate had (`Game#listed`) or new. A snapshot or plays of a listed game are taken into it
   * (`Game#snapshotTaken`, `Game#playsTaken`); of a game no listing names, dropped. A take that changes nothing gives
   * back this slate itself, and a game it does not change stays the same `Game`.
   */
  take(deliveries: ReadonlyArray<Delivery>): Slate {
    return deliveries.reduce<Slate>((slate, delivery) => slate.delivered(delivery), this)
  }

  /** Game `id`, where the slate has it. */
  game(id: GameId): Option.Option<Game> {
    return Arr.findFirst(this.games, ({ snapshot }) => snapshot.id === id)
  }

  /** What the live stream sends of it: every listed game, with its recent plays. */
  published(): SlateChanged {
    const games = this.games.map((game) => game.recent())
    return LiveMessage.cases.SlateChanged.make({ games })
  }

  private delivered(delivery: Delivery): Slate {
    return Delivery.match(delivery, {
      Listing: ({ league, games }) => this.relisted(league, games),
      Snapshot: ({ snapshot }) => this.changed(snapshot.id, (game) => game.snapshotTaken(snapshot)),
      Plays: ({ game, plays }) => this.changed(game, (had) => had.playsTaken(plays))
    })
  }

  /** League `league` listing `snapshots`: its games, in their order, each taken into the game the slate had. */
  private relisted(league: LeagueId, snapshots: ReadonlyArray<GameSnapshot>): Slate {
    const had = this.games.filter((game) => game.snapshot.league === league)
    const listed = snapshots.map((snapshot) => {
      const game = had.find((each) => each.snapshot.id === snapshot.id)
      return game === undefined ? Game.of(snapshot) : game.listed(snapshot)
    })
    if (sameGames(listed, had)) return this

    const games = LeagueId.literals.flatMap((each) =>
      each === league ? listed : this.games.filter((game) => game.snapshot.league === each)
    )
    return new Slate({ games })
  }

  /** Game `id` changed by `change`, where the slate has it. */
  private changed(id: GameId, change: (game: Game) => Game): Slate {
    const index = this.games.findIndex((game) => game.snapshot.id === id)
    const had = this.games[index]
    if (had === undefined) return this

    const next = change(had)
    return next === had ? this : new Slate({ games: this.games.with(index, next) })
  }
}

/** Whether `games` are the very games `had`, in the same order. */
function sameGames(games: ReadonlyArray<Game>, had: ReadonlyArray<Game>): boolean {
  return games.length === had.length && games.every((game, index) => game === had[index])
}
