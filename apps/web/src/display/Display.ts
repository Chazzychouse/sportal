import { Hotkey } from "@sportal/api/Hotkey"
import type { GameId } from "@sportal/domain/Game"
import { type Screen, type ScreenCommand, Tile } from "@sportal/domain/Screen"
import { Data, Option } from "effect"
import { Layout } from "../layout/Layout.ts"
import { Place, StripCard } from "../slate/StripCards.ts"

type Overlay = Data.TaggedEnum<{ None: object; Keys: object; Palette: object; JoinRemote: object }>
const Overlay = Data.taggedEnum<Overlay>()

/**
 * A Display's local state: what is selected, interacting, picked, and open. Never sent to the Hub. Each input
 * answers with the next Display and the screen commands for the caller to send.
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

  /** The selected slot on this Screen: the last slot when the layout now has fewer. */
  selectedOn(screen: Screen): number {
    return Math.min(this.selected, screen.onScreen().length - 1)
  }

  /**
   * The interacting game, while the selected slot still holds its stream; otherwise none. It returns when its game is
   * back in the selected slot.
   */
  interactingOn(screen: Screen): GameId | undefined {
    const tile = screen.onScreen()[this.selectedOn(screen)]
    return Tile.guards.StreamTile(tile) && tile.game === this.interacting ? this.interacting : undefined
  }

  /** What a hotkey does. `FullScreen` does nothing here: it is the shell's or browser's, not the Display's. */
  press(hotkey: Hotkey, screen: Screen, cards: ReadonlyArray<StripCard>): DisplayStep {
    const stay = (commands: ReadonlyArray<ScreenCommand>) => new DisplayStep({ display: this, commands })
    return Hotkey.match(hotkey, {
      SelectTile: ({ slot }) => this.select(slot, screen),
      ToggleSolo: () => {
        if (Option.isSome(screen.solo)) return stay([{ _tag: "Unsolo" }])
        const slot = this.selectedOn(screen)
        return stay(Tile.guards.Empty(screen.onScreen()[slot]) ? [] : [{ _tag: "Solo", tile: slot }])
      },
      Unsolo: () =>
        !Overlay.$is("None")(this.overlay)
          ? new DisplayStep({ display: this.close(), commands: [] })
          : stay(Option.isNone(screen.solo) ? [] : [{ _tag: "Unsolo" }]),
      Interact: () => {
        const tile = screen.onScreen()[this.selectedOn(screen)]
        if (!Tile.guards.StreamTile(tile)) return stay([])
        return new DisplayStep({
          display: new Display({
            ...this,
            interacting: this.interactingOn(screen) === undefined ? tile.game : undefined
          }),
          commands: []
        })
      },
      StepPick: ({ step }) =>
        new DisplayStep({
          display: new Display({ ...this, pick: StripCard.nextPick(cards, this.pick, step) }),
          commands: []
        }),
      DropPick: () => {
        const card = cards.find((card) => card.id === this.pick)
        return card === undefined ? stay([]) : this.drop(card, screen)
      },
      ToggleSlate: () => new DisplayStep({ display: this.toggleSlate(), commands: [] }),
      ShowKeys: () =>
        new DisplayStep({
          display: Overlay.$is("Keys")(this.overlay) ? this.close() : this.open("Keys"),
          commands: []
        }),
      CommandPalette: () =>
        new DisplayStep({
          display: Overlay.$is("Palette")(this.overlay) ? this.close() : this.open("Palette"),
          commands: []
        }),
      FocusAudio: ({ slot }) => stay([{ _tag: "FocusAudio", tile: slot }]),
      Promote: ({ slot }) => stay([{ _tag: "Promote", tile: slot }]),
      NextLayout: () => stay([{ _tag: "SetLayout", layout: Layout.next(screen.layout) }]),
      FullScreen: () => stay([])
    })
  }

  /** Selects a slot on screen, ending interacting when the slot changes. A slot past the last is ignored. */
  select(slot: number, screen: Screen): DisplayStep {
    if (slot < 0 || slot >= screen.onScreen().length) return new DisplayStep({ display: this, commands: [] })
    return new DisplayStep({
      display: new Display({
        ...this,
        selected: slot,
        interacting: slot === this.selectedOn(screen) ? this.interacting : undefined
      }),
      commands: []
    })
  }

  /**
   * Drops a card into the selected slot and picks it: a free game is assigned, a benched one swapped in, and a game
   * on screen is not droppable. Then selects the next empty slot, so the next drop fills it, or keeps the selection
   * when none is left.
   */
  drop(card: StripCard, screen: Screen): DisplayStep {
    const slot = this.selectedOn(screen)
    if (!card.pickable()) return new DisplayStep({ display: this, commands: [] })
    const { place } = card
    const { display, commands } = new Display({ ...this, pick: card.id }).select(
      screen.nextEmptySlot(slot) ?? slot,
      screen
    )
    return new DisplayStep({
      display,
      commands: [
        Place.$is("Bench")(place)
          ? { _tag: "Swap", a: place.tile, b: slot }
          : { _tag: "Assign", tile: slot, game: card.id },
        ...commands
      ]
    })
  }

  toggleSlate(): Display {
    return new Display({ ...this, slateOpen: !this.slateOpen })
  }

  /** Whether this overlay is the one open. */
  shows(overlay: Exclude<Overlay["_tag"], "None">): boolean {
    return Overlay.$is(overlay)(this.overlay)
  }

  /** Opens an overlay, closing any other: at most one is open. */
  open(overlay: Exclude<Overlay["_tag"], "None">): Display {
    return new Display({ ...this, overlay: Overlay[overlay]() })
  }

  close(): Display {
    return new Display({ ...this, overlay: Overlay.None() })
  }
}

/** A Display after an input, and the Screen commands the input sends. */
export class DisplayStep extends Data.Class<{
  readonly display: Display
  readonly commands: ReadonlyArray<ScreenCommand>
}> {}
