import { assert, describe, it } from "@effect/vitest"
import { TileKey } from "@sportal/api/TileKey"
import { GameId } from "@sportal/domain/Game"
import { Option } from "effect"
import { Screen, type ScreenCommand } from "../screen/Screen.ts"
import * as TestWeb from "../TestWeb.ts"
import { Display, DisplayInput, DisplayStep } from "./Display.ts"

describe("Display.initial", () => {
  it("should start on slot 0, with nothing interacting and no overlay", () => {
    const display = Display.initial

    assert.strictEqual(display.selected, 0)
    assert.isUndefined(display.interacting)
    assert.strictEqual(display.overlay._tag, "None")
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
    const interacting = Display.initial.press({ _tag: "Interact" }, screen).display

    const reselected = interacting.select(0, screen).display

    assert.strictEqual(reselected.interactingOn(screen), "live")
  })

  it("should end interacting when another slot is selected", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const interacting = Display.initial.press({ _tag: "Interact" }, screen).display

    const moved = interacting.select(1, screen).display

    assert.isUndefined(moved.interacting)
  })

  it("should not interact again when the slot it ended on is selected back", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const interacting = Display.initial.press({ _tag: "Interact" }, screen).display
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
    const interacting = selected.press({ _tag: "Interact" }, single).display

    const reselected = interacting.select(0, single).display

    assert.strictEqual(reselected.interactingOn(single), "live")
  })

  it("should read the game interacting on the screen it began on", () => {
    const before = TestWeb.withTiles(["live", "soon"])
    const display = Display.initial.press({ _tag: "Interact" }, before).display

    const interacting = display.interactingOn(before)

    assert.strictEqual(interacting, "live")
  })

  it("should read interacting as none once a swap moves another game into the selected slot", () => {
    const before = TestWeb.withTiles(["live", "soon"])
    const display = Display.initial.press({ _tag: "Interact" }, before).display

    const interacting = display.interactingOn(TestWeb.withTiles(["soon", "live"]))

    assert.isUndefined(interacting)
  })

  it("should read interacting again once its game is swapped back into the selected slot", () => {
    const before = TestWeb.withTiles(["live", "soon"])
    const display = Display.initial.press({ _tag: "Interact" }, before).display
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
    const interacting = Display.initial.press({ _tag: "Interact" }, screen).display

    const chosen = interacting.choose(live, screen)

    assert.isUndefined(chosen.display.interacting)
  })
})

