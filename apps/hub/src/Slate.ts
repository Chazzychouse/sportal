import { Game, type GameId, type GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import type { Play } from "@sportal/domain/Play"
import { Data } from "effect"
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
   * replaces its league's games with the ones it names, each taken into the game the slate had (`Game#snapshotTaken`) or
   * new. Plays of a listed game are taken into it (`Game#playsTaken`); of a game no listing names, dropped. A take that changes nothing gives back this slate itself and no change, and a game it does not
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

  private delivered(delivery: Delivery): Taken {
    return Delivery.$match(delivery, {
      Listing: ({ league, games }) => this.relisted(league, games),
      Plays: ({ game, plays }) => this.changed(game, (had) => had.playsTaken(plays))
    })
  }

  /**
   * League `league` listing `snapshots`: its games, in their order, each taken into the game the slate had; each game it
   * no longer names is delisted.
   */
  private relisted(league: LeagueId, snapshots: ReadonlyArray<GameSnapshot>): Taken {
    const had = this.games.filter((game) => game.snapshot.league === league)
    const taken = snapshots.map((snapshot) => {
      const before = had.find((each) => each.snapshot.id === snapshot.id)
      return { before, game: before === undefined ? Game.of(snapshot) : before.snapshotTaken(snapshot) }
    })
    const listed = taken.map(({ game }) => game)
    if (listed.length === had.length && listed.every((game, index) => game === had[index])) return [this, []]

    const games = LeagueId.literals.flatMap((each) =>
      each === league ? listed : this.games.filter((game) => game.snapshot.league === each)
    )
    const delisted = had
      .filter((game) => !listed.some((each) => each.snapshot.id === game.snapshot.id))
      .map((game) => SlateChange.Delisted({ game }))
    const changed = taken.flatMap(({ before, game }) => changesOf(before, game))
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

/** What `next` changed of `had`, none when the slate did not have it: its snapshot, then each play it added. */
function changesOf(had: Game | undefined, next: Game): ReadonlyArray<SlateChange> {
  if (had === next) return []

  const progressed = had?.snapshot === next.snapshot ? [] : [SlateChange.Progressed({ game: next })]
  const played = next
    .playsAfter(had ?? Game.of(next.snapshot))
    .map((play) => SlateChange.Played({ game: next, play }))
  return [...progressed, ...played]
}
