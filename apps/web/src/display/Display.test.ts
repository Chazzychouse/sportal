import { assert, describe, it } from "@effect/vitest"
import type { Hotkey } from "@sportal/api/Hotkey"
import { TileKey } from "@sportal/api/TileKey"
import { GameId } from "@sportal/domain/Game"
import { Option, Result } from "effect"
import { CustomStreamsChange } from "../custom/CustomStreams.ts"
import { GuideItem } from "../guide/GuideItem.ts"
import type { GuideShelves } from "../guide/GuideShelves.ts"
import { Screen, type ScreenCommand } from "../screen/Screen.ts"
import * as TestWeb from "../TestWeb.ts"
import {
  Display,
  DisplayInput,
  DisplayStep,
  type GuideEntry,
  type GuideFocus,
  type GuideLevel,
  Overlay
} from "./Display.ts"

describe("Display.initial", () => {
  it("should start on slot 0, with nothing interacting and no overlay", () => {
    const display = Display.initial

    assert.strictEqual(display.selected, 0)
    assert.isUndefined(display.interacting)
    assert.strictEqual(display.overlay._tag, "None")
  })

  it("should open the guide on All live first", () => {
    const display = Display.initial

    assert.strictEqual(display.lastEntry, "AllLive")
  })
})

describe("Display#select", () => {
  it("should answer with a DisplayStep", () => {
    const step = Display.initial.select(1, TestWeb.withTiles([]))

    assert.instanceOf(step, DisplayStep)
  })

  it("should select a slot on screen and send nothing", () => {
    const { display, commands } = Display.initial.select(2, TestWeb.withTiles([]))

    assert.strictEqual(display.selected, 2)
    assert.deepStrictEqual(commands, [])
  })

  it("should keep interacting when the same slot is selected", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const interacting = Display.initial.press({ _tag: "Interact" }, screen, none).display

    const reselected = interacting.select(0, screen).display

    assert.strictEqual(reselected.interactingOn(screen), "live")
  })

  it("should end interacting when another slot is selected", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const interacting = Display.initial.press({ _tag: "Interact" }, screen, none).display

    const moved = interacting.select(1, screen).display

    assert.isUndefined(moved.interacting)
  })

  it("should not interact again when the slot it ended on is selected back", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const interacting = Display.initial.press({ _tag: "Interact" }, screen, none).display
    const moved = interacting.select(1, screen).display

    const back = moved.select(0, screen).display

    assert.isUndefined(back.interactingOn(screen))
  })

  it("should ignore a slot past the last", () => {
    const screen = TestWeb.withTiles([])

    const { display, commands } = Display.initial.select(4, screen)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [])
  })
})

describe("Display#selectedOn and Display#interactingOn", () => {
  it("should read the last slot once the layout has fewer", () => {
    const quad = TestWeb.withTiles([])
    const selected = Display.initial.select(3, quad).display
    const single = new Screen({ ...quad, layout: "Single" })

    const slot = selected.selectedOn(single)

    assert.strictEqual(slot, 0)
  })

  it("should choose into the last slot once the layout has fewer", () => {
    const quad = TestWeb.withTiles([])
    const selected = Display.initial.select(3, quad).display
    const single = new Screen({ ...quad, layout: "Single" })

    const { commands } = selected.choose(live, single)

    assert.deepStrictEqual(commands, [{ _tag: "Assign", tile: 0, game: GameId.make("live") }])
  })

  it("should keep interacting when the slot selected is the one the clamped selection already reads", () => {
    const quad = TestWeb.withTiles(["live"])
    const selected = Display.initial.select(3, quad).display
    const single = new Screen({ ...quad, layout: "Single" })
    const interacting = selected.press({ _tag: "Interact" }, single, none).display

    const reselected = interacting.select(0, single).display

    assert.strictEqual(reselected.interactingOn(single), "live")
  })

  it("should read the game interacting on the screen it began on", () => {
    const before = TestWeb.withTiles(["live", "soon"])
    const display = Display.initial.press({ _tag: "Interact" }, before, none).display

    const interacting = display.interactingOn(before)

    assert.strictEqual(interacting, "live")
  })

  it("should read interacting as none once a swap moves another game into the selected slot", () => {
    const before = TestWeb.withTiles(["live", "soon"])
    const display = Display.initial.press({ _tag: "Interact" }, before, none).display

    const interacting = display.interactingOn(TestWeb.withTiles(["soon", "live"]))

    assert.isUndefined(interacting)
  })

  it("should read interacting again once its game is swapped back into the selected slot", () => {
    const before = TestWeb.withTiles(["live", "soon"])
    const display = Display.initial.press({ _tag: "Interact" }, before, none).display
    display.interactingOn(TestWeb.withTiles(["soon", "live"]))

    const swappedBack = display.interactingOn(TestWeb.withTiles(["live", "soon"]))

    assert.strictEqual(swappedBack, "live")
  })
})

