import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Option } from "effect"
import { Screen, type ScreenCommand } from "../screen/Screen.ts"
import { StripCard } from "../slate/StripCard.ts"
import * as TestWeb from "../TestWeb.ts"
import { Display, DisplayStep } from "./Display.ts"

describe("Display.initial", () => {
  it("should start on slot 0, with nothing interacting or picked, the slate open, and no overlay", () => {
    const display = Display.initial

    assert.strictEqual(display.selected, 0)
    assert.isUndefined(display.interacting)
    assert.isUndefined(display.pick)
    assert.isTrue(display.slateOpen)
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
    const interacting = press(Display.initial, { _tag: "Interact" }, screen).display

    const reselected = interacting.select(0, screen).display

    assert.strictEqual(reselected.interactingOn(screen), "live")
  })

  it("should end interacting when another slot is selected", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const interacting = press(Display.initial, { _tag: "Interact" }, screen).display

    const moved = interacting.select(1, screen).display

    assert.isUndefined(moved.interacting)
  })

  it("should not interact again when the slot it ended on is selected back", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const interacting = press(Display.initial, { _tag: "Interact" }, screen).display
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

  it("should drop into the last slot once the layout has fewer", () => {
    const quad = TestWeb.withTiles([])
    const selected = Display.initial.select(3, quad).display
    const single = new Screen({ ...quad, layout: "Single" })
    const free = cardOf(single, 0)

    const { commands } = selected.drop(free, single)

    assert.deepStrictEqual(commands, [{ _tag: "Assign", tile: 0, game: GameId.make("live") }])
  })

  it("should keep interacting when the slot selected is the one the clamped selection already reads", () => {
    const quad = TestWeb.withTiles(["live"])
    const selected = Display.initial.select(3, quad).display
    const single = new Screen({ ...quad, layout: "Single" })
    const interacting = press(selected, { _tag: "Interact" }, single).display

    const reselected = interacting.select(0, single).display

    assert.strictEqual(reselected.interactingOn(single), "live")
  })

  it("should read the game interacting on the screen it began on", () => {
    const before = TestWeb.withTiles(["live", "soon"])
    const display = press(Display.initial, { _tag: "Interact" }, before).display

    const interacting = display.interactingOn(before)

    assert.strictEqual(interacting, "live")
  })

  it("should read interacting as none once a swap moves another game into the selected slot", () => {
    const before = TestWeb.withTiles(["live", "soon"])
    const display = press(Display.initial, { _tag: "Interact" }, before).display

    const interacting = display.interactingOn(TestWeb.withTiles(["soon", "live"]))

    assert.isUndefined(interacting)
  })

  it("should read interacting again once its game is swapped back into the selected slot", () => {
    const before = TestWeb.withTiles(["live", "soon"])
    const display = press(Display.initial, { _tag: "Interact" }, before).display
    display.interactingOn(TestWeb.withTiles(["soon", "live"]))

    const swappedBack = display.interactingOn(TestWeb.withTiles(["live", "soon"]))

    assert.strictEqual(swappedBack, "live")
  })
})

