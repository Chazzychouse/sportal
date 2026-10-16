import { TileKey } from "@sportal/api/TileKey"
import { Channel, ChannelAvailability, SourceName } from "@sportal/domain/Channel"
import { GameId } from "@sportal/domain/Game"
import { Array as Arr, Option, Record as Rec, Result, Schema } from "effect"

/** One slot's content: a game's stream, its data, or nothing. With `key`, what the tile shows as a `TileKey`. */
export const Tile = Object.assign(
  Schema.TaggedUnion({
    Empty: {},
    StreamTile: { game: GameId, channel: Channel },
    /** No stream, and why: none on any source, streaming only, not in the guide, not on yet, or no guide to ask. */
    DataTile: {
      game: GameId,
      why: Schema.TaggedUnion({
        NoStream: {},
        StreamingOnly: {},
        NotInGuide: {},
        NoGuide: { source: SourceName },
        NotYet: {
          channel: Schema.OptionFromOptionalKey(Schema.String),
          begin: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString)
        }
      })
    }
  }),
  { key }
)
export type Tile = typeof Tile.Type

const empty: Tile = { _tag: "Empty" }

/** The layouts a Screen can take, in the order the next-layout hotkey cycles through them. */
export const LayoutName = Schema.Literals(["Single", "Pair", "Quad", "MainThree", "MainFive"])
export type LayoutName = typeof LayoutName.Type

/** Where a layout's dividers sit, as fractions of the Screen area. */
export const Split = Schema.Struct({ x: Schema.Finite, y: Schema.Finite })
export type Split = typeof Split.Type

/** Each layout's slot count and the split a new Screen gives it. */
const layouts = {
  Single: { slots: 1, split: { x: 0.5, y: 0.5 } },
  Pair: { slots: 2, split: { x: 0.5, y: 0.5 } },
  Quad: { slots: 4, split: { x: 0.5, y: 0.5 } },
  MainThree: { slots: 4, split: { x: 0.75, y: 0.5 } },
  MainFive: { slots: 6, split: { x: 2 / 3, y: 2 / 3 } }
} as const satisfies Record<LayoutName, { slots: number; split: Split }>