describe("Display#choose", () => {
  it("should assign a free game into the selected slot and select the next empty slot", () => {
    const screen = TestWeb.withTiles(["soon"])

    const chosen = Display.initial.choose(live, screen)

    assert.deepStrictEqual(chosen.commands, [{ _tag: "Assign", tile: 0, game: GameId.make("live") }])
    assert.strictEqual(chosen.display.selected, 1)
  })

  it("should swap a benched game into the selected slot and select the next empty slot", () => {
    const screen = TestWeb.withTiles(["soon", undefined, undefined, undefined, "done"])
    const selected = Display.initial.select(2, screen).display

    const chosen = selected.choose(GameId.make("done"), screen)

    assert.deepStrictEqual(chosen.commands, [{ _tag: "Swap", a: 4, b: 2 }])
    assert.strictEqual(chosen.display.selected, 3)
  })

  it("should do nothing with a game already on screen", () => {
    const screen = TestWeb.withTiles(["soon", undefined, undefined, undefined, "done"])

    const chosen = Display.initial.choose(GameId.make("soon"), screen)

    assert.strictEqual(chosen.display, Display.initial)
    assert.deepStrictEqual(chosen.commands, [])
  })

  it("should select the next empty slot after the choice", () => {
    const screen = TestWeb.withTiles(["soon", undefined, undefined, undefined])
    const selected = Display.initial.select(1, screen).display

    const chosen = selected.choose(live, screen)

    assert.strictEqual(chosen.display.selected, 2)
  })

  it("should keep the selection when no empty slot is left", () => {
    const full = TestWeb.withTiles(["soon", "later", undefined, "done"])
    const selected = Display.initial.select(2, full).display

    const chosen = selected.choose(live, full)

    assert.strictEqual(chosen.display.selected, 2)
  })

  it("should end interacting when the choice moves the selection", () => {
    const screen = TestWeb.withTiles(["soon"])
    const interacting = Display.initial.press({ _tag: "Interact" }, screen, none).display

    const chosen = interacting.choose(live, screen)

    assert.isUndefined(chosen.display.interacting)
  })
})

