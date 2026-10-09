import { LiveMessage, type SlateChanged } from "@sportal/api/LiveMessage"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { Game, type GameId, type GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import type { Play } from "@sportal/domain/Play"
import { Array as Arr, Data, type Option } from "effect"
import { Delivery } from "./provider/Provider.ts"

/**
 * The slate: the games each league's last listing names, in its order, each with its latest snapshot not behind the one
 * before it and its plays. Pure: `take` returns the next slate and what it changed.
 */
export class Slate extends Data.Class<{
  /** The listed games: leagues in `LeagueId.literals` order, each league's in its listing's order. */
  readonly games: ReadonlyArray<Game>
}> {
  static readonly empty: Slate = new Slate({ games: [] })

  /**
   * Takes one frame's deliveries, in order, and gives the next slate with what each delivery changed, in order. A listing
   * replaces its league's games with the ones it names, each taken into the game the slate had (`Game#listed`) or new. A
   * snapshot or plays of a listed game are taken into it (`Game#snapshotTaken`, `Game#playsTaken`); of a game no listing
   * names, dropped. A take that changes nothing gives back this slate itself and no change, and a game it does not
   * change stays the same `Game`.
   */
  take(deliveries: ReadonlyArray<Delivery>): Taken {
    return deliveries.reduce<Taken>(
      ([slate, changes], delivery) => {
        const [next, changed] = slate.delivered(delivery)
        return [next, [...changes, ...changed]]
      },
      [this, []]
    )
  }

  /** Game `id`, where the slate has it. */
  game(id: GameId): Option.Option<Game> {
    return Arr.findFirst(this.games, ({ snapshot }) => snapshot.id === id)
  }

  /** What the live stream sends of it: every listed game, with its recent plays, beside `availabilityOf` it. */
  published(availabilityOf: (game: GameSnapshot) => ReadonlyArray<ChannelAvailability>): SlateChanged {
    const games = this.games.map((game) => ({
      game: game.recent(),
      availability: availabilityOf(game.snapshot)
    }))
    return LiveMessage.cases.SlateChanged.make({ games })
  }

  private delivered(delivery: Delivery): Taken {
    return Delivery.$match(delivery, {
      Listing: ({ league, games }) => this.relisted(league, games),
      Snapshot: ({ snapshot }) => this.changed(snapshot.id, (game) => game.snapshotTaken(snapshot)),
      Plays: ({ game, plays }) => this.changed(game, (had) => had.playsTaken(plays))
    })
  }

  /**
   * League `league` listing `snapshots`: its games, in their order, each taken into the game the slate had; each game it
   * no longer names is delisted.
   */
  private relisted(league: LeagueId, snapshots: ReadonlyArray<GameSnapshot>): Taken {
    const had = this.games.filter((game) => game.snapshot.league === league)
    const listed = snapshots.map((snapshot) => {
      const game = had.find((each) => each.snapshot.id === snapshot.id)
      return game === undefined ? Game.of(snapshot) : game.listed(snapshot)
    })
    if (sameGames(listed, had)) return [this, []]

    const games = LeagueId.literals.flatMap((each) =>
      each === league ? listed : this.games.filter((game) => game.snapshot.league === each)
    )
    const delisted = had
      .filter((game) => !listed.some((each) => each.snapshot.id === game.snapshot.id))
      .map((game) => SlateChange.Delisted({ game }))
    const changed = listed.flatMap((game) =>
      changesOf(
        had.find((each) => each.snapshot.id === game.snapshot.id),
        game
      )
    )
    return [new Slate({ games }), [...delisted, ...changed]]
  }

  /** Game `id` changed by `change`, where the slate has it. */
  private changed(id: GameId, change: (game: Game) => Game): Taken {
    const index = this.games.findIndex((game) => game.snapshot.id === id)
    const had = this.games[index]
    if (had === undefined) return [this, []]

    const next = change(had)
    if (next === had) return [this, []]

    return [new Slate({ games: this.games.with(index, next) }), changesOf(had, next)]
  }
}

/** One thing a take changed: a game's snapshot, a game no listing names any more, or a play a game did not have. */
export type SlateChange = Data.TaggedEnum<{
  /** A listed game's snapshot changed, or a listing named it for the first time. */
  Progressed: { readonly game: Game }
  /** No listing of its league names it any more. */
  Delisted: { readonly game: Game }
  /** A play its game did not have before. */
  Played: { readonly game: Game; readonly play: Play }
}>
export const SlateChange = Data.taggedEnum<SlateChange>()

/** The next slate, and what a take changed to reach it. */
type Taken = readonly [Slate, ReadonlyArray<SlateChange>]

/** Whether `games` are the very games `had`, in the same order. */
function sameGames(games: ReadonlyArray<Game>, had: ReadonlyArray<Game>): boolean {
  return games.length === had.length && games.every((game, index) => game === had[index])
}

/** What `next` changed of `had`, none when the slate did not have it: its snapshot, then each play it added. */
function changesOf(had: Game | undefined, next: Game): ReadonlyArray<SlateChange> {
  if (had === next) return []

  const progressed = had?.snapshot === next.snapshot ? [] : [SlateChange.Progressed({ game: next })]
  const played = next
    .playsAfter(had ?? Game.of(next.snapshot))
    .map((play) => SlateChange.Played({ game: next, play }))
  return [...progressed, ...played]
}