export class Screen extends Schema.Class<Screen>("sportal/Screen")({
  /** The first `Screen.slotCount(layout)` tiles are on screen, main tile first; the rest are the bench. */
  tiles: Schema.Array(Tile),
  layout: LayoutName,
  /** Each layout's own split, kept while another layout is shown. */
  splits: Schema.Record(LayoutName, Split),
  /** The tile whose sound is on, by its key: always an on-screen tile, or none when the screen is empty. */
  audioFocus: Schema.OptionFromOptionalKey(TileKey),
  /** The tile filling the Screen, by its key: always an on-screen tile. */
  solo: Schema.OptionFromOptionalKey(TileKey)
}) {
  /** An empty Quad, every layout at its default split. */
  static readonly initial = new Screen({
    tiles: [empty, empty, empty, empty],
    layout: "Quad",
    splits: Rec.map(layouts, ({ split }) => split),
    audioFocus: Option.none(),
    solo: Option.none()
  })

  /** The range each divider stays within, so every tile stays watchable. */
  static readonly splitBounds = { min: 0.2, max: 0.8 } as const

  static slotCount(layout: LayoutName): number {
    return layouts[layout].slots
  }

  /**
   * The tile `game` gets from its availability: a stream tile when the most useful says it is carried, else a data
   * tile saying why.
   */
  static tileFor(game: GameId, availability: ReadonlyArray<ChannelAvailability>): Tile {
    return ChannelAvailability.match(mostUseful(availability), {
      Carried: ({ channel }): Tile => ({ _tag: "StreamTile", game, channel }),
      Upcoming: ({ channel, begin }): Tile => ({
        _tag: "DataTile",
        game,
        why: { _tag: "NotYet", channel, begin }
      }),
      NoGuide: ({ source }): Tile => ({ _tag: "DataTile", game, why: { _tag: "NoGuide", source } }),
      NotCarried: ({ why }): Tile => ({ _tag: "DataTile", game, why: { _tag: why } })
    })
  }

  /** Whether the sound of the tile with this key is on. */
  hears(key: TileKey): boolean {
    return Option.contains(this.audioFocus, key)
  }

  /** Whether the tile with this key fills the Screen. */
  soloes(key: TileKey): boolean {
    return Option.contains(this.solo, key)
  }

  /** The Screen with the current layout's split replaced: the preview of a divider drag. */
  withSplit(split: Split): Screen {
    return new Screen({ ...this, splits: { ...this.splits, [this.layout]: split } })
  }

  /** The tiles in the layout's slots, main tile first. */
  onScreen(): ReadonlyArray<Tile> {
    return this.tiles.slice(0, Screen.slotCount(this.layout))
  }

  /** The keys on the bench, in order, each with its tile. Empty tiles past the slots are skipped. */
  benched(): ReadonlyArray<{ tile: number; key: TileKey }> {
    const first = Screen.slotCount(this.layout)
    return this.tiles.flatMap((tile, index) =>
      index < first || Tile.guards.Empty(tile) ? [] : [{ tile: index, key: Tile.key(tile) }]
    )
  }

  /** The slot the tile with this key is in, if it is on screen. */
  slotOf(key: TileKey): number | undefined {
    const slot = this.onScreen().findIndex((tile) => holds(tile, key))
    return slot === -1 ? undefined : slot
  }

  /** The first empty on-screen slot after `slot`, wrapping round; never `slot` itself. */
  nextEmptySlot(slot: number): number | undefined {
    const slots = this.onScreen()
    if (slots.length < 2) return undefined
    return Option.getOrUndefined(
      Arr.findFirst(
        Arr.range(1, slots.length - 1).map((offset) => (slot + offset) % slots.length),
        (next) => Option.exists(Arr.get(slots, next), Tile.guards.Empty)
      )
    )
  }

  /**
   * Applies a command. `availabilityOf` gives a game's availability from every source: a game is assigned as the
   * most useful of them says, a carried game as a stream tile and any other as a data tile.
   */
  apply(
    command: ScreenCommand,
    availabilityOf: (game: GameId) => ReadonlyArray<ChannelAvailability>
  ): Result.Result<Screen, ScreenRejection> {
    const next = ScreenCommand.match<Result.Result<Unsettled, ScreenRejection>>(command, {
      SetLayout: ({ layout }) => Result.succeed({ ...this, layout }),
      SetSplit: ({ split }) => {
        const { min, max } = Screen.splitBounds
        const holdsSplit = [split.x, split.y].every((at) => at >= min && at <= max)
        return holdsSplit ? Result.succeed(this.withSplit(split)) : reject("split-out-of-range")
      },
      Unsolo: () => Result.succeed({ ...this, solo: Option.none() }),
      Swap: ({ a, b }) =>
        Option.isNone(Arr.get(this.tiles, a)) || Option.isNone(Arr.get(this.tiles, b))
          ? reject("no-such-tile")
          : Result.succeed({ ...this, tiles: swapped(this.tiles, a, b) }),
      Assign: ({ tile, game }) =>
        tileAt(this, tile, () => {
          const assigned = Screen.tileFor(game, availabilityOf(game))
          // A game appears in at most one tile, on screen or benched: assigning it elsewhere moves it.
          const tiles = this.tiles.map((existing, index) =>
            index === tile ? assigned : holds(existing, TileKey.game(game)) ? empty : existing
          )
          return Result.succeed({ ...this, tiles })
        }),
      Clear: ({ tile }) =>
        tileAt(this, tile, () => {
          const tiles = this.tiles.map((existing, index) => (index === tile ? empty : existing))
          return Result.succeed({ ...this, tiles })
        }),
      Promote: ({ tile }) =>
        tileAt(this, tile, (found) =>
          occupied(found, (held) =>
            Result.succeed({
              ...this,
              tiles: swapped(this.tiles, 0, tile),
              audioFocus: Option.some(Tile.key(held))
            })
          )
        ),
      FocusAudio: ({ tile }) =>
        onScreenAt(this, tile, (held) =>
          Result.succeed({ ...this, audioFocus: Option.some(Tile.key(held)) })
        ),
      Solo: ({ tile }) =>
        onScreenAt(this, tile, (held) => {
          const key = Tile.key(held)
          return Result.succeed({ ...this, audioFocus: Option.some(key), solo: Option.some(key) })
        })
    })
    return Result.map(next, settle)
  }

  /**
   * Re-resolves every occupied tile, on screen and benched, after what a source knows has changed. A game
   * `availabilityOf` knows nothing about keeps its tile as it was: the change did not concern it.
   *
   * A stream tile is replaced only when its own source carries its game on another channel. Any other availability
   * (another source carrying it, a game running past its listing, no guide, a failed or stale read) never stops
   * it. Every other occupied tile becomes what the most useful availability says. When no tile changes, it is this
   * Screen.
   */
  refresh(availabilityOf: (game: GameId) => Option.Option<ReadonlyArray<ChannelAvailability>>): Screen {
    const tiles = this.tiles.map((tile) =>
      Tile.guards.Empty(tile)
        ? tile
        : Option.match(availabilityOf(tile.game), {
            onNone: () => tile,
            onSome: (availability) =>
              Tile.guards.StreamTile(tile)
                ? movedWithinSource(tile, availability)
                : Screen.tileFor(tile.game, availability)
          })
    )

    return Arr.makeEquivalence(tileEquivalence)(tiles, this.tiles) ? this : settle({ ...this, tiles })
  }
}

