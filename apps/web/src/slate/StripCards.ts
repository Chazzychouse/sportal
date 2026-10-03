import { type GameId, GameSnapshot } from "@sportal/domain/Game"
import type { Stage, StageCommand } from "@sportal/domain/Stage"

/**
 * The strip's cards, in order: the bench, then the slate live, upcoming, and over. A benched game shows once, on
 * the bench, even when it has left the slate. A game on stage keeps its place in the slate, marked with its slot.
 */
export function stripCards(
  stage: Stage,
  slate: ReadonlyArray<GameSnapshot>
): ReadonlyArray<{
  id: GameId
  game: GameSnapshot | undefined
  place: { _tag: "Slot"; slot: number } | { _tag: "Bench"; tile: number } | undefined
}> {
  const benched = stage.benched()
  const bench = benched.map(({ tile, game }) => ({
    id: game,
    game: slate.find((snapshot) => snapshot.id === game),
    place: { _tag: "Bench" as const, tile }
  }))
  const rest = [...slate]
    .filter((game) => !benched.some((bench) => bench.game === game.id))
    .sort(GameSnapshot.watchOrder)
    .map((game) => {
      const slot = stage.slotOf(game.id)
      return { id: game.id, game, place: slot === undefined ? undefined : { _tag: "Slot" as const, slot } }
    })
  return [...bench, ...rest]
}

/**
 * Where the pick lands after a step: the next card along that is not on stage, wrapping at the ends. With no pick,
 * or one no longer in the strip, it starts on the first live game nobody is watching, or failing that the first
 * card that can be picked.
 */
export function nextPick(
  cards: ReturnType<typeof stripCards>,
  pick: GameId | undefined,
  step: -1 | 1
): GameId | undefined {
  const pickable = (card: (typeof cards)[number]) => card.place?._tag !== "Slot"
  const from = cards.findIndex((card) => card.id === pick)
  if (from === -1)
    return (
      cards.find((card) => card.place === undefined && card.game?.isLive() === true) ?? cards.find(pickable)
    )?.id
  for (let offset = 1; offset <= cards.length; offset++) {
    const card = cards[(from + step * offset + cards.length * offset) % cards.length]
    if (card !== undefined && pickable(card)) return card.id
  }
  return undefined
}

/** What dropping a card into tile `selected` does: a free game is assigned, a benched one swapped in. */
export function dropCommand(
  card: ReturnType<typeof stripCards>[number],
  selected: number
): StageCommand | undefined {
  switch (card.place?._tag) {
    case undefined:
      return { _tag: "Assign", tile: selected, game: card.id }
    case "Bench":
      return { _tag: "Swap", a: card.place.tile, b: selected }
    case "Slot":
      return undefined
  }
}
