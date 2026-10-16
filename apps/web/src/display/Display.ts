import { Hotkey } from "@sportal/api/Hotkey"
import { TileKey } from "@sportal/api/TileKey"
import type { GameId } from "@sportal/domain/Game"
import { League, type LeagueId } from "@sportal/domain/League"
import { Data, Equal, Option } from "effect"
import type { CustomStream } from "../custom/CustomStream.ts"
import { CustomStreamsChange } from "../custom/CustomStreams.ts"
import { GuideItem } from "../guide/GuideItem.ts"
import type { GuideShelves } from "../guide/GuideShelves.ts"
import { Layout } from "../layout/Layout.ts"
import { Screen, type ScreenCommand, Tile } from "../screen/Screen.ts"

/**
 * The one overlay a Display has open, or none. `CustomForm` is the YouTube form: renaming `editing`, or adding a stream
 * without one; closing it goes `back`, as closing `GamePage` does. Above the class: `Display.initial` reads it when the
 * class is defined.
 */
export type Overlay = Data.TaggedEnum<{
  None: object
  Keys: object
  Palette: object
  JoinRemote: object
  /** The guide, at its level, on its entry, with its focus. */
  Guide: { readonly level: GuideLevel; readonly entry: GuideEntry; readonly focus: GuideFocus }
  CustomForm: { readonly editing: CustomStream | undefined; readonly back: Overlay }
  /** One game's stats page, and the overlay Escape goes back to: the guide where it was, or none. */
  GamePage: { readonly game: GameId; readonly back: Overlay }
}>
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
  /** The guide entry last shown; the guide opens on it while the guide still lists it. */
  readonly lastEntry: GuideEntry
}> {
  /** Slot 0, nothing interacting, no overlay, and the guide to open on All live. */
  static readonly initial = new Display({
    selected: 0,
    interacting: undefined,
    overlay: Overlay.None(),
    lastEntry: "AllLive"
  })

  /** How the guide names an entry: "All live", the league's name, or "Custom". */
  static entryName(entry: GuideEntry): string {
    if (entry === "AllLive") return "All live"
    return entry === "Custom" ? "Custom" : League.of(entry).name
  }

  /** The selected slot on this Screen: the last slot when the layout now has fewer. */
  selectedOn(screen: Screen): number {
    return Math.min(this.selected, screen.onScreen().length - 1)
  }

  /**
   * The interacting tile, while the selected slot still holds it; otherwise none. It returns when its tile is back in
   * the selected slot.
   */
  interactingOn(screen: Screen): TileKey | undefined {
    const tile = screen.onScreen()[this.selectedOn(screen)]
    return tile !== undefined && Tile.locator(tile) !== undefined && Tile.key(tile) === this.interacting
      ? this.interacting
      : undefined
  }

  /** The guide card the focus is on: none while the guide is closed, or while the focus is on the rail. */
  focusedItem(shelves: GuideShelves): GuideItem | undefined {
    if (!Overlay.$is("Guide")(this.overlay)) return undefined
    const { entry, level } = this.overlay
    const shown = shelves.shelves(entry, level)
    const focus = clamped(this.overlay.focus, shown)
    return focus.rail ? undefined : shown[focus.shelf]?.[focus.item]
  }

  /** The entry the guide opens on with these shelves: the one last shown while the guide lists it, else All live. */
  entryOn(shelves: GuideShelves): GuideEntry {
    return shelves.entries.includes(this.lastEntry) ? this.lastEntry : "AllLive"
  }

  /** What an input does on this Screen, with the guide's shelves as they are now. */
  apply(input: DisplayInput, screen: Screen, shelves: GuideShelves): DisplayStep {
    return DisplayInput.$match(input, {
      Pressed: ({ hotkey }) => this.press(hotkey, screen, shelves),
      Selected: ({ slot }) => this.select(slot, screen),
      VideoPressed: ({ key }) => {
        const slot = screen.slotOf(key)
        return slot === undefined ? DisplayStep.of(this) : this.select(slot, screen)
      },
      Chosen: ({ game }) => this.choose(game, screen),
      StatsBeside: ({ game }) => this.statsBeside(game, screen),
      GamePageOpened: ({ game }) => DisplayStep.of(this.openGamePage(game)),
      ChosenCustom: ({ stream }) => this.chooseCustom(stream, screen),
      CustomEdited: ({ change }) => this.customEdited(change, screen),
      CustomFormOpened: ({ editing }) => DisplayStep.of(this.openCustomForm(editing)),
      Commanded: ({ command }) => DisplayStep.of(this, [command]),
      Opened: ({ overlay }) => DisplayStep.of(this.open(overlay)),
      Closed: () => DisplayStep.of(this.close()),
      GuideOpened: ({ entry }) => DisplayStep.of(this.guide("Full", entry, start, shelves)),
      GuideEntryChosen: ({ entry }) => DisplayStep.of(this.chooseEntry(entry, shelves)),
      GuideItemChosen: ({ shelf, item }) => this.confirm({ rail: false, shelf, item }, screen, shelves)
    })
  }

  /**
   * What a hotkey does. `FullScreen` does nothing here: it is the shell's or browser's. `Remove` does nothing here
   * either: it edits the saved custom streams, which `DisplayState` holds.
   */
  press(hotkey: Hotkey, screen: Screen, shelves: GuideShelves): DisplayStep {
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
      Unsolo: () => this.escape(screen, shelves),
      Interact: () => {
        const tile = screen.onScreen()[this.selectedOn(screen)]
        const key = tile === undefined || Tile.locator(tile) === undefined ? undefined : Tile.key(tile)
        if (key === undefined) return DisplayStep.of(this)
        const interacting = this.interactingOn(screen) === undefined ? key : undefined
        return DisplayStep.of(new Display({ ...this, interacting }))
      },
      ShowKeys: () => DisplayStep.of(Overlay.$is("Keys")(this.overlay) ? this.close() : this.open("Keys")),
      CommandPalette: () =>
        DisplayStep.of(Overlay.$is("Palette")(this.overlay) ? this.close() : this.open("Palette")),
      FocusAudio: ({ slot }) => DisplayStep.of(this, [{ _tag: "FocusAudio", tile: slot }]),
      Promote: ({ slot }) => DisplayStep.of(this, [{ _tag: "Promote", tile: slot }]),
      NextLayout: () => DisplayStep.of(this, [{ _tag: "SetLayout", layout: Layout.next(screen.layout) }]),
      FullScreen: () => DisplayStep.of(this),
      Remove: () => DisplayStep.of(this),
      Guide: () => DisplayStep.of(this.guideUp(shelves)),
      Move: ({ direction }) => DisplayStep.of(this.move(direction, shelves)),
      Confirm: () => this.confirm(undefined, screen, shelves),
      NextEntry: () => DisplayStep.of(this.nextEntry(1, shelves)),
      PreviousEntry: () => DisplayStep.of(this.nextEntry(-1, shelves)),
      Info: () => DisplayStep.of(this.info(shelves))
    })
  }

  /** Selects a slot on screen, ending interacting when the slot changes. A slot past the last is ignored. */
  select(slot: number, screen: Screen): DisplayStep {
    if (slot < 0 || slot >= screen.onScreen().length) return DisplayStep.of(this)
    const interacting = slot === this.selectedOn(screen) ? this.interacting : undefined
    return DisplayStep.of(new Display({ ...this, selected: slot, interacting }))
  }

  /** Puts game `game` in the selected slot, as `place` puts anything. */
  choose(game: GameId, screen: Screen): DisplayStep {
    return this.place(TileKey.game(game), (tile) => ({ _tag: "Assign", tile, game }), screen)
  }

  /**
   * Puts game `game`'s stats beside it: in the next empty slot after its stream (or after the selected slot when it
   * is not on screen), else the slot after it; a one-slot layout becomes a Pair first. Stats already on screen stay.
   */
  statsBeside(game: GameId, screen: Screen): DisplayStep {
    if (screen.slotOf(TileKey.stats(game)) !== undefined) return DisplayStep.of(this)
    if (Screen.slotCount(screen.layout) === 1) {
      return DisplayStep.of(this, [
        { _tag: "SetLayout", layout: "Pair" },
        { _tag: "AssignStats", tile: 1, game }
      ])
    }
    const from = screen.slotOf(TileKey.game(game)) ?? this.selectedOn(screen)
    const slot = screen.nextEmptySlot(from) ?? (from + 1) % screen.onScreen().length
    return DisplayStep.of(this, [{ _tag: "AssignStats", tile: slot, game }])
  }

  /** Puts a saved custom stream in the selected slot, as `place` puts anything, and closes what is open. */
  chooseCustom(stream: CustomStream, screen: Screen): DisplayStep {
    const { display, commands } = this.place(
      TileKey.custom(stream.id),
      (tile) => ({
        _tag: "AssignCustom",
        tile,
        stream: stream.id,
        name: stream.name,
        locator: stream.locator()
      }),
      screen
    )
    return DisplayStep.of(new Display({ ...display, overlay: Overlay.None() }), commands)
  }

  /**
   * Puts what `key` names in the selected slot: benched, it is swapped in; on no tile, `assign` puts it there; on
   * screen, it stays where it is. Then selects the next empty slot, so the next choice fills it, or keeps the selection
   * when none is left.
   */
  place(key: TileKey, assign: (tile: number) => ScreenCommand, screen: Screen): DisplayStep {
    if (screen.slotOf(key) !== undefined) return DisplayStep.of(this)
    const slot = this.selectedOn(screen)
    const bench = screen.benched().find((each) => each.key === key)
    const { display, commands } = this.select(screen.nextEmptySlot(slot) ?? slot, screen)
    const placed: ScreenCommand =
      bench === undefined ? assign(slot) : { _tag: "Swap", a: bench.tile, b: slot }
    return DisplayStep.of(display, [placed, ...commands])
  }

  /**
   * What a change to the saved custom streams does on this Screen: a removed stream's tiles are cleared, a renamed one's
   * take its new name, and an added one changes nothing.
   */
  customEdited(change: CustomStreamsChange, screen: Screen): DisplayStep {
    const commands = CustomStreamsChange.$match(change, {
      Added: (): ReadonlyArray<ScreenCommand> => [],
      Renamed: ({ id, name }) =>
        screen.customTiles(id).map(
          ({ index, tile }): ScreenCommand => ({
            _tag: "AssignCustom",
            tile: index,
            stream: id,
            name,
            locator: tile.locator
          })
        ),
      Removed: ({ id }) =>
        screen.customTiles(id).map(({ index }): ScreenCommand => ({ _tag: "Clear", tile: index }))
    })
    return DisplayStep.of(this, commands)
  }

  /**
   * Opens the YouTube form: to rename `editing`, or, without it, to add a stream. Closing it goes back to the guide it
   * was opened from, at the same focus, or to nothing.
   */
  openCustomForm(editing: CustomStream | undefined): Display {
    const back = Overlay.$is("Guide")(this.overlay) ? this.overlay : Overlay.None()
    return new Display({ ...this, overlay: Overlay.CustomForm({ editing, back }) })
  }

  /** Opens game `game`'s page; closing it goes back to the guide it was opened from, at the same focus, or to nothing. */
  openGamePage(game: GameId): Display {
    const back = Overlay.$is("Guide")(this.overlay) ? this.overlay : Overlay.None()
    return new Display({ ...this, overlay: Overlay.GamePage({ game, back }) })
  }

  /** Whether this overlay is the one open. */
  shows(overlay: Exclude<Overlay["_tag"], "None">): boolean {
    return Overlay.$is(overlay)(this.overlay)
  }

  /** Opens an overlay, closing any other: at most one is open. */
  open(overlay: OpenOverlay): Display {
    return new Display({ ...this, overlay: Overlay[overlay]() })
  }

  /**
   * Closes what is open: the YouTube form and a game page go back to where they were opened from, anything else to
   * nothing.
   */
  close(): Display {
    const overlay =
      Overlay.$is("CustomForm")(this.overlay) || Overlay.$is("GamePage")(this.overlay)
        ? this.overlay.back
        : Overlay.None()
    return new Display({ ...this, overlay })
  }

  /**
   * `G`: closed, the ribbon opens on the entry last shown (All live once the guide no longer lists it); the ribbon
   * opens the full guide, which stays open.
   */
  private guideUp(shelves: GuideShelves): Display {
    const overlay = this.overlay
    if (Overlay.$is("Guide")(overlay)) return this.relevel(overlay, "Full", shelves)
    return this.guide("Ribbon", this.entryOn(shelves), start, shelves)
  }

  /**
   * Esc: the full guide goes back to the ribbon; the ribbon or any other overlay closes (a game page back to where it
   * opened); with none open, it unsolos.
   */
  private escape(screen: Screen, shelves: GuideShelves): DisplayStep {
    const overlay = this.overlay
    if (Overlay.$is("Guide")(overlay) && overlay.level === "Full")
      return DisplayStep.of(this.relevel(overlay, "Ribbon", shelves))
    if (!Overlay.$is("None")(overlay)) return DisplayStep.of(this.close())
    return DisplayStep.of(this, Option.isNone(screen.solo) ? [] : [{ _tag: "Unsolo" }])
  }

  /** `I`: on a game card in the open guide, that game's page; anywhere else, nothing. */
  private info(shelves: GuideShelves): Display {
    const item = this.focusedItem(shelves)
    return item !== undefined && GuideItem.$is("Game")(item) ? this.openGamePage(item.game) : this
  }

  /**
   * An arrow in the open guide. In the ribbon, left and right move along its row and up opens the full guide. In the
   * full guide, up and down move to the next shelf with items and left and right along a shelf; left from a shelf's
   * first item goes to the rail, where up and down change the entry and right comes back. With the guide closed,
   * nothing.
   */
  private move(direction: "up" | "down" | "left" | "right", shelves: GuideShelves): Display {
    const overlay = this.overlay
    if (!Overlay.$is("Guide")(overlay)) return this
    const { level, entry } = overlay
    const shown = shelves.shelves(entry, level)
    const focus = clamped(overlay.focus, shown)
    const along = direction === "left" ? -1 : 1

    if (level === "Ribbon") {
      if (direction === "up") return this.relevel(overlay, "Full", shelves)
      return direction === "down"
        ? this
        : this.guide(level, entry, { ...focus, item: focus.item + along }, shelves)
    }
    if (focus.rail) {
      if (direction === "right") return this.guide(level, entry, { ...focus, rail: false }, shelves)
      return direction === "left" ? this : this.nextEntry(direction === "up" ? -1 : 1, shelves)
    }
    if (direction === "left" && focus.item === 0)
      return this.guide(level, entry, { ...focus, rail: true }, shelves)
    if (direction === "left" || direction === "right")
      return this.guide(level, entry, { ...focus, item: focus.item + along }, shelves)
    const shelf = nextFilled(shown, focus.shelf, direction === "up" ? -1 : 1)
    return shelf === undefined ? this : this.guide(level, entry, { ...focus, shelf }, shelves)
  }

  /**
   * `]` or `[` (`step` 1 or -1), or up and down on the rail: the open guide on the entry `step` from its own in the
   * guide's entries, at the same level and on or off the rail as it was, focused on the entry's first item. Past
   * either end it stays; with the guide closed, nothing.
   */
  private nextEntry(step: 1 | -1, shelves: GuideShelves): Display {
    const overlay = this.overlay
    if (!Overlay.$is("Guide")(overlay)) return this
    const entries = shelves.entries
    const index = Math.min(Math.max(entries.indexOf(overlay.entry) + step, 0), entries.length - 1)
    const entry = entries[index] ?? overlay.entry
    if (entry === overlay.entry) return this
    return this.guide(overlay.level, entry, { ...start, rail: overlay.focus.rail }, shelves)
  }

  /** A click on an entry: the guide on it at the level open, or the full guide when none is, on its first item. */
  private chooseEntry(entry: GuideEntry, shelves: GuideShelves): Display {
    const overlay = this.overlay
    const level = Overlay.$is("Guide")(overlay) ? overlay.level : "Full"
    return this.guide(level, entry, start, shelves)
  }

  /**
   * Enter, or a click on the item at `at`: on the rail it leaves the rail; on a game it watches the game as `choose`
   * does and closes the guide; on a custom stream it watches it as `chooseCustom` does; on the add card it opens the
   * YouTube form. With the guide closed, or nothing there, nothing.
   */
  private confirm(at: GuideFocus | undefined, screen: Screen, shelves: GuideShelves): DisplayStep {
    const overlay = this.overlay
    if (!Overlay.$is("Guide")(overlay)) return DisplayStep.of(this)
    const shown = shelves.shelves(overlay.entry, overlay.level)
    const focus = clamped(at ?? overlay.focus, shown)
    if (focus.rail)
      return DisplayStep.of(this.guide(overlay.level, overlay.entry, { ...focus, rail: false }, shelves))
    const item = shown[focus.shelf]?.[focus.item]
    if (item === undefined) return DisplayStep.of(this)
    return GuideItem.$match(item, {
      Game: ({ game }) => this.close().choose(game, screen),
      Custom: ({ stream }) => this.chooseCustom(stream, screen),
      AddCustom: () => DisplayStep.of(this.openCustomForm(undefined))
    })
  }

  /**
   * The guide at `level` on `entry`, focused on `focus` as far as the entry's shelves allow (never the rail in the
   * ribbon); `entry` is the one the guide opens on next.
   */
  private guide(level: GuideLevel, entry: GuideEntry, focus: GuideFocus, shelves: GuideShelves): Display {
    const asked = level === "Ribbon" ? { ...focus, rail: false } : focus
    const at = clamped(asked, shelves.shelves(entry, level))
    return new Display({ ...this, lastEntry: entry, overlay: Overlay.Guide({ level, entry, focus: at }) })
  }

  /** The open guide at `level` instead, on the item it had focused when that level shows it, else on its first. */
  private relevel(open: GuideOpen, level: GuideLevel, shelves: GuideShelves): Display {
    const shown = shelves.shelves(open.entry, open.level)
    const focus = clamped(open.focus, shown)
    const item = focus.rail ? undefined : shown[focus.shelf]?.[focus.item]
    const found = item === undefined ? undefined : focusOf(item, shelves.shelves(open.entry, level))
    return this.guide(level, open.entry, found ?? start, shelves)
  }
}

