import { Result } from "effect"
import { ChannelAvailability } from "./Channel.ts"
import { GameId } from "./Game.ts"
import { Stage } from "./Stage.ts"

/** A game the stage tests put in a tile, by an ESPN event id. */
export const bama = GameId.make("401856707")
/** A second game for the stage tests, by another ESPN event id. */
export const irish = GameId.make("401858250")

/** FOX on YouTube TV, a channel a carried game is watched on. */
export const foxChannel = {
  name: "FOX",
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/fox" }
}

/** Every game is carried on FOX. */
export function onFox() {
  return ChannelAvailability.Carried({ channel: foxChannel })
}

/** No game has a stream. */
export function nowhere() {
  return ChannelAvailability.NotCarried({ why: "NoStream" })
}

/** `stage` with `game` assigned to `tile`, its channel from `availabilityOf`. */
export function assign(stage: Stage, tile: number, game: GameId, availabilityOf: () => ChannelAvailability) {
  return Result.getOrThrow(stage.apply({ _tag: "Assign", tile, game }, availabilityOf))
}

/** A Quad holding these games as stream tiles on FOX, in order; `undefined` leaves a tile empty. */
export function fill(games: ReadonlyArray<GameId | undefined>) {
  return games.reduce<Stage>(
    (stage, game, tile) => (game === undefined ? stage : assign(stage, tile, game, onFox)),
    Stage.initial
  )
}

/** A Quad holding these games as stream tiles on FOX, with `tile` soloed. */
export function soloed(games: ReadonlyArray<GameId | undefined>, tile: number) {
  return Result.getOrThrow(fill(games).apply({ _tag: "Solo", tile }, nowhere))
}
