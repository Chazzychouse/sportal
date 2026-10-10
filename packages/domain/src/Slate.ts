import { Data, Schema } from "effect"
import { Game, type GameId, type GameSnapshot } from "./Game.ts"
import { LeagueId } from "./League.ts"
import type { Play } from "./Play.ts"

/**
 * The slate: the games each league's last listing names, in its order, each with its latest snapshot not behind the one
 * before it and its plays. Pure: each operation returns the next slate and what it changed; one that changes nothing
 * gives back this slate itself and no change, and a game it does not change stays the same `Game`.
 */
export class Slate extends Schema.Class<Slate>("sportal/Slate")({
  /** The listed games: leagues in `LeagueId.literals` order, each league's in its listing's order. */
  games: Schema.Array(Game)
}) {
  static readonly empty: Slate = new Slate({ games: [] })

  /**
   * League `league` listing `snapshots`: its games, in their order, each taken into the game the slate had
   * (`Game#snapshotTaken`) or new; each game it no longer names is delisted.
   */
  relisted(league: LeagueId, snapshots: ReadonlyArray<GameSnapshot>): Taken {
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

  /** Game `id`'s whole list of plays, `plays`, taken into it (`Game#playsTaken`); dropped when the slate lacks it. */
  playsTaken(id: GameId, plays: ReadonlyArray<Play>): Taken {
    const index = this.games.findIndex((game) => game.snapshot.id === id)
    const had = this.games[index]
    if (had === undefined) return [this, []]

    const next = had.playsTaken(plays)
    if (next === had) return [this, []]

    return [new Slate({ games: this.games.with(index, next) }), changesOf(had, next)]
  }

  /** This slate with each game's recent plays only (`Game#recent`): what the live stream sends. */
  recent(): Slate {
    const games = this.games.map((game) => game.recent())
    if (games.every((game, index) => game === this.games[index])) return this

    return new Slate({ games })
  }
}

/** One thing an operation changed: a game's snapshot, a game no listing names any more, or a play a game did not have. */
export type SlateChange = Data.TaggedEnum<{
  /** A listed game's snapshot changed, or a listing named it for the first time. */
  Progressed: { readonly game: Game }
  /** No listing of its league names it any more. */
  Delisted: { readonly game: Game }
  /** A play its game did not have before. */
  Played: { readonly game: Game; readonly play: Play }
}>
export const SlateChange = Data.taggedEnum<SlateChange>()

/** The next slate, and what an operation changed to reach it. */
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