describe("Display#drop", () => {
  it("should assign a free game into the selected slot, pick it, and select the next empty slot", () => {
    const screen = TestWeb.withTiles(["soon"])
    const free = cardOf(screen, 0)

    const dropped = Display.initial.drop(free, screen)

    assert.deepStrictEqual(dropped.commands, [{ _tag: "Assign", tile: 0, game: GameId.make("live") }])
    assert.strictEqual(dropped.display.pick, "live")
    assert.strictEqual(dropped.display.selected, 1)
  })

  it("should swap a benched game into the selected slot and select the next empty slot", () => {
    const screen = TestWeb.withTiles(["soon", undefined, undefined, undefined, "done"])
    const bench = cardOf(screen, 0)
    const selected = Display.initial.select(2, screen).display

    const dropped = selected.drop(bench, screen)

    assert.deepStrictEqual(dropped.commands, [{ _tag: "Swap", a: 4, b: 2 }])
    assert.strictEqual(dropped.display.pick, "done")
    assert.strictEqual(dropped.display.selected, 3)
  })

  it("should do nothing with a game already on screen", () => {
    const screen = TestWeb.withTiles(["soon", undefined, undefined, undefined, "done"])
    const onScreen = cardOf(screen, 2)

    const dropped = Display.initial.drop(onScreen, screen)

    assert.strictEqual(dropped.display, Display.initial)
    assert.deepStrictEqual(dropped.commands, [])
  })

  it("should select the next empty slot after the drop", () => {
    const screen = TestWeb.withTiles(["soon", undefined, undefined, undefined])
    const free = cardOf(screen, 0)
    const selected = Display.initial.select(1, screen).display

    const dropped = selected.drop(free, screen)

    assert.strictEqual(dropped.display.selected, 2)
  })

  it("should keep the selection when no empty slot is left", () => {
    const full = TestWeb.withTiles(["soon", "later", undefined, "done"])
    const left = cardOf(full, 0)
    const selected = Display.initial.select(2, full).display

    const dropped = selected.drop(left, full)

    assert.strictEqual(dropped.display.selected, 2)
  })

  it("should end interacting when the drop moves the selection", () => {
    const screen = TestWeb.withTiles(["soon"])
    const interacting = press(Display.initial, { _tag: "Interact" }, screen).display
    const free = cardOf(screen, 0)

    const dropped = interacting.drop(free, screen)

    assert.isUndefined(dropped.display.interacting)
  })
})

