import type { DisplayId } from "@sportal/api/DisplayId"
import type { DisplayMessage } from "@sportal/api/DisplayMessage"
import { GameNotFound } from "@sportal/api/GameNotFound"
import { CalendarDate, type GameList } from "@sportal/api/GamesQuery"
import { HubApi } from "@sportal/api/HubApi"
import type { ListedGame } from "@sportal/api/ListedGame"
import type { RemoteMessage } from "@sportal/api/RemoteMessage"
import type { Channel, ChannelAvailability } from "@sportal/domain/Channel"
import { GameId, type PlaysChange } from "@sportal/domain/Game"
import type { GameStats } from "@sportal/domain/GameStats"
import type { LeagueId } from "@sportal/domain/League"
import { snapshot } from "@sportal/domain/TestGame"
import { DateTime, Effect, Layer, PubSub, Queue, Result, Schema, Stream, SubscriptionRef } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { CustomStream } from "./custom/CustomStream.ts"
import { HubClient } from "./hub/HubClient.ts"
import { Connection, HubSocket } from "./hub/HubSocket.ts"
import { Screen, type ScreenCommand } from "./screen/Screen.ts"
import { Shell } from "./shell/Shell.ts"
import * as WebRuntime from "./WebRuntime.ts"

const live = snapshot({ id: GameId.make("live"), status: "live" })
const later = snapshot({
  id: GameId.make("later"),
  startsAt: DateTime.makeUnsafe("2026-10-03T20:00:00Z")
})
const soon = snapshot({ id: GameId.make("soon") })
const done = snapshot({ id: GameId.make("done"), status: "final" })

/** Today's four games, as the Hub lists them in watch order: live, soon, later, done, none carried. */
export const todayList: GameList = {
  date: CalendarDate.make("2026-10-03"),
  games: [live, soon, later, done].map((each) => ({ snapshot: each, availability: [] }))
}

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

/** A YouTube video saved as a custom stream, named "Highlights". */
export const video = Result.getOrThrow(CustomStream.parse("https://youtu.be/dQw4w9WgXcQ", "Highlights"))

/** A YouTube playlist saved as a custom stream, from its start, named "Week 6". */
export const playlist = Result.getOrThrow(
  CustomStream.parse("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG", "Week 6")
)

/** FOX on YouTube TV, a channel a carried game is watched on. */
export const foxChannel = {
  name: "FOX",
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/fox" }
}

/** ESPN on YouTube TV, a channel chosen from the guide's lineup. */
export const espn: Channel = {
  name: "ESPN",
  source: "YouTube TV",
  locator: { _tag: "WebView", url: "https://tv.youtube.com/watch/espn" }
}

/** A second feed also named ESPN on YouTube TV, at another live address. */
export const espnAlternate: Channel = {
  name: "ESPN",
  source: "YouTube TV",
  locator: { _tag: "WebView", url: "https://tv.youtube.com/watch/espn-alternate" }
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

/** `screen` with `stream` in `tile` as a custom tile, as choosing it from the guide would put it there. */
export function assignCustom(screen: Screen, tile: number, stream: CustomStream) {
  const command: ScreenCommand = {
    _tag: "AssignCustom",
    tile,
    stream: stream.id,
    name: stream.name,
    locator: stream.locator()
  }
  return Result.getOrThrow(screen.apply(command, nowhere))
}

/** `screen` with `channel` in `tile` as a channel tile, as choosing it from the guide would put it there. */
export function assignChannel(screen: Screen, tile: number, channel: Channel) {
  const command: ScreenCommand = { _tag: "AssignChannel", tile, channel }
  return Result.getOrThrow(screen.apply(command, nowhere))
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

/**
 * A Hub over an in-memory socket, for a test to drive: its connection (connected), and a PubSub per kind of live query;
 * each publish goes to every query of its kind open then (a game's, its plays' and its stats' by the game's id).
 * `open` names the queries open now, as "games", "game 401", "plays 401", "stats 401", "inputs desk" and
 * "follow desk": a test waits for one with `asked` before it answers it, and for its end with `dropped`. An `inputs`
 * query sends `Registered` first. While
 * `refusals` is above 0, a game's query is refused as not found, and counts it down. Each write the socket carries
 * goes to `requests`, as a `TestWebCall`.
 */
export const liveHub = Effect.fn("TestWeb.liveHub")(function* () {
  const connection = yield* SubscriptionRef.make<Connection>(Connection.Connected())
  const open = yield* SubscriptionRef.make<ReadonlyArray<string>>([])
  const lists = yield* PubSub.unbounded<GameList>()
  const games = yield* PubSub.unbounded<ListedGame>()
  const plays = yield* PubSub.unbounded<{ readonly game: GameId; readonly change: PlaysChange }>()
  const stats = yield* PubSub.unbounded<GameStats>()
  const inputs = yield* PubSub.unbounded<Schema.Json>()
  const follows = yield* PubSub.unbounded<RemoteMessage>()
  const requests = yield* Queue.unbounded<TestWebCall>()
  const refusals = yield* SubscriptionRef.make(0)
  const refused = SubscriptionRef.modify(refusals, (left) => [left > 0, Math.max(0, left - 1)] as const)

  const handlers = HubApi.toLayer({
    listLive: () => served(open, "games", lists),
    gameLive: ({ id }) =>
      Stream.unwrap(
        Effect.map(refused, (refusing) =>
          refusing
            ? Stream.fail(new GameNotFound())
            : served(open, `game ${id}`, games).pipe(Stream.filter(({ snapshot }) => snapshot.id === id))
        )
      ),
    playsLive: ({ id }) =>
      served(open, `plays ${id}`, plays).pipe(
        Stream.filter(({ game }) => game === id),
        Stream.map(({ change }) => change)
      ),
    statsLive: ({ id }) => served(open, `stats ${id}`, stats).pipe(Stream.filter(({ game }) => game === id)),
    inputs: ({ display }) =>
      Stream.concat(
        Stream.succeed<DisplayMessage>({ _tag: "Registered" }),
        Stream.map(
          served(open, `inputs ${display}`, inputs),
          (input): DisplayMessage => ({ _tag: "Sent", input })
        )
      ),
    follow: ({ display }) => served(open, `follow ${display}`, follows),
    list: () => Effect.die("TestWeb.liveHub does not answer list"),
    game: () => Effect.die("TestWeb.liveHub does not answer game"),
    plays: () => Effect.die("TestWeb.liveHub does not answer plays"),
    stats: () => Effect.die("TestWeb.liveHub does not answer stats"),
    highlights: () => Effect.die("TestWeb.liveHub does not answer highlights"),
    lineup: () => Effect.die("TestWeb.liveHub does not answer lineup"),
    readGuide: ({ guide }) => Queue.offer(requests, { _tag: "SendGuide", guide }).pipe(Effect.asVoid),
    health: () => Effect.succeed({ version: "test", startedAt: DateTime.makeUnsafe(0) }),
    addresses: () => Effect.succeed([]),
    report: ({ display, report }) =>
      Queue.offer(requests, { _tag: "Report", id: display, report }).pipe(Effect.asVoid),
    send: ({ display, input }) =>
      Queue.offer(requests, { _tag: "Send", id: display, input }).pipe(Effect.asVoid)
  })
  const layer = HubSocket.layerTest(connection, handlers)
  return { layer, connection, open, lists, games, plays, stats, inputs, follows, requests, refusals }
})

/** The queries `hub` has open, once it has `name` open. */
export function asked(
  hub: { readonly open: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>> },
  name: string
) {
  return openWhen(hub, (names) => names.includes(name))
}

/** The queries `hub` has open, once nothing reads its query `name` any more. */
export function dropped(
  hub: { readonly open: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>> },
  name: string
) {
  return openWhen(hub, (names) => !names.includes(name))
}

/** Publishes `value` on `answers` once `hub` has the query `name` open, so that query gets it. */
export const answer = Effect.fnUntraced(function* <A>(
  hub: { readonly open: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>> },
  name: string,
  answers: PubSub.PubSub<A>,
  value: A
) {
  yield* asked(hub, name)
  yield* PubSub.publish(answers, value)
})

/** A socket lost at the epoch. */
export const lost: Connection = Connection.Lost({ since: DateTime.makeUnsafe(0) })

/** Waits past the registry's next scheduled tasks, where it removes an atom nothing holds. */
export const afterTasks = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))

