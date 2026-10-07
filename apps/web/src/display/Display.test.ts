import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Stage, type StageCommand } from "@sportal/domain/Stage"
import { StripCard } from "../slate/StripCards.ts"
import { slate, withTiles } from "../slate/TestSlate.ts"
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
    const step = Display.initial.select(1, withTiles([]))

    assert.instanceOf(step, DisplayStep)
  })

  it("should select a slot on stage and send nothing", () => {
    const { display, commands } = Display.initial.select(2, withTiles([]))

    assert.strictEqual(display.selected, 2)
    assert.deepStrictEqual(commands, [])
  })

  it("should keep interacting when the same slot is selected", () => {
    const stage = withTiles(["live", "soon"])
    const interacting = press(Display.initial, { _tag: "Interact" }, stage).display

    const reselected = interacting.select(0, stage).display

    assert.strictEqual(reselected.interactingOn(stage), "live")
  })

  it("should end interacting when another slot is selected", () => {
    const stage = withTiles(["live", "soon"])
    const interacting = press(Display.initial, { _tag: "Interact" }, stage).display

    const moved = interacting.select(1, stage).display

    assert.isUndefined(moved.interacting)
  })

  it("should not interact again when the slot it ended on is selected back", () => {
    const stage = withTiles(["live", "soon"])
    const interacting = press(Display.initial, { _tag: "Interact" }, stage).display
    const moved = interacting.select(1, stage).display

    const back = moved.select(0, stage).display

    assert.isUndefined(back.interactingOn(stage))
  })

  it("should ignore a slot past the last", () => {
    const stage = withTiles([])

    const { display, commands } = Display.initial.select(4, stage)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [])
  })
})

describe("Display#selectedOn and Display#interactingOn", () => {
  it("should read the last slot once the layout has fewer", () => {
    const quad = withTiles([])
    const selected = Display.initial.select(3, quad).display
    const single = new Stage({ ...quad, layout: "Single" })

    const slot = selected.selectedOn(single)

    assert.strictEqual(slot, 0)
  })

  it("should drop into the last slot once the layout has fewer", () => {
    const quad = withTiles([])
    const selected = Display.initial.select(3, quad).display
    const single = new Stage({ ...quad, layout: "Single" })
    const free = cardOf(single, 0)

    const { commands } = selected.drop(free, single)

    assert.deepStrictEqual(commands, [{ _tag: "Assign", tile: 0, game: GameId.make("live") }])
  })

  it("should keep interacting when the slot selected is the one the clamped selection already reads", () => {
    const quad = withTiles(["live"])
    const selected = Display.initial.select(3, quad).display
    const single = new Stage({ ...quad, layout: "Single" })
    const interacting = press(selected, { _tag: "Interact" }, single).display

    const reselected = interacting.select(0, single).display

    assert.strictEqual(reselected.interactingOn(single), "live")
  })

  it("should read the game interacting on the stage it began on", () => {
    const before = withTiles(["live", "soon"])
    const display = press(Display.initial, { _tag: "Interact" }, before).display

    const interacting = display.interactingOn(before)

    assert.strictEqual(interacting, "live")
  })

  it("should read interacting as none once a swap moves another game into the selected slot", () => {
    const before = withTiles(["live", "soon"])
    const display = press(Display.initial, { _tag: "Interact" }, before).display

    const interacting = display.interactingOn(withTiles(["soon", "live"]))

    assert.isUndefined(interacting)
  })

  it("should read interacting again once its game is swapped back into the selected slot", () => {
    const before = withTiles(["live", "soon"])
    const display = press(Display.initial, { _tag: "Interact" }, before).display

    const whileSwapped = display.interactingOn(withTiles(["soon", "live"]))
    const swappedBack = display.interactingOn(withTiles(["live", "soon"]))

    assert.isUndefined(whileSwapped)
    assert.strictEqual(swappedBack, "live")
  })
})

