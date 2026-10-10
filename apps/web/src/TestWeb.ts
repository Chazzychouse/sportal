import { LiveMessageJson } from "@sportal/api/LiveMessage"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { Game, GameId } from "@sportal/domain/Game"
import { Slate } from "@sportal/domain/Slate"
import { snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Record, Result, Schema } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import * as LiveStream from "./hub/LiveStream.ts"
import { Screen } from "./screen/Screen.ts"

const live = snapshot({ id: GameId.make("live"), status: "live" })
const later = snapshot({
  id: GameId.make("later"),
  kickoff: DateTime.makeUnsafe("2026-10-03T20:00:00Z")
})
const soon = snapshot({ id: GameId.make("soon") })
const done = snapshot({ id: GameId.make("done"), status: "final" })

/** Four games in no order: live, soon, later, done are the ids; the strip puts them live, soon, later, done. */
export const slate = new Slate({ games: [done, later, live, soon].map(Game.of) })

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

/** The EventSource the live stream opened, once a read of the atom has started it. */
export const opened: Effect.Effect<FakeEventSource, never, AtomRegistry.AtomRegistry> = Atom.get(
  LiveStream.live
).pipe(Effect.andThen(eventSource))

function eventSource(): Effect.Effect<FakeEventSource> {
  return Effect.suspend(() => {
    const last = FakeEventSource.opened.at(-1)
    return last === undefined ? Effect.yieldNow.pipe(Effect.flatMap(eventSource)) : Effect.succeed(last)
  })
}

/** An EventSource a test drives by hand: it records each one opened, and the test calls its handlers. */
export class FakeEventSource {
  static opened: Array<FakeEventSource> = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false

  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeEventSource.opened.push(this)
  }

  close() {
    this.closed = true
  }
}

/** A slate message's `data`, as the Hub sends it: the slate of `entries`' games, and each one's availability. */
export function slateMessage(
  entries: ReadonlyArray<{ game: Game; availability: ReadonlyArray<ChannelAvailability> }>
) {
  const slate = new Slate({ games: entries.map(({ game }) => game) })
  const availability = Record.fromEntries(
    entries.map(({ game, availability }) => [game.snapshot.id, availability] as const)
  )
  return encodeLiveMessage({ _tag: "SlateChanged", slate, availability })
}

const encodeLiveMessage = Schema.encodeSync(LiveMessageJson)
