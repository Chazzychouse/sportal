import { LiveMessageJson } from "@sportal/api/LiveMessage"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { Classification } from "@sportal/domain/Classification"
import { Game, GameId } from "@sportal/domain/Game"
import type { Moment } from "@sportal/domain/Moment"
import { Slate } from "@sportal/domain/Slate"
import { snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Duration, Effect, Layer, Option, Queue, Record, Result, Schema, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import type { Autopilot } from "./autopilot/Autopilot.ts"
import type { Decision } from "./autopilot/Decision.ts"
import { HubClient } from "./hub/HubClient.ts"
import * as LiveStream from "./hub/LiveStream.ts"
import { type LayoutName, Screen, type ScreenCommand } from "./screen/Screen.ts"
import { Shell } from "./shell/Shell.ts"
import * as WebRuntime from "./WebRuntime.ts"

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

/** `moment` classified since `since` (2026-10-10 20:00 UTC unless given) with `score`, all of it from closeness. */
export function classified(
  moment: Moment,
  score = 50,
  since: DateTime.Utc = DateTime.makeUnsafe("2026-10-10T20:00:00Z")
): Classification {
  return new Classification({
    moment,
    score,
    since,
    breakdown: { prior: 0, closeness: score, swing: 0, upset: 0, momentBonus: 0 }
  })
}

/** The home team eight yards from scoring. */
export const redZone: Moment = { _tag: "ScoringThreat", team: team("HOME").id, yardsToGo: 8 }

/** A timeout, a break that expects to end a minute after 20:00 on 2026-10-10. */
export const timeout: Moment = {
  _tag: "Break",
  reason: "timeout",
  expectedEnd: DateTime.makeUnsafe("2026-10-10T20:01:00Z")
}

/** One moment of a scripted game day: seconds after 20:00 UTC, each game's classification then, and a command you send first. */
export interface TimelineStep {
  readonly at: number
  readonly classifications: ReadonlyArray<readonly [GameId, Classification]>
  readonly command?: ScreenCommand
}

/** What the Screen showed after a timeline step: the main tile's game, the game heard, the layout, and the decision. */
export interface TimelineFrame {
  readonly at: number
  readonly main: GameId | undefined
  readonly heard: GameId | undefined
  readonly layout: LayoutName
  readonly decision: Decision
}

/**
 * Plays `steps` through `autopilot` from `screen` as a Display would: your command through the Screen and `manual`,
 * then a step, its commands applied in order. Every game is on FOX.
 */
export function timeline(
  screen: Screen,
  autopilot: Autopilot,
  steps: ReadonlyArray<TimelineStep>
): ReadonlyArray<TimelineFrame> {
  const start = DateTime.makeUnsafe("2026-10-10T20:00:00Z")
  const applied = (on: Screen, commands: ReadonlyArray<ScreenCommand>) =>
    commands.reduce((current, command) => Result.getOrThrow(current.apply(command, onFox)), on)
  return steps.reduce(
    (played, step) => {
      const now = DateTime.addDuration(start, Duration.seconds(step.at))
      const before =
        step.command === undefined
          ? played
          : {
              frames: played.frames,
              screen: applied(played.screen, [step.command]),
              autopilot: played.autopilot.manual(step.command, now)
            }
      const { next, commands, decision } = before.autopilot.step(
        before.screen,
        Record.fromEntries(step.classifications),
        now
      )
      const shown = applied(before.screen, commands)
      const main = shown.tiles[0]
      const frame: TimelineFrame = {
        at: step.at,
        main: main === undefined || main._tag === "Empty" ? undefined : main.game,
        heard: Option.getOrUndefined(shown.audioFocus),
        layout: shown.layout,
        decision
      }
      return { screen: shown, autopilot: next, frames: [...played.frames, frame] }
    },
    { screen, autopilot, frames: [] as ReadonlyArray<TimelineFrame> }
  ).frames
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

/**
 * A slate message's `data`, as the Hub sends it: the slate of `entries`' games, each one's availability, and the
 * classification of each that has one.
 */
export function slateMessage(
  entries: ReadonlyArray<{
    game: Game
    availability: ReadonlyArray<ChannelAvailability>
    classification?: Classification
  }>
) {
  const slate = new Slate({ games: entries.map(({ game }) => game) })
  const availability = Record.fromEntries(
    entries.map(({ game, availability }) => [game.snapshot.id, availability] as const)
  )
  const classifications = Record.fromEntries(
    entries.flatMap(({ game, classification }) =>
      classification === undefined ? [] : [[game.snapshot.id, classification] as const]
    )
  )
  return encodeLiveMessage({ _tag: "SlateChanged", slate, availability, classifications })
}

/** The first value of `atom` that `predicate` holds for. */
export function until<A>(atom: Atom.Atom<A>, predicate: (value: A) => boolean) {
  return Atom.toStream(atom).pipe(Stream.filter(predicate), Stream.runHead, Effect.flatMap(Effect.fromOption))
}

/**
 * A registry whose web runtime is `layer` in place of the browser's; `scheduleTask`, when given, stands in for
 * React's scheduler.
 */
export function registryOf(
  layer: Layer.Layer<Shell | HubClient>,
  scheduleTask?: (f: () => void) => () => void
) {
  return AtomRegistry.layerOptions({ initialValues: [[WebRuntime.runtime.layer, layer]], scheduleTask })
}

/**
 * A registry whose web runtime has a Shell giving `events` and a Hub client taking every guide, and each call the
 * Shell and the Hub client are asked to make, in order.
 */
export const withShell = Effect.fn("TestWeb.withShell")(function* (
  events: Omit<Parameters<typeof Shell.layerTest>[0], "record"> = {},
  scheduleTask?: (f: () => void) => () => void
) {
  const calls = yield* Queue.unbounded<ShellCall | { readonly _tag: "SendGuide"; readonly guide: string }>()
  const layer = Layer.mergeAll(
    Shell.layerTest({ ...events, record: (call) => Effect.asVoid(Queue.offer(calls, call)) }),
    HubClient.layerTest((guide) => Effect.asVoid(Queue.offer(calls, { _tag: "SendGuide", guide })))
  )
  return { registry: registryOf(layer, scheduleTask), calls }
})

type ShellCall = Parameters<Parameters<typeof Shell.layerTest>[0]["record"]>[0]

/** Keeps `screen` in this browser, as the Display would have before a reload. */
export const keep = Effect.fn("TestWeb.keep")(function* (screen: Screen) {
  const encoded = yield* Schema.encodeEffect(Screen)(screen)
  localStorage.setItem("sportal/screen", JSON.stringify(encoded))
})

/** A `Storage` in memory, as a browser's `localStorage` is. */
export class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>()
  get length() {
    return this.items.size
  }
  clear() {
    this.items.clear()
  }
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
  setItem(key: string, value: string) {
    this.items.set(key, value)
  }
}

const encodeLiveMessage = Schema.encodeSync(LiveMessageJson)