describe("Display#press", () => {
  it("should answer with a DisplayStep", () => {
    const step = Display.initial.press({ _tag: "ShowKeys" }, TestWeb.withTiles([]), none)

    assert.instanceOf(step, DisplayStep)
  })

  it("should select with SelectTile as select does", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const interacting = Display.initial.press({ _tag: "Interact" }, screen, none).display

    const { display, commands } = interacting.press({ _tag: "SelectTile", slot: 1 }, screen, none)

    assert.strictEqual(display.selected, 1)
    assert.isUndefined(display.interacting)
    assert.deepStrictEqual(commands, [])
  })

  it("should ignore SelectTile past the last slot, as select does", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const interacting = Display.initial.press({ _tag: "Interact" }, screen, none).display

    const { display } = interacting.press({ _tag: "SelectTile", slot: 8 }, screen, none)

    assert.strictEqual(display, interacting)
  })

  it("should solo the selected slot with ToggleSolo", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const selected = Display.initial.select(1, screen).display

    const solo = selected.press({ _tag: "ToggleSolo" }, screen, none)

    assert.strictEqual(solo.display, selected)
    assert.deepStrictEqual(solo.commands, [{ _tag: "Solo", tile: 1 }])
  })

  it("should unsolo with ToggleSolo while soloed", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const selected = Display.initial.select(1, screen).display
    const soloed = new Screen({ ...screen, solo: Option.some(TileKey.game(GameId.make("soon"))) })

    const { commands } = selected.press({ _tag: "ToggleSolo" }, soloed, none)

    assert.deepStrictEqual(commands, [{ _tag: "Unsolo" }])
  })

  it("should send nothing with ToggleSolo on an Empty tile when not soloed", () => {
    const screen = TestWeb.withTiles(["live"])
    const selected = Display.initial.select(1, screen).display

    const { display, commands } = selected.press({ _tag: "ToggleSolo" }, screen, none)

    assert.strictEqual(display, selected)
    assert.deepStrictEqual(commands, [])
  })

  it("should unsolo with ToggleSolo on an Empty tile while soloed", () => {
    const soloed = new Screen({
      ...TestWeb.withTiles(["live"]),
      solo: Option.some(TileKey.game(GameId.make("live")))
    })
    const selected = Display.initial.select(1, soloed).display

    const { commands } = selected.press({ _tag: "ToggleSolo" }, soloed, none)

    assert.deepStrictEqual(commands, [{ _tag: "Unsolo" }])
  })

  it("should solo the last slot with ToggleSolo once the layout has fewer", () => {
    const quad = TestWeb.withTiles(["live"])
    const selected = Display.initial.select(3, quad).display
    const single = new Screen({ ...quad, layout: "Single" })

    const { commands } = selected.press({ _tag: "ToggleSolo" }, single, none)

    assert.deepStrictEqual(commands, [{ _tag: "Solo", tile: 0 }])
  })

  it("should close the key help with Esc and send no Unsolo, even while soloed", () => {
    const soloed = new Screen({
      ...TestWeb.withTiles(["live"]),
      solo: Option.some(TileKey.game(GameId.make("live")))
    })
    const keys = Display.initial.open("Keys")

    const { display, commands } = keys.press({ _tag: "Unsolo" }, soloed, none)

    assert.strictEqual(display.overlay._tag, "None")
    assert.deepStrictEqual(commands, [])
  })

  it.each(["Palette", "JoinRemote"] as const)(
    "should close the %s overlay with Esc and send nothing",
    (overlay) => {
      const open = Display.initial.open(overlay)

      const { display, commands } = open.press({ _tag: "Unsolo" }, TestWeb.withTiles([]), none)

      assert.strictEqual(display.overlay._tag, "None")
      assert.deepStrictEqual(commands, [])
    }
  )

  it("should unsolo with Esc and no overlay while soloed", () => {
    const soloed = new Screen({
      ...TestWeb.withTiles(["live"]),
      solo: Option.some(TileKey.game(GameId.make("live")))
    })

    const { display, commands } = Display.initial.press({ _tag: "Unsolo" }, soloed, none)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [{ _tag: "Unsolo" }])
  })

  it("should do nothing with Esc and no overlay while not soloed", () => {
    const screen = TestWeb.withTiles(["live"])

    const { display, commands } = Display.initial.press({ _tag: "Unsolo" }, screen, none)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [])
  })

  it("should interact with the selected slot's stream with Interact", () => {
    const screen = TestWeb.withTiles(["live"])

    const { display, commands } = Display.initial.press({ _tag: "Interact" }, screen, none)

    assert.strictEqual(display.interactingOn(screen), "live")
    assert.deepStrictEqual(commands, [])
  })

  it("should end interacting with Interact when it was on", () => {
    const screen = TestWeb.withTiles(["live"])
    const on = Display.initial.press({ _tag: "Interact" }, screen, none).display

    const { display } = on.press({ _tag: "Interact" }, screen, none)

    assert.isUndefined(display.interactingOn(screen))
  })

  it("should interact with the game now there with Interact on a slot a swap has refilled", () => {
    const before = TestWeb.withTiles(["live", "soon"])
    const stale = Display.initial.press({ _tag: "Interact" }, before, none).display
    const swapped = TestWeb.withTiles(["soon", "live"])

    const { display } = stale.press({ _tag: "Interact" }, swapped, none)

    assert.strictEqual(display.interactingOn(swapped), "soon")
  })

  it.each([
    { tile: "an empty tile", screen: TestWeb.withTiles([]) },
    {
      tile: "a data tile",
      screen: new Screen({
        ...Screen.initial,
        tiles: [{ _tag: "DataTile", game: GameId.make("live"), why: { _tag: "NoStream" } }]
      })
    }
  ])("should do nothing with Interact on a tile with no stream: $tile", ({ screen }) => {
    const { display } = Display.initial.press({ _tag: "Interact" }, screen, none)

    assert.strictEqual(display, Display.initial)
  })

  it("should open the key help with ShowKeys", () => {
    const { display, commands } = Display.initial.press({ _tag: "ShowKeys" }, TestWeb.withTiles([]), none)

    assert.strictEqual(display.overlay._tag, "Keys")
    assert.deepStrictEqual(commands, [])
  })

  it("should close the key help with ShowKeys when it was open", () => {
    const screen = TestWeb.withTiles([])
    const open = Display.initial.press({ _tag: "ShowKeys" }, screen, none).display

    const { display } = open.press({ _tag: "ShowKeys" }, screen, none)

    assert.strictEqual(display.overlay._tag, "None")
  })

  it("should replace the palette with the key help with ShowKeys", () => {
    const palette = Display.initial.open("Palette")

    const { display, commands } = palette.press({ _tag: "ShowKeys" }, TestWeb.withTiles([]), none)

    assert.strictEqual(display.overlay._tag, "Keys")
    assert.deepStrictEqual(commands, [])
  })

  it("should open the palette with CommandPalette, replacing the key help", () => {
    const keys = Display.initial.open("Keys")

    const { display, commands } = keys.press({ _tag: "CommandPalette" }, TestWeb.withTiles([]), none)

    assert.strictEqual(display.overlay._tag, "Palette")
    assert.deepStrictEqual(commands, [])
  })

  it("should close the palette with CommandPalette when it was open", () => {
    const screen = TestWeb.withTiles([])
    const open = Display.initial.open("Keys").press({ _tag: "CommandPalette" }, screen, none).display

    const { display } = open.press({ _tag: "CommandPalette" }, screen, none)

    assert.strictEqual(display.overlay._tag, "None")
  })

  it.each<{ hotkey: Parameters<Display["press"]>[0]; command: ScreenCommand }>([
    { hotkey: { _tag: "FocusAudio", slot: 1 }, command: { _tag: "FocusAudio", tile: 1 } },
    { hotkey: { _tag: "Promote", slot: 1 }, command: { _tag: "Promote", tile: 1 } },
    { hotkey: { _tag: "NextLayout" }, command: { _tag: "SetLayout", layout: "MainThree" } }
  ])("should send $hotkey._tag's command and change nothing", ({ hotkey, command }) => {
    const screen = TestWeb.withTiles(["live", "soon"])

    const { display, commands } = Display.initial.press(hotkey, screen, none)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [command])
  })

  it("should return the same display with FullScreen and send nothing", () => {
    const { display, commands } = Display.initial.press({ _tag: "FullScreen" }, TestWeb.withTiles([]), none)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [])
  })
})

