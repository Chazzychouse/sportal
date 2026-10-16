import { Hotkey } from "@sportal/api/Hotkey"
import { TileKey } from "@sportal/api/TileKey"
import type { GameId } from "@sportal/domain/Game"
import { Data, Option } from "effect"
import { Layout } from "../layout/Layout.ts"
import { type Screen, type ScreenCommand, Tile } from "../screen/Screen.ts"

/** The one overlay a Display has open, or none. Above the class: `Display.initial` reads it when the class is defined. */
export type Overlay = Data.TaggedEnum<{ None: object; Keys: object; Palette: object; JoinRemote: object }>
export const Overlay = Data.taggedEnum<Overlay>()

/**
 * A Display's local state: what is selected, interacting, and open. Never sent to the Hub. Each input answers with the
 * next Display and the screen commands for the caller to send.
 */
export class Display extends Data.Class<{
  /** The slot as last chosen; read it through `selectedOn`. */
  readonly selected: number
  /** Read it through `interactingOn`. */
  readonly interacting: TileKey | undefined
  readonly overlay: Overlay
}> {
  /** Slot 0, nothing interacting, and no overlay. */
  static readonly initial = new Display({ selected: 0, interacting: undefined, overlay: Overlay.None() })

  /** The selected slot on this Screen: the last slot when the layout now has fewer. */
  selectedOn(screen: Screen): number {
    return Math.min(this.selected, screen.onScreen().length - 1)
  }

  /**
   * The interacting tile's key, while the selected slot still holds its stream; otherwise none. It returns when that
   * tile is back in the selected slot.
   */
  interactingOn(screen: Screen): TileKey | undefined {
    const tile = screen.onScreen()[this.selectedOn(screen)]
    return Tile.guards.StreamTile(tile) && Tile.key(tile) === this.interacting ? this.interacting : undefined
  }

  /** What an input does on this Screen. */
  apply(input: DisplayInput, screen: Screen): DisplayStep {
    return DisplayInput.$match(input, {
      Pressed: ({ hotkey }) => this.press(hotkey, screen),
      Selected: ({ slot }) => this.select(slot, screen),
      VideoPressed: ({ key }) => {
        const slot = screen.slotOf(key)
        return slot === undefined ? DisplayStep.of(this) : this.select(slot, screen)
      },
      Chosen: ({ game }) => this.choose(game, screen),
      Commanded: ({ command }) => DisplayStep.of(this, [command]),
      Opened: ({ overlay }) => DisplayStep.of(this.open(overlay)),
      Closed: () => DisplayStep.of(this.close())
    })
  }

  /**
   * What a hotkey does. `FullScreen` does nothing here: it is the shell's or browser's.
   */
  press(hotkey: Hotkey, screen: Screen): DisplayStep {
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
        const interacting = this.interactingOn(screen) === undefined ? Tile.key(tile) : undefined
        return DisplayStep.of(new Display({ ...this, interacting }))
      },
      ShowKeys: () => DisplayStep.of(Overlay.$is("Keys")(this.overlay) ? this.close() : this.open("Keys")),
      CommandPalette: () =>
        DisplayStep.of(Overlay.$is("Palette")(this.overlay) ? this.close() : this.open("Palette")),
      FocusAudio: ({ slot }) => DisplayStep.of(this, [{ _tag: "FocusAudio", tile: slot }]),
      Promote: ({ slot }) => DisplayStep.of(this, [{ _tag: "Promote", tile: slot }]),
      NextLayout: () => DisplayStep.of(this, [{ _tag: "SetLayout", layout: Layout.next(screen.layout) }]),
      FullScreen: () => DisplayStep.of(this)
    })
  }

  /** Selects a slot on screen, ending interacting when the slot changes. A slot past the last is ignored. */
  select(slot: number, screen: Screen): DisplayStep {
    if (slot < 0 || slot >= screen.onScreen().length) return DisplayStep.of(this)
    const interacting = slot === this.selectedOn(screen) ? this.interacting : undefined
    return DisplayStep.of(new Display({ ...this, selected: slot, interacting }))
  }

  /**
   * Puts game `game` in the selected slot: a benched game is swapped in, a free one assigned, and one on screen left
   * where it is. Then selects the next empty slot, so the next choice fills it, or keeps the selection when none is
   * left.
   */
  choose(game: GameId, screen: Screen): DisplayStep {
    const key = TileKey.game(game)
    if (screen.slotOf(key) !== undefined) return DisplayStep.of(this)
    const slot = this.selectedOn(screen)
    const bench = screen.benched().find((each) => each.key === key)
    const { display, commands } = this.select(screen.nextEmptySlot(slot) ?? slot, screen)
    const placed: ScreenCommand =
      bench === undefined ? { _tag: "Assign", tile: slot, game } : { _tag: "Swap", a: bench.tile, b: slot }
    return DisplayStep.of(display, [placed, ...commands])
  }

  /** Whether this overlay is the one open. */
  shows(overlay: OpenOverlay): boolean {
    return Overlay.$is(overlay)(this.overlay)
  }

  /** Opens an overlay, closing any other: at most one is open. */
  open(overlay: OpenOverlay): Display {
    return new Display({ ...this, overlay: Overlay[overlay]() })
  }

  close(): Display {
    return new Display({ ...this, overlay: Overlay.None() })
  }
}

/** An overlay that can be open: any but `None`. */
type OpenOverlay = Exclude<Overlay["_tag"], "None">

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

/** What a person did on a Display: a hotkey, a click, a game chosen, a command, or an overlay opened or closed. */
export type DisplayInput = Data.TaggedEnum<{
  Pressed: { readonly hotkey: Hotkey }
  Selected: { readonly slot: number }
  VideoPressed: { readonly key: TileKey }
  Chosen: { readonly game: GameId }
  Commanded: { readonly command: ScreenCommand }
  Opened: { readonly overlay: OpenOverlay }
  Closed: object
}>
export const DisplayInput = Data.taggedEnum<DisplayInput>()
