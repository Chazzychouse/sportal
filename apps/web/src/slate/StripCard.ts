import { type GameId, GameSnapshot } from "@sportal/domain/Game"
import type { Slate } from "@sportal/domain/Slate"
import { Array as Arr, Data, Option } from "effect"
import type { Screen } from "../screen/Screen.ts"

/** Where a strip card's game is: in a slot on screen, or on the bench at a tile. */
export type Place = Data.TaggedEnum<{
  Slot: { readonly slot: number }
  Bench: { readonly tile: number }
}>
export const Place = Data.taggedEnum<Place>()

/** One card in the slate strip: a benched game, or a slate game in its section, marked with its slot if on screen. */
export class StripCard extends Data.Class<{
  readonly id: GameId
  readonly game: GameSnapshot | undefined
  readonly place: Place | undefined
  readonly section: "Bench" | "Live" | "Next" | "Final"
}> {
  /**
   * The strip's cards, in order: the bench, then the slate live, upcoming, and over, in watch order. A
   * benched game shows once, on the bench, even when it has left the slate. A game on screen keeps its place in the
   * slate, marked with its slot.
   */
  static of(screen: Screen, slate: Slate): ReadonlyArray<StripCard> {
    const benched = screen.benched()
    const bench = benched.map(({ tile, game }) => {
      const snapshot = Option.getOrUndefined(Option.map(slate.gameOf(game), (found) => found.snapshot))
      return new StripCard({
        id: game,
        game: snapshot,
        place: Place.Bench({ tile }),
        section: "Bench"
      })
    })
    const rest = slate.games
      .map(({ snapshot }) => snapshot)
      .filter((game) => !benched.some((bench) => bench.game === game.id))
      .toSorted(GameSnapshot.watchOrder)
      .map((game) => {
        const slot = screen.slotOf(game.id)
        const place = slot === undefined ? undefined : Place.Slot({ slot })
        return new StripCard({ id: game.id, game, place, section: sections[game.progress()] })
      })
    return [...bench, ...rest]
  }

  /**
   * Where the pick lands after a step: the next card along that is not on screen, wrapping at the ends. With no pick,
   * or one no longer in the strip, it starts on the first live game nobody is watching, or failing that the first
   * card that can be picked.
   */
  static nextPick(
    cards: ReadonlyArray<StripCard>,
    pick: GameId | undefined,
    step: -1 | 1
  ): GameId | undefined {
    const from = cards.findIndex((card) => card.id === pick)
    if (from === -1)
      return (
        cards.find((card) => card.place === undefined && card.game?.progress() === "live") ??
        cards.find((card) => card.pickable())
      )?.id
    return Arr.range(1, cards.length)
      .map((offset) => cards[(from + step * offset + cards.length * offset) % cards.length])
      .find((card) => card?.pickable() === true)?.id
  }

  /** A card not on screen can be picked and dropped. */
  pickable(): boolean {
    return !Place.$is("Slot")(this.place)
  }
}

const sections = { live: "Live", upcoming: "Next", over: "Final" } as const