describe("Display#open and Display#close", () => {
  it("should replace any open overlay: Palette over Keys", () => {
    const open = Display.initial.open("Keys")

    const display = open.open("Palette")

    assert.strictEqual(display.overlay._tag, "Palette")
  })

  it("should close the open overlay", () => {
    const open = Display.initial.open("Palette")

    const display = open.close()

    assert.strictEqual(display.overlay._tag, "None")
  })
})

describe("Display#apply", () => {
  it("should press a hotkey as press does", () => {
    const screen = TestWeb.withTiles(["live"])

    const step = Display.initial.apply(DisplayInput.Pressed({ hotkey: { _tag: "ShowKeys" } }), screen, none)

    assert.deepStrictEqual(step, Display.initial.press({ _tag: "ShowKeys" }, screen, none))
  })

  it("should select a slot as select does", () => {
    const screen = TestWeb.withTiles(["live", "soon"])

    const step = Display.initial.apply(DisplayInput.Selected({ slot: 1 }), screen, none)

    assert.deepStrictEqual(step, Display.initial.select(1, screen))
  })

  it("should select the slot a pressed video's game is in", () => {
    const screen = TestWeb.withTiles(["live", "soon"])

    const { display, commands } = Display.initial.apply(
      DisplayInput.VideoPressed({ key: TileKey.game(GameId.make("soon")) }),
      screen,
      none
    )

    assert.strictEqual(display.selected, 1)
    assert.deepStrictEqual(commands, [])
  })

  it("should do nothing for a pressed video whose game is not on screen", () => {
    const screen = TestWeb.withTiles(["live"])

    const { display } = Display.initial.apply(
      DisplayInput.VideoPressed({ key: TileKey.game(GameId.make("gone")) }),
      screen,
      none
    )

    assert.strictEqual(display, Display.initial)
  })

  it("should choose a game as choose does", () => {
    const screen = TestWeb.withTiles(["soon"])

    const step = Display.initial.apply(DisplayInput.Chosen({ game: live }), screen, none)

    assert.deepStrictEqual(step, Display.initial.choose(live, screen))
  })

  it("should send a command and change nothing", () => {
    const command: ScreenCommand = { _tag: "SetLayout", layout: "Single" }

    const { display, commands } = Display.initial.apply(
      DisplayInput.Commanded({ command }),
      TestWeb.withTiles([]),
      none
    )

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [command])
  })

  it("should open an overlay", () => {
    const { display } = Display.initial.apply(
      DisplayInput.Opened({ overlay: "Keys" }),
      TestWeb.withTiles([]),
      none
    )

    assert.isTrue(display.shows("Keys"))
  })

  it("should close the open overlay", () => {
    const { display } = Display.initial
      .open("Palette")
      .apply(DisplayInput.Closed(), TestWeb.withTiles([]), none)

    assert.strictEqual(display.overlay._tag, "None")
  })
})