/**
 * An overlay that opens with no more to say: any but `None`, the guide, which opens at a level on an entry, the
 * YouTube form, which `CustomFormOpened` opens, and a game page, which `GamePageOpened` opens.
 */
type OpenOverlay = Exclude<Overlay["_tag"], "None" | "Guide" | "CustomForm" | "GamePage">

/** Which level of the guide is open: the ribbon docked under the Screen, or the full guide over the whole Display. */
export type GuideLevel = "Ribbon" | "Full"

/** An entry of the guide's rail: every league's live games, one league, or the custom streams. */
export type GuideEntry = "AllLive" | LeagueId | "Custom"

/** Where the open guide's focus is: on the rail, or on item `item` of shelf `shelf` (the ribbon's row is shelf 0). */
export interface GuideFocus {
  readonly rail: boolean
  readonly shelf: number
  readonly item: number
}

/** The guide as the open overlay. */
type GuideOpen = Data.TaggedEnum.Value<Overlay, "Guide">

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

/**
 * What a person did on a Display: a hotkey, a click, a game or a custom stream chosen for the selected tile, a game's
 * stats put beside it, a change to the saved custom streams, the YouTube form or a game page opened, a command, an
 * overlay opened or closed, or the guide clicked.
 */
export type DisplayInput = Data.TaggedEnum<{
  Pressed: { readonly hotkey: Hotkey }
  Selected: { readonly slot: number }
  VideoPressed: { readonly key: TileKey }
  Chosen: { readonly game: GameId }
  StatsBeside: { readonly game: GameId }
  GamePageOpened: { readonly game: GameId }
  ChosenCustom: { readonly stream: CustomStream }
  CustomEdited: { readonly change: CustomStreamsChange }
  CustomFormOpened: { readonly editing: CustomStream | undefined }
  Commanded: { readonly command: ScreenCommand }
  Opened: { readonly overlay: OpenOverlay }
  Closed: object
  /** The full guide opened on `entry`, by a click. */
  GuideOpened: { readonly entry: GuideEntry }
  /** An entry clicked in the guide's rail or the ribbon's tabs. */
  GuideEntryChosen: { readonly entry: GuideEntry }
  /** An item clicked on a shelf of the open guide. */
  GuideItemChosen: { readonly shelf: number; readonly item: number }
}>
export const DisplayInput = Data.taggedEnum<DisplayInput>()