describe("Display#press", () => {
  it("should answer with a DisplayStep", () => {
    const step = Display.initial.press({ _tag: "ShowKeys" }, TestWeb.withTiles([]))

    assert.instanceOf(step, DisplayStep)
  })

  it("should select with SelectTile as select does", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const interacting = Display.initial.press({ _tag: "Interact" }, screen).display

    const { display, commands } = interacting.press({ _tag: "SelectTile", slot: 1 }, screen)

    assert.strictEqual(display.selected, 1)
    assert.isUndefined(display.interacting)
    assert.deepStrictEqual(commands, [])
  })

  it("should ignore SelectTile past the last slot, as select does", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const interacting = Display.initial.press({ _tag: "Interact" }, screen).display

    const { display } = interacting.press({ _tag: "SelectTile", slot: 8 }, screen)

    assert.strictEqual(display, interacting)
  })

  it("should solo the selected slot with ToggleSolo", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const selected = Display.initial.select(1, screen).display

    const solo = selected.press({ _tag: "ToggleSolo" }, screen)

    assert.strictEqual(solo.display, selected)
    assert.deepStrictEqual(solo.commands, [{ _tag: "Solo", tile: 1 }])
  })

  it("should unsolo with ToggleSolo while soloed", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const selected = Display.initial.select(1, screen).display
    const soloed = new Screen({ ...screen, solo: Option.some(TileKey.game(GameId.make("soon"))) })

    const { commands } = selected.press({ _tag: "ToggleSolo" }, soloed)

    assert.deepStrictEqual(commands, [{ _tag: "Unsolo" }])
  })

  it("should send nothing with ToggleSolo on an Empty tile when not soloed", () => {
    const screen = TestWeb.withTiles(["live"])
    const selected = Display.initial.select(1, screen).display

    const { display, commands } = selected.press({ _tag: "ToggleSolo" }, screen)

    assert.strictEqual(display, selected)
    assert.deepStrictEqual(commands, [])
  })

  it("should unsolo with ToggleSolo on an Empty tile while soloed", () => {
    const soloed = new Screen({
      ...TestWeb.withTiles(["live"]),
      solo: Option.some(TileKey.game(GameId.make("live")))
    })
    const selected = Display.initial.select(1, soloed).display

    const { commands } = selected.press({ _tag: "ToggleSolo" }, soloed)

    assert.deepStrictEqual(commands, [{ _tag: "Unsolo" }])
  })

  it("should solo the last slot with ToggleSolo once the layout has fewer", () => {
    const quad = TestWeb.withTiles(["live"])
    const selected = Display.initial.select(3, quad).display
    const single = new Screen({ ...quad, layout: "Single" })

    const { commands } = selected.press({ _tag: "ToggleSolo" }, single)

    assert.deepStrictEqual(commands, [{ _tag: "Solo", tile: 0 }])
  })

  it("should close the key help with Esc and send no Unsolo, even while soloed", () => {
    const soloed = new Screen({
      ...TestWeb.withTiles(["live"]),
      solo: Option.some(TileKey.game(GameId.make("live")))
    })
    const keys = Display.initial.open("Keys")

    const { display, commands } = keys.press({ _tag: "Unsolo" }, soloed)

    assert.strictEqual(display.overlay._tag, "None")
    assert.deepStrictEqual(commands, [])
  })

  it.each(["Palette", "JoinRemote"] as const)(
    "should close the %s overlay with Esc and send nothing",
    (overlay) => {
      const open = Display.initial.open(overlay)

      const { display, commands } = open.press({ _tag: "Unsolo" }, TestWeb.withTiles([]))

      assert.strictEqual(display.overlay._tag, "None")
      assert.deepStrictEqual(commands, [])
    }
  )

  it("should unsolo with Esc and no overlay while soloed", () => {
    const soloed = new Screen({
      ...TestWeb.withTiles(["live"]),
      solo: Option.some(TileKey.game(GameId.make("live")))
    })

    const { display, commands } = Display.initial.press({ _tag: "Unsolo" }, soloed)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [{ _tag: "Unsolo" }])
  })

  it("should do nothing with Esc and no overlay while not soloed", () => {
    const screen = TestWeb.withTiles(["live"])

    const { display, commands } = Display.initial.press({ _tag: "Unsolo" }, screen)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [])
  })

  it("should interact with the selected slot's stream with Interact", () => {
    const screen = TestWeb.withTiles(["live"])

    const { display, commands } = Display.initial.press({ _tag: "Interact" }, screen)

    assert.strictEqual(display.interactingOn(screen), "live")
    assert.deepStrictEqual(commands, [])
  })

  it("should end interacting with Interact when it was on", () => {
    const screen = TestWeb.withTiles(["live"])
    const on = Display.initial.press({ _tag: "Interact" }, screen).display

    const { display } = on.press({ _tag: "Interact" }, screen)

    assert.isUndefined(display.interactingOn(screen))
  })

  it("should interact with the game now there with Interact on a slot a swap has refilled", () => {
    const before = TestWeb.withTiles(["live", "soon"])
    const stale = Display.initial.press({ _tag: "Interact" }, before).display
    const swapped = TestWeb.withTiles(["soon", "live"])

    const { display } = stale.press({ _tag: "Interact" }, swapped)

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
    const { display } = Display.initial.press({ _tag: "Interact" }, screen)

    assert.strictEqual(display, Display.initial)
  })

  it("should open the key help with ShowKeys", () => {
    const { display, commands } = Display.initial.press({ _tag: "ShowKeys" }, TestWeb.withTiles([]))

    assert.strictEqual(display.overlay._tag, "Keys")
    assert.deepStrictEqual(commands, [])
  })

  it("should close the key help with ShowKeys when it was open", () => {
    const screen = TestWeb.withTiles([])
    const open = Display.initial.press({ _tag: "ShowKeys" }, screen).display

    const { display } = open.press({ _tag: "ShowKeys" }, screen)

    assert.strictEqual(display.overlay._tag, "None")
  })

  it("should replace the palette with the key help with ShowKeys", () => {
    const palette = Display.initial.open("Palette")

    const { display, commands } = palette.press({ _tag: "ShowKeys" }, TestWeb.withTiles([]))

    assert.strictEqual(display.overlay._tag, "Keys")
    assert.deepStrictEqual(commands, [])
  })

  it("should open the palette with CommandPalette, replacing the key help", () => {
    const keys = Display.initial.open("Keys")

    const { display, commands } = keys.press({ _tag: "CommandPalette" }, TestWeb.withTiles([]))

    assert.strictEqual(display.overlay._tag, "Palette")
    assert.deepStrictEqual(commands, [])
  })

  it("should close the palette with CommandPalette when it was open", () => {
    const screen = TestWeb.withTiles([])
    const open = Display.initial.open("Keys").press({ _tag: "CommandPalette" }, screen).display

    const { display } = open.press({ _tag: "CommandPalette" }, screen)

    assert.strictEqual(display.overlay._tag, "None")
  })

  it.each<{ hotkey: Parameters<Display["press"]>[0]; command: ScreenCommand }>([
    { hotkey: { _tag: "FocusAudio", slot: 1 }, command: { _tag: "FocusAudio", tile: 1 } },
    { hotkey: { _tag: "Promote", slot: 1 }, command: { _tag: "Promote", tile: 1 } },
    { hotkey: { _tag: "NextLayout" }, command: { _tag: "SetLayout", layout: "MainThree" } }
  ])("should send $hotkey._tag's command and change nothing", ({ hotkey, command }) => {
    const screen = TestWeb.withTiles(["live", "soon"])

    const { display, commands } = Display.initial.press(hotkey, screen)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [command])
  })

  it("should return the same display with FullScreen and send nothing", () => {
    const { display, commands } = Display.initial.press({ _tag: "FullScreen" }, TestWeb.withTiles([]))

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

    const step = Display.initial.apply(DisplayInput.Pressed({ hotkey: { _tag: "ShowKeys" } }), screen)

    assert.deepStrictEqual(step, Display.initial.press({ _tag: "ShowKeys" }, screen))
  })

  it("should select a slot as select does", () => {
    const screen = TestWeb.withTiles(["live", "soon"])

    const step = Display.initial.apply(DisplayInput.Selected({ slot: 1 }), screen)

    assert.deepStrictEqual(step, Display.initial.select(1, screen))
  })

  it("should select the slot a pressed video's game is in", () => {
    const screen = TestWeb.withTiles(["live", "soon"])

    const { display, commands } = Display.initial.apply(
      DisplayInput.VideoPressed({ key: TileKey.game(GameId.make("soon")) }),
      screen
    )

    assert.strictEqual(display.selected, 1)
    assert.deepStrictEqual(commands, [])
  })

  it("should do nothing for a pressed video whose game is not on screen", () => {
    const screen = TestWeb.withTiles(["live"])

    const { display } = Display.initial.apply(
      DisplayInput.VideoPressed({ key: TileKey.game(GameId.make("gone")) }),
      screen
    )

    assert.strictEqual(display, Display.initial)
  })

  it("should choose a game as choose does", () => {
    const screen = TestWeb.withTiles(["soon"])

    const step = Display.initial.apply(DisplayInput.Chosen({ game: live }), screen)

    assert.deepStrictEqual(step, Display.initial.choose(live, screen))
  })

  it("should send a command and change nothing", () => {
    const command: ScreenCommand = { _tag: "SetLayout", layout: "Single" }

    const { display, commands } = Display.initial.apply(
      DisplayInput.Commanded({ command }),
      TestWeb.withTiles([])
    )

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [command])
  })

  it("should open an overlay", () => {
    const { display } = Display.initial.apply(DisplayInput.Opened({ overlay: "Keys" }), TestWeb.withTiles([]))

    assert.isTrue(display.shows("Keys"))
  })

  it("should close the open overlay", () => {
    const { display } = Display.initial.open("Palette").apply(DisplayInput.Closed(), TestWeb.withTiles([]))

    assert.strictEqual(display.overlay._tag, "None")
  })
})

const live = GameId.make("live")