/** `answers` to one query named `name`: open from its subscription until its client stops reading it. */
function served<A>(
  open: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>>,
  name: string,
  answers: PubSub.PubSub<A>
): Stream.Stream<A> {
  const subscribed = Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(answers)
    yield* SubscriptionRef.update(open, (names) => [...names, name])

    return Stream.fromSubscription(subscription)
  })
  const ended = SubscriptionRef.update(open, (names) => names.filter((each) => each !== name))
  return Stream.unwrap(subscribed).pipe(Stream.ensuring(ended))
}

function openWhen(
  hub: { readonly open: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>> },
  holds: (names: ReadonlyArray<string>) => boolean
) {
  return SubscriptionRef.changes(hub.open).pipe(
    Stream.filter(holds),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption)
  )
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
  layer: Layer.Layer<Shell | HubClient | HubSocket>,
  scheduleTask?: (f: () => void) => () => void
) {
  return AtomRegistry.layerOptions({ initialValues: [[WebRuntime.runtime.layer, layer]], scheduleTask })
}

/**
 * A registry whose web runtime has a Shell giving `events` and a Hub client taking every guide, and each call the
 * Shell and the Hub client are asked to make, in order, and the fake Hub its live queries ask (`liveHub`).
 */
export const withShell = Effect.fn("TestWeb.withShell")(function* (
  events: Omit<Parameters<typeof Shell.layerTest>[0], "record"> = {},
  scheduleTask?: (f: () => void) => () => void
) {
  const calls = yield* Queue.unbounded<TestWebCall>()
  const hub = yield* liveHub()
  const layer = Layer.mergeAll(
    Shell.layerTest({ ...events, record: (call) => Effect.asVoid(Queue.offer(calls, call)) }),
    HubClient.layerTest({
      sendGuide: (guide) => Effect.asVoid(Queue.offer(calls, { _tag: "SendGuide", guide })),
      report: (id, report) => Effect.asVoid(Queue.offer(calls, { _tag: "Report", id, report })),
      send: (id, input) => Effect.asVoid(Queue.offer(calls, { _tag: "Send", id, input })),
      highlights: (league, date) => Effect.as(Queue.offer(calls, { _tag: "Highlights", league, date }), [])
    }),
    hub.layer
  )
  return { registry: registryOf(layer, scheduleTask), calls, hub }
})

/** A call `withShell` records: one the Shell was asked to make, or one the Hub client was. */
export type TestWebCall =
  | Parameters<Parameters<typeof Shell.layerTest>[0]["record"]>[0]
  | { readonly _tag: "SendGuide"; readonly guide: string }
  | { readonly _tag: "Report"; readonly id: DisplayId; readonly report: Schema.Json }
  | { readonly _tag: "Send"; readonly id: DisplayId; readonly input: Schema.Json }
  | { readonly _tag: "Highlights"; readonly league: LeagueId; readonly date: CalendarDate }

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
