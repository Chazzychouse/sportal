import { GameId } from "@sportal/domain/Game"
import { Stage } from "@sportal/domain/Stage"

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