describe("Display#press in the guide", () => {
  it("should open the ribbon on All live with Guide when nothing is open", () => {
    const { display, commands } = Display.initial.press({ _tag: "Guide" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "AllLive"))
    assert.deepStrictEqual(commands, [])
  })

  it("should open the ribbon on the entry last shown", () => {
    const closed = after(Display.initial, [{ _tag: "Guide" }, { _tag: "NextEntry" }, { _tag: "Unsolo" }])

    const { display } = closed.press({ _tag: "Guide" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "nfl"))
  })

  it("should open the ribbon on All live when the entry last shown has no games now", () => {
    const closed = after(Display.initial, [{ _tag: "Guide" }, { _tag: "NextEntry" }, { _tag: "Unsolo" }])
    const withoutNfl: GuideShelves = { ...shelves, entries: ["AllLive", "fbs", "mlb", "nba"] }

    const { display } = closed.press({ _tag: "Guide" }, emptyQuad, withoutNfl)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "AllLive"))
  })

  it("should open the full guide with Guide from the ribbon", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }])

    const { display } = ribbon.press({ _tag: "Guide" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "AllLive"))
  })

  it("should keep the full guide open with Guide", () => {
    const full = after(Display.initial, [{ _tag: "Guide" }, { _tag: "Guide" }])

    const { display } = full.press({ _tag: "Guide" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "AllLive"))
  })

  it("should open the full guide with up from the ribbon", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }])

    const { display } = ribbon.press(move("up"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "AllLive"))
  })

  it("should keep the focused game when the ribbon opens the full guide, on its own shelf", () => {
    const ribbon = after(Display.initial, [
      { _tag: "Guide" },
      { _tag: "NextEntry" },
      move("right"),
      move("right")
    ])

    const { display } = ribbon.press({ _tag: "Guide" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "nfl", { shelf: 1, item: 0 }))
  })

  it("should go back to the ribbon with Esc from the full guide, on the game it had focused", () => {
    const full = after(Display.initial, [{ _tag: "Guide" }, { _tag: "NextEntry" }, move("up"), move("down")])

    const { display, commands } = full.press({ _tag: "Unsolo" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "nfl", { item: 2 }))
    assert.deepStrictEqual(commands, [])
  })

  it("should close the ribbon with Esc and send no Unsolo, even while soloed", () => {
    const soloed = new Screen({ ...TestWeb.withTiles(["live"]), solo: Option.some(TileKey.game(live)) })
    const ribbon = after(Display.initial, [{ _tag: "Guide" }])

    const { display, commands } = ribbon.press({ _tag: "Unsolo" }, soloed, shelves)

    assert.strictEqual(display.overlay._tag, "None")
    assert.deepStrictEqual(commands, [])
  })

  it("should move along the ribbon with right", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }])

    const { display } = ribbon.press(move("right"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "AllLive", { item: 1 }))
  })

  it("should stay on the ribbon's first chip with left", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }])

    const { display } = ribbon.press(move("left"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "AllLive"))
  })

  it("should stay on the ribbon's last chip with right", () => {
    const last = after(Display.initial, [{ _tag: "Guide" }, move("right"), move("right")])

    const { display } = last.press(move("right"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "AllLive", { item: 2 }))
  })

  it("should do nothing with down in the ribbon", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }])

    const { display } = ribbon.press(move("down"), emptyQuad, shelves)

    assert.strictEqual(display, ribbon)
  })

  it("should move along a shelf with right in the full guide", () => {
    const full = after(Display.initial, [{ _tag: "Guide" }, { _tag: "NextEntry" }, move("up")])

    const { display } = full.press(move("right"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "nfl", { item: 1 }))
  })

  it("should move with down to the next shelf with items, past an empty one", () => {
    const fbs = Display.initial.apply(DisplayInput.GuideOpened({ entry: "fbs" }), emptyQuad, shelves).display

    const { display } = fbs.press(move("down"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "fbs", { shelf: 2 }))
  })

  it("should keep the item's place, clamped, moving to a shorter shelf", () => {
    const second = after(Display.initial, [
      { _tag: "Guide" },
      { _tag: "NextEntry" },
      move("up"),
      move("right")
    ])

    const { display } = second.press(move("down"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "nfl", { shelf: 1, item: 0 }))
  })

  it("should stay on the last shelf with items with down", () => {
    const fbs = Display.initial.apply(DisplayInput.GuideOpened({ entry: "fbs" }), emptyQuad, shelves).display
    const last = after(fbs, [move("down")])

    const { display } = last.press(move("down"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "fbs", { shelf: 2 }))
  })

  it("should move to the rail with left on a shelf's first item", () => {
    const full = after(Display.initial, [{ _tag: "Guide" }, { _tag: "Guide" }])

    const { display } = full.press(move("left"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "AllLive", { rail: true }))
  })

  it("should change the entry with down on the rail, focused on its first item", () => {
    const rail = after(Display.initial, [
      { _tag: "Guide" },
      { _tag: "Guide" },
      move("right"),
      move("left"),
      move("left")
    ])

    const { display } = rail.press(move("down"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "nfl", { rail: true }))
  })

  it("should come back from the rail with right", () => {
    const rail = after(Display.initial, [{ _tag: "Guide" }, { _tag: "Guide" }, move("left")])

    const { display } = rail.press(move("right"), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "AllLive"))
  })

  it("should change the entry with NextEntry, focused on its first item", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }, move("right")])

    const { display } = ribbon.press({ _tag: "NextEntry" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "nfl"))
  })

  it("should change the entry with PreviousEntry in the full guide", () => {
    const nfl = Display.initial.apply(DisplayInput.GuideOpened({ entry: "nfl" }), emptyQuad, shelves).display

    const { display } = nfl.press({ _tag: "PreviousEntry" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "AllLive"))
  })

  it("should stay on the last entry with NextEntry", () => {
    const nba = Display.initial.apply(DisplayInput.GuideOpened({ entry: "nba" }), emptyQuad, shelves).display

    const { display } = nba.press({ _tag: "NextEntry" }, emptyQuad, shelves)

    assert.strictEqual(display, nba)
  })

  it("should focus a new entry's first shelf with items", () => {
    const fbs = Display.initial.apply(DisplayInput.GuideOpened({ entry: "fbs" }), emptyQuad, shelves).display

    const { display } = fbs.press({ _tag: "NextEntry" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "mlb", { shelf: 1 }))
  })

  it("should watch the focused game with Confirm and close the guide", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }, move("right")])

    const { display, commands } = ribbon.press({ _tag: "Confirm" }, emptyQuad, shelves)

    assert.strictEqual(display.overlay._tag, "None")
    assert.deepStrictEqual(commands, [{ _tag: "Assign", tile: 0, game: GameId.make("dal") }])
  })

  it("should watch the last game with Confirm once the focus is past what its shelf now holds", () => {
    const third = after(Display.initial, [
      { _tag: "Guide" },
      { _tag: "NextEntry" },
      move("right"),
      move("right")
    ])
    const fewer: GuideShelves = { entries: shelves.entries, shelves: () => [[item("kc")]] }

    const { commands } = third.press({ _tag: "Confirm" }, emptyQuad, fewer)

    assert.deepStrictEqual(commands, [{ _tag: "Assign", tile: 0, game: GameId.make("kc") }])
  })

  it("should leave the rail with Confirm on it", () => {
    const rail = after(Display.initial, [{ _tag: "Guide" }, { _tag: "Guide" }, move("left")])

    const { display, commands } = rail.press({ _tag: "Confirm" }, emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "AllLive"))
    assert.deepStrictEqual(commands, [])
  })

  it("should do nothing with Confirm on an entry with no games", () => {
    const nba = Display.initial.apply(DisplayInput.GuideOpened({ entry: "nba" }), emptyQuad, shelves).display

    const { display, commands } = nba.press({ _tag: "Confirm" }, emptyQuad, shelves)

    assert.strictEqual(display, nba)
    assert.deepStrictEqual(commands, [])
  })

  it.each<Hotkey>([
    move("down"),
    { _tag: "Confirm" },
    { _tag: "NextEntry" },
    { _tag: "PreviousEntry" },
    { _tag: "Info" }
  ])("should do nothing with $_tag while the guide is closed", (hotkey) => {
    const { display, commands } = Display.initial.press(hotkey, emptyQuad, shelves)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [])
  })
})

