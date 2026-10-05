import type { Hotkey } from "@sportal/api/Hotkey"
import type { GameId } from "@sportal/domain/Game"
import { Layout } from "@sportal/domain/Layout"
import type { Stage, StageCommand } from "@sportal/domain/Stage"
import { Data } from "effect"
import { nextPick, pickable, type stripCards } from "./slate/StripCards.ts"

type Overlay = Data.TaggedEnum<{ None: object; Keys: object; Palette: object; JoinRemote: object }>
const Overlay = Data.taggedEnum<Overlay>()

/**
 * A Display's local state: what is selected, interacting, picked, and open. Never sent to the Hub. Each input
 * answers with the next Display and the stage commands for the caller to send.
 */
export class Display extends Data.Class<{
  /** The slot as last chosen; read it through `selectedOn`. */
  readonly selected: number
  /** Read it through `interactingOn`. */
  readonly interacting: GameId | undefined
  readonly pick: GameId | undefined
  readonly slateOpen: boolean
  readonly overlay: Overlay
}> {
  /** Slot 0, nothing interacting or picked, the slate open, and no overlay. */
  static readonly initial = new Display({
    selected: 0,
    interacting: undefined,
    pick: undefined,
    slateOpen: true,
    overlay: Overlay.None()
  })

  /** The selected slot on this Stage: the last slot when the layout now has fewer. */
  selectedOn(stage: Stage): number {
    return Math.min(this.selected, stage.onStage().length - 1)
  }

  /**
   * The interacting game, while the selected slot still holds its stream; otherwise none. It returns when its game is
   * back in the selected slot.
   */
  interactingOn(stage: Stage): GameId | undefined {
    const tile = stage.onStage()[this.selectedOn(stage)]
    return tile?._tag === "StreamTile" && tile.game === this.interacting ? this.interacting : undefined
  }

  /** What a hotkey does. `FullScreen` does nothing here: it is the shell's or browser's, not the Display's. */
  press(
    hotkey: Hotkey,
    stage: Stage,
    cards: ReturnType<typeof stripCards>
  ): { display: Display; commands: ReadonlyArray<StageCommand> } {
    switch (hotkey._tag) {
      case "SelectTile":
        return this.select(hotkey.slot, stage)
      case "ToggleSolo": {
        if (stage.solo !== undefined) return { display: this, commands: [{ _tag: "Unsolo" }] }
        const slot = this.selectedOn(stage)
        return {
          display: this,
          commands: stage.onStage()[slot]?._tag === "Empty" ? [] : [{ _tag: "Solo", tile: slot }]
        }
      }
      case "Unsolo":
        if (!Overlay.$is("None")(this.overlay)) return { display: this.close(), commands: [] }
        return { display: this, commands: stage.solo === undefined ? [] : [{ _tag: "Unsolo" }] }
      case "Interact": {
        const tile = stage.onStage()[this.selectedOn(stage)]
        if (tile?._tag !== "StreamTile") return { display: this, commands: [] }
        return {
          display: new Display({
            ...this,
            interacting: this.interactingOn(stage) === undefined ? tile.game : undefined
          }),
          commands: []
        }
      }
      case "StepPick":
        return {
          display: new Display({ ...this, pick: nextPick(cards, this.pick, hotkey.step) }),
          commands: []
        }
      case "DropPick": {
        const card = cards.find((card) => card.id === this.pick)
        return card === undefined ? { display: this, commands: [] } : this.drop(card, stage)
      }
      case "ToggleSlate":
        return { display: this.toggleSlate(), commands: [] }
      case "ShowKeys":
        return { display: Overlay.$is("Keys")(this.overlay) ? this.close() : this.open("Keys"), commands: [] }
      case "CommandPalette":
        return {
          display: Overlay.$is("Palette")(this.overlay) ? this.close() : this.open("Palette"),
          commands: []
        }
      case "FocusAudio":
        return { display: this, commands: [{ _tag: "FocusAudio", tile: hotkey.slot }] }
      case "Promote":
        return { display: this, commands: [{ _tag: "Promote", tile: hotkey.slot }] }
      case "NextLayout":
        return { display: this, commands: [{ _tag: "SetLayout", layout: Layout.next(stage.layout) }] }
      case "FullScreen":
        return { display: this, commands: [] }
    }
  }

  /** Selects a slot on stage, ending interacting when the slot changes. A slot past the last is ignored. */
  select(slot: number, stage: Stage): { display: Display; commands: ReadonlyArray<StageCommand> } {
    if (slot < 0 || slot >= stage.onStage().length) return { display: this, commands: [] }
    return {
      display: new Display({
        ...this,
        selected: slot,
        interacting: slot === this.selectedOn(stage) ? this.interacting : undefined
      }),
      commands: []
    }
  }

  /**
   * Drops a card into the selected slot and picks it: a free game is assigned, a benched one swapped in, and a game
   * on stage is not droppable. Then selects the next empty slot, so the next drop fills it, or keeps the selection
   * when none is left.
   */
  drop(
    card: ReturnType<typeof stripCards>[number],
    stage: Stage
  ): { display: Display; commands: ReadonlyArray<StageCommand> } {
    const slot = this.selectedOn(stage)
    if (!pickable(card)) return { display: this, commands: [] }
    const { display, commands } = new Display({ ...this, pick: card.id }).select(
      stage.nextEmptySlot(slot) ?? slot,
      stage
    )
    return {
      display,
      commands: [
        card.place === undefined
          ? { _tag: "Assign", tile: slot, game: card.id }
          : { _tag: "Swap", a: card.place.tile, b: slot },
        ...commands
      ]
    }
  }

  toggleSlate(): Display {
    return new Display({ ...this, slateOpen: !this.slateOpen })
  }

  /** Opens an overlay, closing any other: at most one is open. */
  open(overlay: "Keys" | "Palette" | "JoinRemote"): Display {
    return new Display({ ...this, overlay: Overlay[overlay]() })
  }

  close(): Display {
    return new Display({ ...this, overlay: Overlay.None() })
  }
}
