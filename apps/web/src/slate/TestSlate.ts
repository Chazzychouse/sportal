import { GameId } from "@sportal/domain/Game"
import { Stage } from "@sportal/domain/Stage"
import { snapshot } from "@sportal/domain/TestGame"
import { DateTime } from "effect"

const live = snapshot({ id: GameId.make("live"), status: "live" })
const later = snapshot({
  id: GameId.make("later"),
  kickoff: DateTime.makeUnsafe("2026-10-03T20:00:00Z")
})
const soon = snapshot({ id: GameId.make("soon") })
const done = snapshot({ id: GameId.make("done"), status: "final" })

/** Four games in no order: live, soon, later, done are the ids; the strip puts them live, soon, later, done. */
export const slate = [done, later, live, soon]

/** A Quad with these games streaming in its tiles, in order; past the fourth they are benched. */
export function withTiles(games: ReadonlyArray<string | undefined>) {
  const tiles = games.map((game) =>
    game === undefined
      ? { _tag: "Empty" as const }
      : {
          _tag: "StreamTile" as const,
          game: GameId.make(game),
          channel: {
            name: game,
            source: "Scenario" as const,
            locator: { _tag: "WebView" as const, url: `https://example.test/${game}` }
          }
        }
  )
  return new Stage({ ...Stage.initial, tiles: [...tiles, ...Stage.initial.tiles.slice(tiles.length)] })
}
