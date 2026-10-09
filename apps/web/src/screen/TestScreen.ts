import type { ChannelAvailability } from "@sportal/domain/Channel"
import { GameId } from "@sportal/domain/Game"
import { Result } from "effect"
import { Screen } from "./Screen.ts"

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
            source: "YouTube TV" as const,
            locator: { _tag: "WebView" as const, url: `https://example.test/${game}` }
          }
        }
  )
  return new Screen({ ...Screen.initial, tiles: [...tiles, ...Screen.initial.tiles.slice(tiles.length)] })
}

/** A game the screen tests put in a tile, by an ESPN event id. */
export const bama = GameId.make("401856707")
/** A second game for the screen tests, by another ESPN event id. */
export const irish = GameId.make("401858250")

/** FOX on YouTube TV, a channel a carried game is watched on. */
export const foxChannel = {
  name: "FOX",
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/fox" }
}

/** Every game is carried on FOX. */
export function onFox(): ReadonlyArray<ChannelAvailability> {
  return [{ _tag: "Carried", channel: foxChannel }]
}

/** No game has a stream. */
export function nowhere(): ReadonlyArray<ChannelAvailability> {
  return [{ _tag: "NotCarried", why: "NoStream" }]
}

/** `screen` with `game` assigned to `tile`, its channel from `availabilityOf`. */
export function assign(
  screen: Screen,
  tile: number,
  game: GameId,
  availabilityOf: () => ReadonlyArray<ChannelAvailability>
) {
  return Result.getOrThrow(screen.apply({ _tag: "Assign", tile, game }, availabilityOf))
}

/** A Quad holding these games as stream tiles on FOX, in order; `undefined` leaves a tile empty. */
export function fill(games: ReadonlyArray<GameId | undefined>) {
  return games.reduce<Screen>(
    (screen, game, tile) => (game === undefined ? screen : assign(screen, tile, game, onFox)),
    Screen.initial
  )
}

/** A Quad holding these games as stream tiles on FOX, with `tile` soloed. */
export function soloed(games: ReadonlyArray<GameId | undefined>, tile: number) {
  return Result.getOrThrow(fill(games).apply({ _tag: "Solo", tile }, nowhere))
}