describe("Display#apply in the guide", () => {
  it("should open the full guide on an entry", () => {
    const { display } = Display.initial.apply(DisplayInput.GuideOpened({ entry: "mlb" }), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Full", "mlb", { shelf: 1 }))
  })

  it("should change the entry at the ribbon's own level when one is clicked", () => {
    const ribbon = after(Display.initial, [{ _tag: "Guide" }])

    const { display } = ribbon.apply(DisplayInput.GuideEntryChosen({ entry: "fbs" }), emptyQuad, shelves)

    assert.deepStrictEqual(display.overlay, guide("Ribbon", "fbs"))
  })

  it("should open the full guide on an entry clicked while the guide is closed", () => {
    const { display } = Display.initial.apply(
      DisplayInput.GuideEntryChosen({ entry: "fbs" }),
      emptyQuad,
      shelves
    )

    assert.deepStrictEqual(display.overlay, guide("Full", "fbs"))
  })

  it("should watch a clicked game and close the guide", () => {
    const nfl = Display.initial.apply(DisplayInput.GuideOpened({ entry: "nfl" }), emptyQuad, shelves).display

    const { display, commands } = nfl.apply(
      DisplayInput.GuideItemChosen({ shelf: 2, item: 0 }),
      emptyQuad,
      shelves
    )

    assert.strictEqual(display.overlay._tag, "None")
    assert.deepStrictEqual(commands, [{ _tag: "Assign", tile: 0, game: GameId.make("nyj") }])
  })
})

describe("Display#chooseCustom", () => {
  it("should assign a custom stream to the selected slot and select the next empty one", () => {
    const screen = TestWeb.fill([TestWeb.bama])
    const display = Display.initial.select(1, screen).display

    const { display: next, commands } = display.chooseCustom(TestWeb.video, screen)

    assert.deepStrictEqual(commands, [
      {
        _tag: "AssignCustom",
        tile: 1,
        stream: TestWeb.video.id,
        name: "Highlights",
        locator: TestWeb.video.locator()
      }
    ])
    assert.strictEqual(next.selected, 2)
  })

  it("should leave a custom stream on screen where it is", () => {
    const screen = TestWeb.assignCustom(Screen.initial, 2, TestWeb.video)

    const { commands } = Display.initial.chooseCustom(TestWeb.video, screen)

    assert.deepStrictEqual(commands, [])
  })

  it("should swap a benched custom stream into the selected slot", () => {
    const quad = TestWeb.assignCustom(Screen.initial, 3, TestWeb.video)
    const pair = Result.getOrThrow(quad.apply({ _tag: "SetLayout", layout: "Pair" }, TestWeb.nowhere))

    const { commands } = Display.initial.chooseCustom(TestWeb.video, pair)

    assert.deepStrictEqual(commands[0], { _tag: "Swap", a: 3, b: 0 })
  })

  it("should close the guide once a custom stream is chosen", () => {
    const display = new Display({ ...Display.initial, overlay: customGuide })

    const { display: next } = display.chooseCustom(TestWeb.video, Screen.initial)

    assert.strictEqual(next.overlay._tag, "None")
  })
})

describe("Display#customEdited", () => {
  it("should clear every tile showing a removed stream", () => {
    const screen = TestWeb.assignCustom(TestWeb.fill([TestWeb.bama]), 1, TestWeb.video)

    const { commands } = Display.initial.customEdited(
      CustomStreamsChange.Removed({ id: TestWeb.video.id }),
      screen
    )

    assert.deepStrictEqual(commands, [{ _tag: "Clear", tile: 1 }])
  })

  it("should give every tile showing a renamed stream its new name", () => {
    const screen = TestWeb.assignCustom(Screen.initial, 1, TestWeb.video)

    const { commands } = Display.initial.customEdited(
      CustomStreamsChange.Renamed({ id: TestWeb.video.id, name: "Recap" }),
      screen
    )

    assert.deepStrictEqual(commands, [
      {
        _tag: "AssignCustom",
        tile: 1,
        stream: TestWeb.video.id,
        name: "Recap",
        locator: TestWeb.video.locator()
      }
    ])
  })

  it("should send nothing for a stream added to the list", () => {
    const { commands } = Display.initial.customEdited(
      CustomStreamsChange.Added({ stream: TestWeb.video }),
      Screen.initial
    )

    assert.deepStrictEqual(commands, [])
  })
})

describe("Display custom tiles", () => {
  it("should interact with a custom tile's player", () => {
    const screen = TestWeb.assignCustom(Screen.initial, 0, TestWeb.video)

    const { display } = Display.initial.press({ _tag: "Interact" }, screen, none)

    assert.strictEqual(display.interactingOn(screen), TileKey.custom(TestWeb.video.id))
  })

  it("should do nothing in the fold on Remove: the saved list is DisplayState's", () => {
    const display = new Display({ ...Display.initial, overlay: customGuide })

    const step = display.press({ _tag: "Remove" }, Screen.initial, none)

    assert.strictEqual(step.display, display)
    assert.deepStrictEqual(step.commands, [])
  })
})

describe("Display#focusedItem", () => {
  it("should be the card the guide's focus is on", () => {
    const display = new Display({ ...Display.initial, overlay: customGuide })

    const item = display.focusedItem(customShelves)

    assert.deepStrictEqual(item, GuideItem.Custom({ stream: TestWeb.video }))
  })

  it("should be none while the focus is on the rail", () => {
    const overlay = Overlay.Guide({
      level: "Full",
      entry: "Custom",
      focus: { rail: true, shelf: 0, item: 0 }
    })
    const display = new Display({ ...Display.initial, overlay })

    const item = display.focusedItem(customShelves)

    assert.isUndefined(item)
  })
})

describe("Display guide Custom entry", () => {
  it("should assign a custom stream on Confirm on its card, and close the guide", () => {
    const display = new Display({ ...Display.initial, overlay: customGuide })

    const step = display.apply(
      DisplayInput.Pressed({ hotkey: { _tag: "Confirm" } }),
      Screen.initial,
      customShelves
    )

    assert.strictEqual(step.commands[0]?._tag, "AssignCustom")
    assert.strictEqual(step.display.overlay._tag, "None")
  })

  it("should open the YouTube form on Confirm on the add card", () => {
    const overlay = Overlay.Guide({
      level: "Full",
      entry: "Custom",
      focus: { rail: false, shelf: 0, item: 1 }
    })
    const display = new Display({ ...Display.initial, overlay })

    const step = display.apply(
      DisplayInput.Pressed({ hotkey: { _tag: "Confirm" } }),
      Screen.initial,
      customShelves
    )

    assert.strictEqual(step.display.overlay._tag, "CustomForm")
  })
})

describe("Display YouTube form", () => {
  it("should go back to the guide, at its focus, when the form closes", () => {
    const opened = new Display({ ...Display.initial, overlay: customGuide }).openCustomForm(undefined)

    const closed = opened.close()

    assert.deepStrictEqual(closed.overlay, customGuide)
  })

  it("should close to nothing when it was opened from outside the guide", () => {
    const opened = new Display({ ...Display.initial, overlay: Overlay.Palette() }).openCustomForm(undefined)

    const closed = opened.close()

    assert.strictEqual(closed.overlay._tag, "None")
  })

  it("should hold the stream it renames", () => {
    const opened = Display.initial.openCustomForm(TestWeb.video)

    assert.isTrue(Overlay.$is("CustomForm")(opened.overlay) && opened.overlay.editing === TestWeb.video)
  })
})

/** The full guide on Custom, focused on its first card. */
const customGuide = Overlay.Guide({
  level: "Full",
  entry: "Custom",
  focus: { rail: false, shelf: 0, item: 0 }
})

/** One saved stream, then the add card, under every entry. */
const customShelves: GuideShelves = {
  entries: ["AllLive", "Custom"],
  shelves: () => [[GuideItem.Custom({ stream: TestWeb.video }), GuideItem.AddCustom()]]
}

const live = GameId.make("live")

/** No guide: only All live, and every entry has no shelves. */
const none: GuideShelves = { entries: ["AllLive"], shelves: () => [] }

/** An empty Quad, for the guide's tests. */
const emptyQuad = TestWeb.withTiles([])

/**
 * Today's guide for the guide's tests: NFL with all three shelves, FBS with an empty middle one, MLB with only later,
 * and NBA listed last with no games.
 */
const shelves: GuideShelves = {
  entries: ["AllLive", "nfl", "fbs", "mlb", "nba"],
  shelves: (entry, level) => {
    switch (entry) {
      case "AllLive":
        return [[item("kc"), item("dal"), item("osu")]]
      case "nfl":
        return level === "Ribbon"
          ? [[item("kc"), item("dal"), item("sf")]]
          : [[item("kc"), item("dal")], [item("sf")], [item("nyj")]]
      case "fbs":
        return level === "Ribbon" ? [[item("osu")]] : [[item("osu")], [], [item("mich")]]
      case "mlb":
        return level === "Ribbon" ? [[item("nyy")]] : [[], [item("nyy")], []]
      default:
        return level === "Ribbon" ? [[]] : [[], [], []]
    }
  }
}

function item(id: string): GuideItem {
  return GuideItem.Game({ game: GameId.make(id) })
}

/** The guide overlay at `level` on `entry`, focused at `focus` (the first item of the first shelf unless said). */
function guide(level: GuideLevel, entry: GuideEntry, focus: Partial<GuideFocus> = {}): Overlay {
  return Overlay.Guide({ level, entry, focus: { rail: false, shelf: 0, item: 0, ...focus } })
}

/** `display` after pressing `hotkeys` in order on an empty Quad, over `on`. */
function after(display: Display, hotkeys: ReadonlyArray<Hotkey>, on: GuideShelves = shelves): Display {
  return hotkeys.reduce((each, hotkey) => each.press(hotkey, emptyQuad, on).display, display)
}

function move(direction: "up" | "down" | "left" | "right"): Hotkey {
  return { _tag: "Move", direction }
}