describe("Display#drop", () => {
  it("should assign a free game into the selected slot, pick it, and select the next empty slot", () => {
    const stage = withTiles(["soon"])
    const free = cardOf(stage, 0)

    const dropped = Display.initial.drop(free, stage)

    assert.deepStrictEqual(dropped.commands, [{ _tag: "Assign", tile: 0, game: GameId.make("live") }])
    assert.strictEqual(dropped.display.pick, "live")
    assert.strictEqual(dropped.display.selected, 1)
  })

  it("should swap a benched game into the selected slot and select the next empty slot", () => {
    const stage = withTiles(["soon", undefined, undefined, undefined, "done"])
    const bench = cardOf(stage, 0)
    const selected = Display.initial.select(2, stage).display

    const dropped = selected.drop(bench, stage)

    assert.deepStrictEqual(dropped.commands, [{ _tag: "Swap", a: 4, b: 2 }])
    assert.strictEqual(dropped.display.pick, "done")
    assert.strictEqual(dropped.display.selected, 3)
  })

  it("should do nothing with a game already on stage", () => {
    const stage = withTiles(["soon", undefined, undefined, undefined, "done"])
    const onStage = cardOf(stage, 2)

    const dropped = Display.initial.drop(onStage, stage)

    assert.strictEqual(dropped.display, Display.initial)
    assert.deepStrictEqual(dropped.commands, [])
  })

  it("should select the next empty slot after the drop", () => {
    const stage = withTiles(["soon", undefined, undefined, undefined])
    const free = cardOf(stage, 0)
    const selected = Display.initial.select(1, stage).display

    const dropped = selected.drop(free, stage)

    assert.strictEqual(dropped.display.selected, 2)
  })

  it("should keep the selection when no empty slot is left", () => {
    const full = withTiles(["soon", "later", undefined, "done"])
    const left = cardOf(full, 0)
    const selected = Display.initial.select(2, full).display

    const dropped = selected.drop(left, full)

    assert.strictEqual(dropped.display.selected, 2)
  })

  it("should end interacting when the drop moves the selection", () => {
    const stage = withTiles(["soon"])
    const interacting = press(Display.initial, { _tag: "Interact" }, stage).display
    const free = cardOf(stage, 0)

    const dropped = interacting.drop(free, stage)

    assert.isUndefined(dropped.display.interacting)
  })
})

