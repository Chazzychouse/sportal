import { Option, Result, Schema } from "effect"
import { GameId, Network } from "./Game.ts"
import { Layout, LayoutName, Split } from "./Layout.ts"
import { Channel, type ChannelAvailability, SourceName } from "./Source.ts"
import { StreamLocator } from "./Stream.ts"

export const Tile = Schema.Union([
  Schema.TaggedStruct("Empty", {}),
  /** `learnedFor` is the network a hand-picked channel was learned for; **wrong channel** forgets it. */
  Schema.TaggedStruct("StreamTile", { game: GameId, channel: Channel, learnedFor: Schema.optional(Network) }),
  /** The game's network has no channel yet: the tile shows the source's guide until one is picked. */
  Schema.TaggedStruct("PickingChannel", {
    game: GameId,
    network: Network,
    source: SourceName,
    guide: StreamLocator
  }),
  /** No stream, and why: none on any source, streaming only, not in the guide, or not on yet. */
  Schema.TaggedStruct("DataTile", {
    game: GameId,
    why: Schema.Union([
      Schema.TaggedStruct("NoStream", {}),
      Schema.TaggedStruct("StreamingOnly", {}),
      Schema.TaggedStruct("NotInGuide", {}),
      Schema.TaggedStruct("NotYet", {
        channel: Schema.optional(Schema.String),
        begin: Schema.optional(Schema.DateTimeUtcFromString)
      })
    ])
  })
])
export type Tile = typeof Tile.Type

const empty: Tile = { _tag: "Empty" }

export class Stage extends Schema.Class<Stage>("sportal/Stage")({
  /** The first `Layout.slotCount(layout)` tiles are on stage, main tile first; the rest are the bench. */
  tiles: Schema.Array(Tile),
  layout: LayoutName,
  /** Each layout's own split, kept while another layout is shown. */
  splits: Schema.Record(LayoutName, Split),
  /** The game whose sound is on: always an on-stage game, or none when the stage is empty. */
  audioFocus: Schema.optional(GameId),
  /** The game filling the Stage: always an on-stage game. */
  solo: Schema.optional(GameId)
}) {
  /** An empty Quad, every layout at its default split. */
  static readonly initial = new Stage({
    tiles: [empty, empty, empty, empty],
    layout: "Quad",
    splits: Layout.defaultSplits()
  })

  /** Whether the game's sound is on. */
  hears(game: GameId): boolean {
    return this.audioFocus === game
  }

  /** Whether the game fills the Stage. */
  soloes(game: GameId): boolean {
    return this.solo === game
  }

  /** The Stage with the current layout's split replaced: the preview of a divider drag. */
  withSplit(split: Split): Stage {
    return new Stage({ ...this, splits: { ...this.splits, [this.layout]: split } })
  }

  currentLayout(): Layout {
    return new Layout({ name: this.layout, split: this.splits[this.layout] })
  }

  /** The tiles in the layout's slots, main tile first. */
  onStage(): ReadonlyArray<Tile> {
    return this.tiles.slice(0, Layout.slotCount(this.layout))
  }

  /** The games on the bench, in order, each with its tile. Empty tiles past the slots are skipped. */
  benched(): ReadonlyArray<{ tile: number; game: GameId }> {
    const first = Layout.slotCount(this.layout)
    return this.tiles.flatMap((tile, index) =>
      index < first || tile._tag === "Empty" ? [] : [{ tile: index, game: tile.game }]
    )
  }

  /** The slot a game is in, if it is on stage. */
  slotOf(game: GameId): number | undefined {
    const slot = this.onStage().findIndex((tile) => tile._tag !== "Empty" && tile.game === game)
    return slot === -1 ? undefined : slot
  }

  /** The first empty on-stage slot after `slot`, wrapping round; never `slot` itself. */
  nextEmptySlot(slot: number): number | undefined {
    const slots = this.onStage()
    for (let offset = 1; offset < slots.length; offset++) {
      const next = (slot + offset) % slots.length
      if (slots[next]?._tag === "Empty") return next
    }
    return undefined
  }

  /**
   * Applies a command. `availabilityOf` says whether and where a game can be streamed: a carried game
   * becomes a stream tile, a game on an unlearned network a picking tile, and any other a data tile.
   */
  apply(
    command: StageCommand,
    availabilityOf: (game: GameId) => ChannelAvailability
  ): Result.Result<Stage, StageRejection> {
    switch (command._tag) {
      case "SetLayout":
        return Result.succeed(settle({ ...this, layout: command.layout }))
      case "SetSplit":
        return Layout.holds(command.split)
          ? Result.succeed(settle(this.withSplit(command.split)))
          : reject("split-out-of-range")
      case "Unsolo":
        return Result.succeed(settle({ ...this, solo: undefined }))
      case "Swap":
        return this.tiles[command.a] === undefined || this.tiles[command.b] === undefined
          ? reject("no-such-tile")
          : Result.succeed(settle({ ...this, tiles: swapped(this.tiles, command.a, command.b) }))
    }
    // Every other command names one tile.
    const tile = this.tiles[command.tile]
    if (tile === undefined) return reject("no-such-tile")
    switch (command._tag) {
      case "Assign": {
        const assigned = tileFor(command.game, availabilityOf(command.game))
        // A game appears in at most one tile, on stage or benched: assigning it elsewhere moves it.
        const tiles = this.tiles.map((existing, index) =>
          index === command.tile
            ? assigned
            : existing._tag !== "Empty" && existing.game === command.game
              ? empty
              : existing
        )
        return Result.succeed(settle({ ...this, tiles }))
      }
      case "Clear":
        return Result.succeed(
          settle({
            ...this,
            tiles: this.tiles.map((existing, index) => (index === command.tile ? empty : existing))
          })
        )
      case "Promote":
        return tile._tag === "Empty"
          ? reject("empty-tile")
          : Result.succeed(
              settle({ ...this, tiles: swapped(this.tiles, 0, command.tile), audioFocus: tile.game })
            )
      case "FocusAudio":
      case "Solo":
        if (command.tile >= Layout.slotCount(this.layout)) return reject("offstage-tile")
        if (tile._tag === "Empty") return reject("empty-tile")
        return Result.succeed(
          settle({ ...this, audioFocus: tile.game, ...(command._tag === "Solo" ? { solo: tile.game } : {}) })
        )
    }
  }

  /**
   * Re-resolves every occupied tile, on stage and benched, after what a source knows has changed. A game
   * `availabilityOf` knows nothing about keeps its tile as it was: the change did not concern it.
   *
   * A stream tile follows its origin. One the guide matched (no `learnedFor`) keeps playing on any answer
   * but a channel: a game running past its listing, or a failed or stale read falling back to the lineup,
   * never stops it; carried on another channel moves it. One picked by hand (`learnedFor` set) follows the
   * answer, so **wrong channel** returns it to the guide.
   */
  refresh(availabilityOf: (game: GameId) => Option.Option<ChannelAvailability>): Stage {
    return settle({
      ...this,
      tiles: this.tiles.map((tile) =>
        tile._tag === "Empty"
          ? tile
          : Option.match(availabilityOf(tile.game), {
              onNone: () => tile,
              onSome: (availability) =>
                tile._tag === "StreamTile" && tile.learnedFor === undefined && availability._tag !== "Carried"
                  ? tile
                  : tileFor(tile.game, availability)
            })
      )
    })
  }
}