describe("Display#press", () => {
  it("should answer with a DisplayStep", () => {
    const step = press(Display.initial, { _tag: "ToggleSlate" }, TestWeb.withTiles([]))

    assert.instanceOf(step, DisplayStep)
  })

  it("should select with SelectTile as select does", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const interacting = press(Display.initial, { _tag: "Interact" }, screen).display

    const { display, commands } = press(interacting, { _tag: "SelectTile", slot: 1 }, screen)

    assert.strictEqual(display.selected, 1)
    assert.isUndefined(display.interacting)
    assert.deepStrictEqual(commands, [])
  })

  it("should ignore SelectTile past the last slot, as select does", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const interacting = press(Display.initial, { _tag: "Interact" }, screen).display

    const { display } = press(interacting, { _tag: "SelectTile", slot: 8 }, screen)

    assert.strictEqual(display, interacting)
  })

  it("should solo the selected slot with ToggleSolo", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const selected = Display.initial.select(1, screen).display

    const solo = press(selected, { _tag: "ToggleSolo" }, screen)

    assert.strictEqual(solo.display, selected)
    assert.deepStrictEqual(solo.commands, [{ _tag: "Solo", tile: 1 }])
  })

  it("should unsolo with ToggleSolo while soloed", () => {
    const screen = TestWeb.withTiles(["live", "soon"])
    const selected = Display.initial.select(1, screen).display
    const soloed = new Screen({ ...screen, solo: Option.some(GameId.make("soon")) })

    const { commands } = press(selected, { _tag: "ToggleSolo" }, soloed)

    assert.deepStrictEqual(commands, [{ _tag: "Unsolo" }])
  })

  it("should send nothing with ToggleSolo on an Empty tile when not soloed", () => {
    const screen = TestWeb.withTiles(["live"])
    const selected = Display.initial.select(1, screen).display

    const { display, commands } = press(selected, { _tag: "ToggleSolo" }, screen)

    assert.strictEqual(display, selected)
    assert.deepStrictEqual(commands, [])
  })

  it("should unsolo with ToggleSolo on an Empty tile while soloed", () => {
    const soloed = new Screen({ ...TestWeb.withTiles(["live"]), solo: Option.some(GameId.make("live")) })
    const selected = Display.initial.select(1, soloed).display

    const { commands } = press(selected, { _tag: "ToggleSolo" }, soloed)

    assert.deepStrictEqual(commands, [{ _tag: "Unsolo" }])
  })

  it("should solo the last slot with ToggleSolo once the layout has fewer", () => {
    const quad = TestWeb.withTiles(["live"])
    const selected = Display.initial.select(3, quad).display
    const single = new Screen({ ...quad, layout: "Single" })

    const { commands } = press(selected, { _tag: "ToggleSolo" }, single)

    assert.deepStrictEqual(commands, [{ _tag: "Solo", tile: 0 }])
  })

  it("should close the key help with Esc and send no Unsolo, even while soloed", () => {
    const soloed = new Screen({ ...TestWeb.withTiles(["live"]), solo: Option.some(GameId.make("live")) })
    const keys = Display.initial.open("Keys")

    const { display, commands } = press(keys, { _tag: "Unsolo" }, soloed)

    assert.strictEqual(display.overlay._tag, "None")
    assert.deepStrictEqual(commands, [])
  })

  it("should close the Palette overlay with Esc and send nothing", () => {
    const open = Display.initial.open("Palette")

    const { display, commands } = press(open, { _tag: "Unsolo" }, TestWeb.withTiles([]))

    assert.strictEqual(display.overlay._tag, "None")
    assert.deepStrictEqual(commands, [])
  })

  it("should unsolo with Esc and no overlay while soloed", () => {
    const soloed = new Screen({ ...TestWeb.withTiles(["live"]), solo: Option.some(GameId.make("live")) })

    const { display, commands } = press(Display.initial, { _tag: "Unsolo" }, soloed)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [{ _tag: "Unsolo" }])
  })

  it("should do nothing with Esc and no overlay while not soloed", () => {
    const screen = TestWeb.withTiles(["live"])

    const { display, commands } = press(Display.initial, { _tag: "Unsolo" }, screen)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [])
  })

  it("should interact with the selected slot's stream with Interact", () => {
    const screen = TestWeb.withTiles(["live"])

    const { display, commands } = press(Display.initial, { _tag: "Interact" }, screen)

    assert.strictEqual(display.interactingOn(screen), "live")
    assert.deepStrictEqual(commands, [])
  })

  it("should end interacting with Interact when it was on", () => {
    const screen = TestWeb.withTiles(["live"])
    const on = press(Display.initial, { _tag: "Interact" }, screen).display

    const { display } = press(on, { _tag: "Interact" }, screen)

    assert.isUndefined(display.interactingOn(screen))
  })

  it("should interact with the game now there with Interact on a slot a swap has refilled", () => {
    const before = TestWeb.withTiles(["live", "soon"])
    const stale = press(Display.initial, { _tag: "Interact" }, before).display
    const swapped = TestWeb.withTiles(["soon", "live"])

    const { display } = press(stale, { _tag: "Interact" }, swapped)

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
    const { display } = press(Display.initial, { _tag: "Interact" }, screen)

    assert.strictEqual(display, Display.initial)
  })

  it("should move the pick forward with StepPick as StripCard.nextPick does", () => {
    const screen = TestWeb.withTiles(["soon", undefined, undefined, undefined, "done"])
    const cards = StripCard.of(screen, TestWeb.slate)

    const { display, commands } = press(Display.initial, { _tag: "StepPick", step: 1 }, screen)

    assert.strictEqual(display.pick, StripCard.nextPick(cards, undefined, 1))
    assert.deepStrictEqual(commands, [])
  })

  it("should move the pick back with StepPick as StripCard.nextPick does", () => {
    const screen = TestWeb.withTiles(["soon", undefined, undefined, undefined, "done"])
    const cards = StripCard.of(screen, TestWeb.slate)
    const first = press(Display.initial, { _tag: "StepPick", step: 1 }, screen).display

    const { display } = press(first, { _tag: "StepPick", step: -1 }, screen)

    assert.strictEqual(display.pick, StripCard.nextPick(cards, first.pick, -1))
  })

  it("should drop the picked card with DropPick as drop does", () => {
    const screen = TestWeb.withTiles(["soon"])
    const picked = press(Display.initial, { _tag: "StepPick", step: 1 }, screen).display
    const free = cardOf(screen, 0)

    const step = press(picked, { _tag: "DropPick" }, screen)

    assert.deepStrictEqual(step, picked.drop(free, screen))
  })

  it("should do nothing with DropPick and no pick", () => {
    const { display, commands } = press(Display.initial, { _tag: "DropPick" }, TestWeb.withTiles([]))

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [])
  })

  it("should toggle the slate with ToggleSlate as toggleSlate does", () => {
    const { display, commands } = press(Display.initial, { _tag: "ToggleSlate" }, TestWeb.withTiles([]))

    assert.isFalse(display.slateOpen)
    assert.deepStrictEqual(display, Display.initial.toggleSlate())
    assert.deepStrictEqual(commands, [])
  })

  it("should open a closed slate with ToggleSlate", () => {
    const closed = Display.initial.toggleSlate()

    const { display, commands } = press(closed, { _tag: "ToggleSlate" }, TestWeb.withTiles([]))

    assert.isTrue(display.slateOpen)
    assert.deepStrictEqual(commands, [])
  })

  it("should open the key help with ShowKeys", () => {
    const { display, commands } = press(Display.initial, { _tag: "ShowKeys" }, TestWeb.withTiles([]))

    assert.strictEqual(display.overlay._tag, "Keys")
    assert.deepStrictEqual(commands, [])
  })

  it("should close the key help with ShowKeys when it was open", () => {
    const screen = TestWeb.withTiles([])
    const open = press(Display.initial, { _tag: "ShowKeys" }, screen).display

    const { display } = press(open, { _tag: "ShowKeys" }, screen)

    assert.strictEqual(display.overlay._tag, "None")
  })

  it("should replace the palette with the key help with ShowKeys", () => {
    const palette = Display.initial.open("Palette")

    const { display, commands } = press(palette, { _tag: "ShowKeys" }, TestWeb.withTiles([]))

    assert.strictEqual(display.overlay._tag, "Keys")
    assert.deepStrictEqual(commands, [])
  })

  it("should open the palette with CommandPalette, replacing the key help", () => {
    const keys = Display.initial.open("Keys")

    const { display, commands } = press(keys, { _tag: "CommandPalette" }, TestWeb.withTiles([]))

    assert.strictEqual(display.overlay._tag, "Palette")
    assert.deepStrictEqual(commands, [])
  })

  it("should close the palette with CommandPalette when it was open", () => {
    const screen = TestWeb.withTiles([])
    const open = press(Display.initial.open("Keys"), { _tag: "CommandPalette" }, screen).display

    const { display } = press(open, { _tag: "CommandPalette" }, screen)

    assert.strictEqual(display.overlay._tag, "None")
  })

  it.each<{ hotkey: Parameters<Display["press"]>[0]; command: ScreenCommand }>([
    { hotkey: { _tag: "FocusAudio", slot: 1 }, command: { _tag: "FocusAudio", tile: 1 } },
    { hotkey: { _tag: "Promote", slot: 1 }, command: { _tag: "Promote", tile: 1 } },
    { hotkey: { _tag: "NextLayout" }, command: { _tag: "SetLayout", layout: "MainThree" } }
  ])("should send $hotkey._tag's command and change nothing", ({ hotkey, command }) => {
    const screen = TestWeb.withTiles(["live", "soon"])

    const { display, commands } = press(Display.initial, hotkey, screen)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [command])
  })

  it("should return the same display with FullScreen and send nothing", () => {
    const { display, commands } = press(Display.initial, { _tag: "FullScreen" }, TestWeb.withTiles([]))

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

function press(display: Display, hotkey: Parameters<Display["press"]>[0], screen: Screen) {
  return display.press(hotkey, screen, StripCard.of(screen, TestWeb.slate))
}

/** The strip card at `index` on `screen`; a test that asks for one past the strip fails here. */
function cardOf(screen: Screen, index: number) {
  const card = StripCard.of(screen, TestWeb.slate)[index]
  if (card === undefined) throw new Error(`no strip card at ${index}`)
  return card
}
