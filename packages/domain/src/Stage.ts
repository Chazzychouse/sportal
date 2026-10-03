import { Option, Result, Schema } from "effect"
import { GameId } from "./Game.ts"
import { StreamLocator } from "./Stream.ts"

export const Tile = Schema.Union([
  Schema.TaggedStruct("Empty", {}),
  Schema.TaggedStruct("StreamTile", { game: GameId, locator: StreamLocator }),
  Schema.TaggedStruct("DataTile", { game: GameId })
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
   * Applies a command. `locate` says where a game can be streamed from, if anywhere;
   * a game with no stream becomes a data tile.
   */
  apply(
    command: StageCommand,
    locate: (game: GameId) => Option.Option<StreamLocator>
  ): Result.Result<Stage, StageRejection> {
    if (command.tile < 0 || command.tile >= this.tiles.length) {
      return Result.fail(new StageRejection({ reason: "no-such-tile" }))
    }
    switch (command._tag) {
      case "Assign": {
        const tile: Tile = Option.match(locate(command.game), {
          onNone: () => ({ _tag: "DataTile", game: command.game }),
          onSome: (locator) => ({ _tag: "StreamTile", game: command.game, locator })
        })
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
