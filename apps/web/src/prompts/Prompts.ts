import type { SlateChanged } from "@sportal/api/LiveMessage"
import { GameId } from "@sportal/domain/Game"
import type { Slate } from "@sportal/domain/Slate"
import { Array as Arr, DateTime, Option, Order, Record as Rec, Schema } from "effect"
import { byRank, outranks, type Rank, rankOf } from "../autopilot/Ranking.ts"
import { Screen, Tile } from "../screen/Screen.ts"
import { Prompt } from "./Prompt.ts"

type Classifications = SlateChanged["classifications"]

/**
 * A Display's prompts: on or off, and the games you dismissed. A prompt asks to bring a game on no tile into the main
 * tile while it is in a red zone or crunch time, a source can stream it, and it has an empty slot to go to or outranks
 * the weakest game on screen. Pure.
 */
export class Prompts extends Schema.Class<Prompts>("sportal/Prompts")({
  on: Schema.Boolean,
  /** Each game you dismissed, and the `since` of the moment you dismissed it in. */
  dismissed: Schema.Record(GameId, Schema.DateTimeUtcFromString)
}) {
  /** On, nothing dismissed. */
  static readonly initial: Prompts = new Prompts({ on: true, dismissed: {} })

  /** Off when on, on when off; the dismissals kept. */
  toggle(): Prompts {
    return new Prompts({ ...this, on: !this.on })
  }

  /**
   * The prompt to show on `screen` with `live`: of the games that qualify, the best by rank, then score, then slate
   * order. None while off or soloed.
   */
  prompt(
    screen: Screen,
    live: {
      readonly slate: Slate
      readonly availability: SlateChanged["availability"]
      readonly classifications: Classifications
    }
  ): Option.Option<Prompt> {
    if (!this.on || Option.isSome(screen.solo)) return Option.none()
    const { slate, availability, classifications } = live
    const onTiles = new Set(screen.tiles.flatMap((tile) => (Tile.guards.Empty(tile) ? [] : [tile.game])))
    const candidates = slate.games.flatMap(({ snapshot: { id: game } }) => {
      const classification = classifications[game]
      if (classification === undefined || onTiles.has(game)) return []
      const rank = rankOf(classification.moment)
      const worthy = rank === "redZone" || rank === "crunchTime"
      const streams = Tile.guards.StreamTile(Screen.tileFor(game, availability[game] ?? []))
      return worthy && streams && !this.dismissedIn(game, classification.since)
        ? [{ game, rank, since: classification.since }]
        : []
    })

    return Option.flatMap(targetOn(screen, classifications), ({ tile, replaces }) => {
      const qualifying = candidates.filter(({ rank }) =>
        Option.match(replaces, { onNone: () => true, onSome: (weakest) => outranks(rank, weakest.rank) })
      )
      const best = Arr.sort(
        qualifying,
        Order.mapInput(byRank(classifications), ({ game }: { readonly game: GameId }) => ({ tile: 0, game }))
      )
      return Option.map(
        Arr.head(best),
        ({ game, rank, since }) => new Prompt({ game, rank, since, target: tile, replaces })
      )
    })
  }

  /** `prompt`'s game dismissed for its moment; each other dismissal whose game's moment has since changed is dropped. */
  dismiss(prompt: Prompt, classifications: Classifications): Prompts {
    const current = Rec.filter(this.dismissed, (since, game) => {
      const classification = classifications[game]
      return classification !== undefined && DateTime.Equivalence(classification.since, since)
    })
    return new Prompts({ ...this, dismissed: { ...current, [prompt.game]: prompt.since } })
  }

  /** Whether you dismissed `game` in the moment that began at `since`. */
  private dismissedIn(game: GameId, since: DateTime.Utc): boolean {
    const dismissed = this.dismissed[game]
    return dismissed !== undefined && DateTime.Equivalence(dismissed, since)
  }
}

/**
 * Where a prompt's game would go on `screen`: the first empty slot; with none, the slot of the weakest game on
 * screen, with that game and its rank.
 */
function targetOn(
  screen: Screen,
  classifications: Classifications
): Option.Option<{
  readonly tile: number
  readonly replaces: Option.Option<{ readonly game: GameId; readonly rank: Rank }>
}> {
  const slots = screen.onScreen()
  const empty = slots.findIndex((tile) => Tile.guards.Empty(tile))
  if (empty !== -1) return Option.some({ tile: empty, replaces: Option.none() })
  const occupied = slots.flatMap((tile, index) =>
    Tile.guards.Empty(tile) ? [] : [{ tile: index, game: tile.game }]
  )
  return Option.map(Arr.last(Arr.sort(occupied, byRank(classifications))), ({ tile, game }) => ({
    tile,
    replaces: Option.some({ game, rank: rankOf(classifications[game]?.moment) })
  }))
}
