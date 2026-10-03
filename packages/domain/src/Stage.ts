import { Option, Result, Schema } from "effect"
import { GameId, Network } from "./Game.ts"
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

export class Stage extends Schema.Class<Stage>("sportal/Stage")({
  tiles: Schema.Array(Tile),
  audioFocus: Schema.Int
}) {
  /** Four empty tiles, with audio focus on the first. */
  static readonly initial = new Stage({
    tiles: [{ _tag: "Empty" }, { _tag: "Empty" }, { _tag: "Empty" }, { _tag: "Empty" }],
    audioFocus: 0
  })

  /**
   * Applies a command. `availabilityOf` says whether and where a game can be streamed: a carried game
   * becomes a stream tile, a game on an unlearned network a picking tile, and any other a data tile.
   */
  apply(
    command: StageCommand,
    availabilityOf: (game: GameId) => ChannelAvailability
  ): Result.Result<Stage, StageRejection> {
    if (command.tile < 0 || command.tile >= this.tiles.length) {
      return Result.fail(new StageRejection({ reason: "no-such-tile" }))
    }
    switch (command._tag) {
      case "Assign": {
        const tile = tileFor(command.game, availabilityOf(command.game))
        // A game appears in at most one tile: assigning it elsewhere moves it.
        const tiles = this.tiles.map((existing, index) =>
          index === command.tile
            ? tile
            : existing._tag !== "Empty" && existing.game === command.game
              ? empty
              : existing
        )
        return Result.succeed(new Stage({ tiles, audioFocus: this.audioFocus }))
      }
      case "Clear":
        return Result.succeed(
          new Stage({
            tiles: this.tiles.map((existing, index) => (index === command.tile ? empty : existing)),
            audioFocus: this.audioFocus
          })
        )
      case "FocusAudio":
        return Result.succeed(new Stage({ tiles: this.tiles, audioFocus: command.tile }))
    }
  }

  /**
   * Re-resolves every occupied tile after what a source knows has changed. A game `availabilityOf` knows
   * nothing about keeps its tile as it was: the change did not concern it.
   *
   * A stream tile follows its origin. One the guide matched (no `learnedFor`) keeps playing on any answer
   * but a channel: a game running past its listing, or a failed or stale read falling back to the lineup,
   * never stops it; carried on another channel moves it. One picked by hand (`learnedFor` set) follows the
   * answer, so **wrong channel** returns it to the guide.
   */
  refresh(availabilityOf: (game: GameId) => Option.Option<ChannelAvailability>): Stage {
    return new Stage({
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
      ),
      audioFocus: this.audioFocus
    })
  }
}

export const StageCommand = Schema.Union([
  Schema.TaggedStruct("Assign", { tile: Schema.Int, game: GameId }),
  Schema.TaggedStruct("Clear", { tile: Schema.Int }),
  Schema.TaggedStruct("FocusAudio", { tile: Schema.Int })
])
export type StageCommand = typeof StageCommand.Type

export class StageRejection extends Schema.TaggedError<StageRejection>()(
  "StageRejection",
  { reason: Schema.Literals(["no-such-tile"]) },
  { httpApiStatus: 422 }
) {}

const empty: Tile = { _tag: "Empty" }

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