export const ScreenCommand = Schema.TaggedUnion({
  Assign: { tile: Schema.Int, game: GameId },
  Clear: { tile: Schema.Int },
  FocusAudio: { tile: Schema.Int },
  Swap: { a: Schema.Int, b: Schema.Int },
  Promote: { tile: Schema.Int },
  SetLayout: { layout: LayoutName },
  SetSplit: { split: Split },
  Solo: { tile: Schema.Int },
  Unsolo: {}
})
export type ScreenCommand = typeof ScreenCommand.Type

export class ScreenRejection extends Schema.TaggedError<ScreenRejection>()("ScreenRejection", {
  reason: Schema.Literals(["no-such-tile", "empty-tile", "offscreen-tile", "split-out-of-range"])
}) {}

/** A tile that holds a game. */
type Occupied = Exclude<Tile, { readonly _tag: "Empty" }>

/** A Screen's fields before `settle` makes them a Screen that keeps its invariants. */
interface Unsettled {
  readonly tiles: ReadonlyArray<Tile>
  readonly layout: LayoutName
  readonly splits: Screen["splits"]
  readonly audioFocus: Option.Option<TileKey>
  readonly solo: Option.Option<TileKey>
}

/** What `tile` shows, as a key: its game's id for a stream or data tile; none for an empty tile. */
function key(tile: Occupied): TileKey
function key(tile: Tile): TileKey | undefined
function key(tile: Tile): TileKey | undefined {
  return Tile.guards.Empty(tile) ? undefined : TileKey.game(tile.game)
}

/** Runs `f` on the tile at `index`, or rejects a tile that does not exist. */
function tileAt(
  screen: Screen,
  index: number,
  f: (tile: Tile) => Result.Result<Unsettled, ScreenRejection>
): Result.Result<Unsettled, ScreenRejection> {
  return Option.match(Arr.get(screen.tiles, index), { onNone: () => reject("no-such-tile"), onSome: f })
}

/** Runs `f` on the occupied on-screen tile at `index`, or says why there is none. */
function onScreenAt(
  screen: Screen,
  index: number,
  f: (tile: Occupied) => Result.Result<Unsettled, ScreenRejection>
): Result.Result<Unsettled, ScreenRejection> {
  return tileAt(screen, index, (tile) =>
    index >= Screen.slotCount(screen.layout) ? reject("offscreen-tile") : occupied(tile, f)
  )
}