describe("Display#press", () => {
  it("should answer with a DisplayStep", () => {
    const step = press(Display.initial, { _tag: "ToggleSlate" }, withTiles([]))

    assert.instanceOf(step, DisplayStep)
  })

  it("should select with SelectTile as select does", () => {
    const stage = withTiles(["live", "soon"])
    const interacting = press(Display.initial, { _tag: "Interact" }, stage).display

    const { display, commands } = press(interacting, { _tag: "SelectTile", slot: 1 }, stage)

    assert.strictEqual(display.selected, 1)
    assert.isUndefined(display.interacting)
    assert.deepStrictEqual(commands, [])
  })

  it("should ignore SelectTile past the last slot, as select does", () => {
    const stage = withTiles(["live", "soon"])
    const interacting = press(Display.initial, { _tag: "Interact" }, stage).display

    const { display } = press(interacting, { _tag: "SelectTile", slot: 8 }, stage)

    assert.strictEqual(display, interacting)
  })

  it("should solo the selected slot with ToggleSolo", () => {
    const stage = withTiles(["live", "soon"])
    const selected = Display.initial.select(1, stage).display

    const solo = press(selected, { _tag: "ToggleSolo" }, stage)

    assert.strictEqual(solo.display, selected)
    assert.deepStrictEqual(solo.commands, [{ _tag: "Solo", tile: 1 }])
  })

  it("should unsolo with ToggleSolo while soloed", () => {
    const stage = withTiles(["live", "soon"])
    const selected = Display.initial.select(1, stage).display
    const soloed = new Stage({ ...stage, solo: GameId.make("soon") })

    const { commands } = press(selected, { _tag: "ToggleSolo" }, soloed)

    assert.deepStrictEqual(commands, [{ _tag: "Unsolo" }])
  })

  it("should send nothing with ToggleSolo on an Empty tile when not soloed", () => {
    const stage = withTiles(["live"])
    const selected = Display.initial.select(1, stage).display

    const { display, commands } = press(selected, { _tag: "ToggleSolo" }, stage)

    assert.strictEqual(display, selected)
    assert.deepStrictEqual(commands, [])
  })

  it("should unsolo with ToggleSolo on an Empty tile while soloed", () => {
    const soloed = new Stage({ ...withTiles(["live"]), solo: GameId.make("live") })
    const selected = Display.initial.select(1, soloed).display

    const { commands } = press(selected, { _tag: "ToggleSolo" }, soloed)

    assert.deepStrictEqual(commands, [{ _tag: "Unsolo" }])
  })

  it("should solo the last slot with ToggleSolo once the layout has fewer", () => {
    const quad = withTiles(["live"])
    const selected = Display.initial.select(3, quad).display
    const single = new Stage({ ...quad, layout: "Single" })

    const { commands } = press(selected, { _tag: "ToggleSolo" }, single)

    assert.deepStrictEqual(commands, [{ _tag: "Solo", tile: 0 }])
  })

  it("should close the key help with Esc and send no Unsolo, even while soloed", () => {
    const soloed = new Stage({ ...withTiles(["live"]), solo: GameId.make("live") })
    const keys = Display.initial.open("Keys")

    const { display, commands } = press(keys, { _tag: "Unsolo" }, soloed)

    assert.strictEqual(display.overlay._tag, "None")
    assert.deepStrictEqual(commands, [])
  })

  it.each(["Palette", "JoinRemote"] as const)(
    "should close the %s overlay with Esc and send nothing",
    (overlay) => {
      const open = Display.initial.open(overlay)

      const { display, commands } = press(open, { _tag: "Unsolo" }, withTiles([]))

      assert.strictEqual(display.overlay._tag, "None")
      assert.deepStrictEqual(commands, [])
    }
  )

  it("should unsolo with Esc and no overlay while soloed", () => {
    const soloed = new Stage({ ...withTiles(["live"]), solo: GameId.make("live") })

    const { display, commands } = press(Display.initial, { _tag: "Unsolo" }, soloed)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [{ _tag: "Unsolo" }])
  })

  it("should do nothing with Esc and no overlay while not soloed", () => {
    const stage = withTiles(["live"])

    const { display, commands } = press(Display.initial, { _tag: "Unsolo" }, stage)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [])
  })

  it("should interact with the selected slot's stream with Interact", () => {
    const stage = withTiles(["live"])

    const { display, commands } = press(Display.initial, { _tag: "Interact" }, stage)

    assert.strictEqual(display.interactingOn(stage), "live")
    assert.deepStrictEqual(commands, [])
  })

  it("should end interacting with Interact when it was on", () => {
    const stage = withTiles(["live"])
    const on = press(Display.initial, { _tag: "Interact" }, stage).display

    const { display } = press(on, { _tag: "Interact" }, stage)

    assert.isUndefined(display.interactingOn(stage))
  })

  it("should interact with the game now there with Interact on a slot a swap has refilled", () => {
    const before = withTiles(["live", "soon"])
    const stale = press(Display.initial, { _tag: "Interact" }, before).display
    const swapped = withTiles(["soon", "live"])

    const { display } = press(stale, { _tag: "Interact" }, swapped)

    assert.strictEqual(display.interactingOn(swapped), "soon")
  })

  it.each([
    { tile: "an empty tile", stage: withTiles([]) },
    {
      tile: "a data tile",
      stage: new Stage({
        ...Stage.initial,
        tiles: [{ _tag: "DataTile", game: GameId.make("live"), why: { _tag: "NoStream" } }]
      })
    }
  ])("should do nothing with Interact on a tile with no stream: $tile", ({ stage }) => {
    const { display } = press(Display.initial, { _tag: "Interact" }, stage)

    assert.strictEqual(display, Display.initial)
  })

  it("should move the pick forward with StepPick as StripCard.nextPick does", () => {
    const stage = withTiles(["soon", undefined, undefined, undefined, "done"])
    const cards = StripCard.of(stage, slate)

    const { display, commands } = press(Display.initial, { _tag: "StepPick", step: 1 }, stage)

    assert.strictEqual(display.pick, StripCard.nextPick(cards, undefined, 1))
    assert.deepStrictEqual(commands, [])
  })

  it("should move the pick back with StepPick as StripCard.nextPick does", () => {
    const stage = withTiles(["soon", undefined, undefined, undefined, "done"])
    const cards = StripCard.of(stage, slate)
    const first = press(Display.initial, { _tag: "StepPick", step: 1 }, stage).display

    const { display } = press(first, { _tag: "StepPick", step: -1 }, stage)

    assert.strictEqual(display.pick, StripCard.nextPick(cards, first.pick, -1))
  })

  it("should drop the picked card with DropPick as drop does", () => {
    const stage = withTiles(["soon"])
    const picked = press(Display.initial, { _tag: "StepPick", step: 1 }, stage).display
    const free = cardOf(stage, 0)

    const step = press(picked, { _tag: "DropPick" }, stage)

    assert.deepStrictEqual(step, picked.drop(free, stage))
  })

  it("should do nothing with DropPick and no pick", () => {
    const { display, commands } = press(Display.initial, { _tag: "DropPick" }, withTiles([]))

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [])
  })

  it("should toggle the slate with ToggleSlate as toggleSlate does", () => {
    const { display, commands } = press(Display.initial, { _tag: "ToggleSlate" }, withTiles([]))

    assert.isFalse(display.slateOpen)
    assert.deepStrictEqual(display, Display.initial.toggleSlate())
    assert.deepStrictEqual(commands, [])
  })

  it("should open a closed slate with ToggleSlate", () => {
    const closed = Display.initial.toggleSlate()

    const { display, commands } = press(closed, { _tag: "ToggleSlate" }, withTiles([]))

    assert.isTrue(display.slateOpen)
    assert.deepStrictEqual(commands, [])
  })

  it("should open the key help with ShowKeys", () => {
    const { display, commands } = press(Display.initial, { _tag: "ShowKeys" }, withTiles([]))

    assert.strictEqual(display.overlay._tag, "Keys")
    assert.deepStrictEqual(commands, [])
  })

  it("should close the key help with ShowKeys when it was open", () => {
    const stage = withTiles([])
    const open = press(Display.initial, { _tag: "ShowKeys" }, stage).display

    const { display } = press(open, { _tag: "ShowKeys" }, stage)

    assert.strictEqual(display.overlay._tag, "None")
  })

  it("should replace the palette with the key help with ShowKeys", () => {
    const palette = Display.initial.open("Palette")

    const { display, commands } = press(palette, { _tag: "ShowKeys" }, withTiles([]))

    assert.strictEqual(display.overlay._tag, "Keys")
    assert.deepStrictEqual(commands, [])
  })

  it("should open the palette with CommandPalette, replacing the key help", () => {
    const keys = Display.initial.open("Keys")

    const { display, commands } = press(keys, { _tag: "CommandPalette" }, withTiles([]))

    assert.strictEqual(display.overlay._tag, "Palette")
    assert.deepStrictEqual(commands, [])
  })

  it("should close the palette with CommandPalette when it was open", () => {
    const stage = withTiles([])
    const open = press(Display.initial.open("Keys"), { _tag: "CommandPalette" }, stage).display

    const { display } = press(open, { _tag: "CommandPalette" }, stage)

    assert.strictEqual(display.overlay._tag, "None")
  })

  it.each<{ hotkey: Parameters<Display["press"]>[0]; command: StageCommand }>([
    { hotkey: { _tag: "FocusAudio", slot: 1 }, command: { _tag: "FocusAudio", tile: 1 } },
    { hotkey: { _tag: "Promote", slot: 1 }, command: { _tag: "Promote", tile: 1 } },
    { hotkey: { _tag: "NextLayout" }, command: { _tag: "SetLayout", layout: "MainThree" } }
  ])("should send $hotkey._tag's command and change nothing", ({ hotkey, command }) => {
    const stage = withTiles(["live", "soon"])

    const { display, commands } = press(Display.initial, hotkey, stage)

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [command])
  })

  it("should return the same display with FullScreen and send nothing", () => {
    const { display, commands } = press(Display.initial, { _tag: "FullScreen" }, withTiles([]))

    assert.strictEqual(display, Display.initial)
    assert.deepStrictEqual(commands, [])
  })
})

describe("Display#open and Display#close", () => {
  it.each([
    { from: "Keys", to: "Palette" },
    { from: "Palette", to: "JoinRemote" }
  ] as const)("should replace any open overlay: $to over $from", ({ from, to }) => {
    const open = Display.initial.open(from)

    const display = open.open(to)

    assert.strictEqual(display.overlay._tag, to)
  })

  it("should close the open overlay", () => {
    const open = Display.initial.open("JoinRemote")

    const display = open.close()

    assert.strictEqual(display.overlay._tag, "None")
  })
})

function press(display: Display, hotkey: Parameters<Display["press"]>[0], stage: Stage) {
  return display.press(hotkey, stage, StripCard.of(stage, slate))
}

/** The strip card at `index` on `stage`; a test that asks for one past the strip fails here. */
function cardOf(stage: Stage, index: number) {
  const card = StripCard.of(stage, slate)[index]
  if (card === undefined) throw new Error(`no strip card at ${index}`)
  return card
}
