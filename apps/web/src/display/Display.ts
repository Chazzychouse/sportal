import { Hotkey } from "@sportal/api/Hotkey"
import type { GameId } from "@sportal/domain/Game"
import { Data, Option } from "effect"
import { Layout } from "../layout/Layout.ts"
import { type Screen, type ScreenCommand, Tile } from "../screen/Screen.ts"
import { Place, StripCard } from "../slate/StripCard.ts"

/** The one overlay a Display has open, or none. Above the class: `Display.initial` reads it when the class is defined. */
export type Overlay = Data.TaggedEnum<{ None: object; Keys: object; Palette: object; JoinRemote: object }>
export const Overlay = Data.taggedEnum<Overlay>()

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

  /** What an input does on this Screen, with the slate strip's `cards`. */
  apply(input: DisplayInput, screen: Screen, cards: ReadonlyArray<StripCard>): DisplayStep {
    return DisplayInput.$match(input, {
      Pressed: ({ hotkey }) => this.press(hotkey, screen, cards),
      Selected: ({ slot }) => this.select(slot, screen),
      VideoPressed: ({ game }) => {
        const slot = screen.slotOf(game)
        return slot === undefined ? DisplayStep.of(this) : this.select(slot, screen)
      },
      Dropped: ({ card }) => this.drop(card, screen),
      Commanded: ({ command }) => DisplayStep.of(this, [command]),
      Opened: ({ overlay }) => DisplayStep.of(this.open(overlay)),
      Closed: () => DisplayStep.of(this.close()),
      SlateToggled: () => DisplayStep.of(this.toggleSlate())
    })
  }

  /**
   * What a hotkey does. `FullScreen`, `ToggleAutopilot` and the prompt keys do nothing here: the first is the
   * shell's or browser's, the second the autopilot's, the rest the prompts'.
   */
  press(hotkey: Hotkey, screen: Screen, cards: ReadonlyArray<StripCard>): DisplayStep {
    return Hotkey.match(hotkey, {
      SelectTile: ({ slot }) => this.select(slot, screen),
      ToggleSolo: () => {
        if (Option.isSome(screen.solo)) return DisplayStep.of(this, [{ _tag: "Unsolo" }])
        const slot = this.selectedOn(screen)
        return DisplayStep.of(
          this,
          Tile.guards.Empty(screen.onScreen()[slot]) ? [] : [{ _tag: "Solo", tile: slot }]
        )
      },
      Unsolo: () =>
        !Overlay.$is("None")(this.overlay)
          ? DisplayStep.of(this.close())
          : DisplayStep.of(this, Option.isNone(screen.solo) ? [] : [{ _tag: "Unsolo" }]),
      Interact: () => {
        const tile = screen.onScreen()[this.selectedOn(screen)]
        if (!Tile.guards.StreamTile(tile)) return DisplayStep.of(this)
        const interacting = this.interactingOn(screen) === undefined ? tile.game : undefined
        return DisplayStep.of(new Display({ ...this, interacting }))
      },
      StepPick: ({ step }) =>
        DisplayStep.of(new Display({ ...this, pick: StripCard.nextPick(cards, this.pick, step) })),
      DropPick: () => {
        const card = cards.find((card) => card.id === this.pick)
        return card === undefined ? DisplayStep.of(this) : this.drop(card, screen)
      },
      ToggleSlate: () => DisplayStep.of(this.toggleSlate()),
      ShowKeys: () => DisplayStep.of(Overlay.$is("Keys")(this.overlay) ? this.close() : this.open("Keys")),
      CommandPalette: () =>
        DisplayStep.of(Overlay.$is("Palette")(this.overlay) ? this.close() : this.open("Palette")),
      FocusAudio: ({ slot }) => DisplayStep.of(this, [{ _tag: "FocusAudio", tile: slot }]),
      Promote: ({ slot }) => DisplayStep.of(this, [{ _tag: "Promote", tile: slot }]),
      NextLayout: () => DisplayStep.of(this, [{ _tag: "SetLayout", layout: Layout.next(screen.layout) }]),
      FullScreen: () => DisplayStep.of(this),
      ToggleAutopilot: () => DisplayStep.of(this),
      TogglePrompts: () => DisplayStep.of(this),
      AcceptPrompt: () => DisplayStep.of(this),
      DismissPrompt: () => DisplayStep.of(this)
    })
  }

  /** Selects a slot on screen, ending interacting when the slot changes. A slot past the last is ignored. */
  select(slot: number, screen: Screen): DisplayStep {
    if (slot < 0 || slot >= screen.onScreen().length) return DisplayStep.of(this)
    const interacting = slot === this.selectedOn(screen) ? this.interacting : undefined
    return DisplayStep.of(new Display({ ...this, selected: slot, interacting }))
  }

  /**
   * Drops a card into the selected slot and picks it: a free game is assigned, a benched one swapped in, and a game
   * on screen is not droppable. Then selects the next empty slot, so the next drop fills it, or keeps the selection
   * when none is left.
   */
  drop(card: StripCard, screen: Screen): DisplayStep {
    const slot = this.selectedOn(screen)
    if (!card.pickable()) return DisplayStep.of(this)
    const { place } = card
    const picked = new Display({ ...this, pick: card.id })
    const { display, commands } = picked.select(screen.nextEmptySlot(slot) ?? slot, screen)
    const placed: ScreenCommand = Place.$is("Bench")(place)
      ? { _tag: "Swap", a: place.tile, b: slot }
      : { _tag: "Assign", tile: slot, game: card.id }
    return DisplayStep.of(display, [placed, ...commands])
  }

  toggleSlate(): Display {
    return new Display({ ...this, slateOpen: !this.slateOpen })
  }

  /** Whether this overlay is the one open. */
  shows(overlay: "Keys" | "Palette" | "JoinRemote"): boolean {
    return Overlay.$is(overlay)(this.overlay)
  }

  /** Opens an overlay, closing any other: at most one is open. */
  open(overlay: "Keys" | "Palette" | "JoinRemote"): Display {
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
}> {
  /** `display`, sending `commands`: none unless given. */
  static of(display: Display, commands: ReadonlyArray<ScreenCommand> = []): DisplayStep {
    return new DisplayStep({ display, commands })
  }
}

/** What a person did on a Display: a hotkey, a click, a drop, a command, or an overlay opened or closed. */
export type DisplayInput = Data.TaggedEnum<{
  Pressed: { readonly hotkey: Hotkey }
  Selected: { readonly slot: number }
  VideoPressed: { readonly game: GameId }
  Dropped: { readonly card: StripCard }
  Commanded: { readonly command: ScreenCommand }
  Opened: { readonly overlay: "Keys" | "Palette" | "JoinRemote" }
  Closed: object
  SlateToggled: object
}>
export const DisplayInput = Data.taggedEnum<DisplayInput>()