function occupied(
  tile: Tile,
  f: (tile: Occupied) => Result.Result<Unsettled, ScreenRejection>
): Result.Result<Unsettled, ScreenRejection> {
  return Tile.guards.Empty(tile) ? reject("empty-tile") : f(tile)
}

function holds(tile: Tile, key: TileKey): boolean {
  return Tile.key(tile) === key
}

/** The availability that says most of several: ties go to the first, and none at all is no stream. */
function mostUseful(availability: ReadonlyArray<ChannelAvailability>): ChannelAvailability {
  return Arr.reduce<ChannelAvailability, ChannelAvailability>(
    availability,
    { _tag: "NotCarried", why: "NoStream" },
    (best, next) => (usefulness(next) > usefulness(best) ? next : best)
  )
}

/**
 * How much an availability tells: carried; upcoming on a known channel; upcoming with nothing known; no guide (it may
 * yet be carried); streaming only; not in the guide; no stream.
 */
function usefulness(availability: ChannelAvailability): number {
  return ChannelAvailability.match(availability, {
    Carried: () => 6,
    Upcoming: ({ channel }) => (Option.isSome(channel) ? 5 : 4),
    NoGuide: () => 3,
    NotCarried: ({ why }) => (why === "StreamingOnly" ? 2 : why === "NotInGuide" ? 1 : 0)
  })
}

/**
 * Builds a Screen that keeps the invariants: the layout's slots exist, the bench ends in a game, audio is on
 * an on-screen game (the focused one while it is on screen, else the first), and solo is on an on-screen game.
 */
function settle(fields: Unsettled): Screen {
  const slots = Screen.slotCount(fields.layout)
  const kept = Option.getOrElse(
    Option.map(
      Arr.findLastIndex(fields.tiles, (tile) => !Tile.guards.Empty(tile)),
      (last) => last + 1
    ),
    () => 0
  )
  const tiles = Arr.makeBy(Math.max(slots, kept), (index) => fields.tiles[index] ?? empty)
  const onScreen = tiles.slice(0, slots).flatMap((tile) => (Tile.guards.Empty(tile) ? [] : [Tile.key(tile)]))
  const isOnScreen = (key: TileKey) => onScreen.includes(key)
  return new Screen({
    tiles,
    layout: fields.layout,
    splits: fields.splits,
    audioFocus: Option.orElse(Option.filter(fields.audioFocus, isOnScreen), () => Arr.head(onScreen)),
    solo: Option.filter(fields.solo, isOnScreen)
  })
}

/**
 * A stream tile stays as it is unless its own source carries its game on another channel, then it moves there. It never
 * moves to another source, whatever the other sources say.
 */
function movedWithinSource(
  tile: Extract<Tile, { _tag: "StreamTile" }>,
  availability: ReadonlyArray<ChannelAvailability>
): Tile {
  const moved = Arr.findFirst(
    availability.filter(ChannelAvailability.guards.Carried),
    ({ channel }) =>
      channel.source === tile.channel.source && channel.locator.url !== tile.channel.locator.url
  )
  return Option.match(moved, { onNone: () => tile, onSome: ({ channel }) => ({ ...tile, channel }) })
}

function reject(reason: ScreenRejection["reason"]) {
  return Result.fail(new ScreenRejection({ reason }))
}

function swapped(tiles: ReadonlyArray<Tile>, a: number, b: number): ReadonlyArray<Tile> {
  return tiles.map((tile, index) =>
    index === a ? (tiles[b] ?? tile) : index === b ? (tiles[a] ?? tile) : tile
  )
}

/** Whether two tiles say the same: a refreshed data tile is a new object even when nothing in it changed. */
const tileEquivalence = Schema.toEquivalence(Tile)