/** Off the rail, on the first item of the first shelf. */
const start: GuideFocus = { rail: false, shelf: 0, item: 0 }

/**
 * `focus` on what `shelves` hold: a shelf past the last is the last, an empty shelf gives way to the nearest one with
 * items (the later one on a tie), and the item stays within its shelf.
 */
function clamped(focus: GuideFocus, shelves: ReadonlyArray<ReadonlyArray<GuideItem>>): GuideFocus {
  const asked = Math.max(0, Math.min(focus.shelf, shelves.length - 1))
  const shelf = nearestFilled(shelves, asked) ?? asked
  const length = shelves[shelf]?.length ?? 0
  return { rail: focus.rail, shelf, item: Math.max(0, Math.min(focus.item, length - 1)) }
}

/** The shelf with items nearest `from`: `from` itself first, then outward, the later one on a tie. */
function nearestFilled(shelves: ReadonlyArray<ReadonlyArray<GuideItem>>, from: number): number | undefined {
  for (let distance = 0; distance < shelves.length; distance++)
    for (const shelf of [from + distance, from - distance])
      if ((shelves[shelf]?.length ?? 0) > 0) return shelf
  return undefined
}

/** Where `item` is on `shelves`, if it is there. */
function focusOf(item: GuideItem, shelves: ReadonlyArray<ReadonlyArray<GuideItem>>): GuideFocus | undefined {
  for (const [shelf, items] of shelves.entries()) {
    const at = items.findIndex((each) => Equal.equals(each, item))
    if (at >= 0) return { rail: false, shelf, item: at }
  }
  return undefined
}

/** The next shelf with items after `from`, going `step` (1 down, -1 up); none past either end. */
function nextFilled(
  shelves: ReadonlyArray<ReadonlyArray<GuideItem>>,
  from: number,
  step: 1 | -1
): number | undefined {
  for (let shelf = from + step; shelf >= 0 && shelf < shelves.length; shelf += step)
    if ((shelves[shelf]?.length ?? 0) > 0) return shelf
  return undefined
}