export const StageCommand = Schema.Union([
  Schema.TaggedStruct("Assign", { tile: Schema.Int, game: GameId }),
  Schema.TaggedStruct("Clear", { tile: Schema.Int }),
  Schema.TaggedStruct("FocusAudio", { tile: Schema.Int }),
  Schema.TaggedStruct("Swap", { a: Schema.Int, b: Schema.Int }),
  Schema.TaggedStruct("Promote", { tile: Schema.Int }),
  Schema.TaggedStruct("SetLayout", { layout: LayoutName }),
  Schema.TaggedStruct("SetSplit", { split: Split }),
  Schema.TaggedStruct("Solo", { tile: Schema.Int }),
  Schema.TaggedStruct("Unsolo", {})
])
export type StageCommand = typeof StageCommand.Type

export class StageRejection extends Schema.TaggedError<StageRejection>()(
  "StageRejection",
  { reason: Schema.Literals(["no-such-tile", "empty-tile", "offstage-tile", "split-out-of-range"]) },
  { httpApiStatus: 422 }
) {}

function tileFor(game: GameId, availability: ChannelAvailability): Tile {
  switch (availability._tag) {
    case "Carried":
      return {
        _tag: "StreamTile",
        game,
        channel: availability.channel,
        ...(Option.isSome(availability.learnedFor) ? { learnedFor: availability.learnedFor.value } : {})
      }
    case "Unlearned":
      return {
        _tag: "PickingChannel",
        game,
        network: availability.network,
        source: availability.source,
        guide: availability.guide
      }
    case "Upcoming":
      return {
        _tag: "DataTile",
        game,
        why: {
          _tag: "NotYet",
          ...(Option.isSome(availability.channel) ? { channel: availability.channel.value } : {}),
          ...(Option.isSome(availability.begin) ? { begin: availability.begin.value } : {})
        }
      }
    case "NotCarried":
      return { _tag: "DataTile", game, why: { _tag: availability.why } }
  }
}

/**
 * Builds a Stage that keeps the invariants: the layout's slots exist, the bench ends in a game, audio is on
 * an on-stage game (the focused one while it is on stage, else the first), and solo is on an on-stage game.
 */
function settle(fields: {
  tiles: ReadonlyArray<Tile>
  layout: LayoutName
  splits: Stage["splits"]
  audioFocus?: GameId | undefined
  solo?: GameId | undefined
}): Stage {
  const slots = Layout.slotCount(fields.layout)
  const tiles = [...fields.tiles]
  while (tiles.length < slots) tiles.push(empty)
  while (tiles.length > slots && tiles.at(-1)?._tag === "Empty") tiles.pop()
  const onStage = tiles.slice(0, slots).flatMap((tile) => (tile._tag === "Empty" ? [] : [tile.game]))
  const audioFocus = onStage.find((game) => game === fields.audioFocus) ?? onStage[0]
  const solo = onStage.find((game) => game === fields.solo)
  return new Stage({
    tiles,
    layout: fields.layout,
    splits: fields.splits,
    ...(audioFocus === undefined ? {} : { audioFocus }),
    ...(solo === undefined ? {} : { solo })
  })
}

function reject(reason: StageRejection["reason"]) {
  return Result.fail(new StageRejection({ reason }))
}

function swapped(tiles: ReadonlyArray<Tile>, a: number, b: number): ReadonlyArray<Tile> {
  return tiles.map((tile, index) =>
    index === a ? (tiles[b] ?? tile) : index === b ? (tiles[a] ?? tile) : tile
  )
}
