import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Stage } from "@sportal/domain/Stage"
import { snapshot } from "@sportal/domain/TestGame"
import { DateTime } from "effect"
import { Display } from "./Display.ts"
import { nextPick, stripCards } from "./slate/StripCards.ts"

const live = snapshot({ id: GameId.make("live"), status: "live" })
const later = snapshot({
  id: GameId.make("later"),
  kickoff: DateTime.makeUnsafe("2026-10-03T20:00:00Z")
})
const soon = snapshot({ id: GameId.make("soon") })
const done = snapshot({ id: GameId.make("done"), status: "final" })
const slate = [done, later, live, soon]

describe("Display", () => {
  it("starts on slot 0, with nothing interacting or picked, the slate open, and no overlay", () => {
    const display = Display.initial
    assert.strictEqual(display.selected, 0)
    assert.isUndefined(display.interacting)
    assert.isUndefined(display.pick)
    assert.isTrue(display.slateOpen)
    assert.strictEqual(display.overlay._tag, "None")
  })

  describe("select", () => {
    it("selects a slot on stage and sends nothing", () => {
      const { display, commands } = Display.initial.select(2, withTiles([]))
      assert.strictEqual(display.selected, 2)
      assert.deepStrictEqual(commands, [])
    })

    it("ends interacting when another slot is selected, and keeps it when the same slot is", () => {
      const stage = withTiles(["live", "soon"])
      const interacting = press(Display.initial, { _tag: "Interact" }, stage).display
      assert.strictEqual(interacting.select(0, stage).display.interactingOn(stage), "live")
      const moved = interacting.select(1, stage).display
      assert.isUndefined(moved.interacting)
      assert.isUndefined(moved.select(0, stage).display.interactingOn(stage))
    })

    it("ignores a slot past the last", () => {
      const stage = withTiles([])
      const { display, commands } = Display.initial.select(4, stage)
      assert.strictEqual(display, Display.initial)
      assert.deepStrictEqual(commands, [])
    })
  })

  describe("selectedOn and interactingOn", () => {
    it("reads the last slot once the layout has fewer, and a drop then assigns into it", () => {
      const quad = withTiles([])
      const selected = Display.initial.select(3, quad).display
      const single = new Stage({ ...quad, layout: "Single" })
      assert.strictEqual(selected.selectedOn(single), 0)
      const [free] = stripCards(single, slate)
      assert.deepStrictEqual(free && selected.drop(free, single).commands, [
        { _tag: "Assign", tile: 0, game: GameId.make("live") }
      ])
    })

    it("reads interacting as none once a swap moves another game into the selected slot", () => {
      const before = withTiles(["live", "soon"])
      const display = press(Display.initial, { _tag: "Interact" }, before).display
      assert.strictEqual(display.interactingOn(before), "live")
      assert.isUndefined(display.interactingOn(withTiles(["soon", "live"])))
    })
  })

  describe("drop", () => {
    it("assigns a free game into the selected slot, picks it, and selects the next empty slot", () => {
      const stage = withTiles(["soon"])
      const [free] = stripCards(stage, slate)
      const dropped = free && Display.initial.drop(free, stage)
      assert.deepStrictEqual(dropped?.commands, [{ _tag: "Assign", tile: 0, game: GameId.make("live") }])
      assert.strictEqual(dropped?.display.pick, "live")
      assert.strictEqual(dropped?.display.selected, 1)
    })

    it("swaps a benched game into the selected slot and selects the next empty slot", () => {
      const stage = withTiles(["soon", undefined, undefined, undefined, "done"])
      const [bench] = stripCards(stage, slate)
      const selected = Display.initial.select(2, stage).display
      const dropped = bench && selected.drop(bench, stage)
      assert.deepStrictEqual(dropped?.commands, [{ _tag: "Swap", a: 4, b: 2 }])
      assert.strictEqual(dropped?.display.pick, "done")
      assert.strictEqual(dropped?.display.selected, 3)
    })

    it("does nothing with a game already on stage", () => {
      const stage = withTiles(["soon", undefined, undefined, undefined, "done"])
      const onStage = stripCards(stage, slate)[2]
      const dropped = onStage && Display.initial.drop(onStage, stage)
      assert.strictEqual(dropped?.display, Display.initial)
      assert.deepStrictEqual(dropped?.commands, [])
    })

    it("assigns a free game, swaps a benched one in, and does nothing with a game on stage", () => {
      const stage = withTiles(["soon", undefined, undefined, undefined, "done"])
      const [bench, free, onStage] = stripCards(stage, slate)
      const selected = Display.initial.select(2, stage).display
      assert.deepStrictEqual(free && selected.drop(free, stage).commands, [
        { _tag: "Assign", tile: 2, game: GameId.make("live") }
      ])
      assert.deepStrictEqual(bench && selected.drop(bench, stage).commands, [{ _tag: "Swap", a: 4, b: 2 }])
      assert.deepStrictEqual(onStage && selected.drop(onStage, stage).commands, [])
    })

    it("selects the next empty slot after the drop, or keeps the selection when none is left", () => {
      const stage = withTiles(["soon", undefined, undefined, undefined])
      const [free] = stripCards(stage, slate)
      assert.strictEqual(
        free && Display.initial.select(1, stage).display.drop(free, stage).display.selected,
        2
      )
      const full = withTiles(["soon", "later", undefined, "done"])
      const [left] = stripCards(full, slate)
      assert.strictEqual(left && Display.initial.select(2, full).display.drop(left, full).display.selected, 2)
    })

    it("ends interacting when the drop moves the selection", () => {
      const stage = withTiles(["soon"])
      const interacting = press(Display.initial, { _tag: "Interact" }, stage).display
      const [free] = stripCards(stage, slate)
      assert.isUndefined(free && interacting.drop(free, stage).display.interacting)
    })
  })

  describe("press", () => {
    it("SelectTile selects as select does, past the last slot too", () => {
      const stage = withTiles(["live", "soon"])
      const interacting = press(Display.initial, { _tag: "Interact" }, stage).display
      const { display, commands } = press(interacting, { _tag: "SelectTile", slot: 1 }, stage)
      assert.strictEqual(display.selected, 1)
      assert.isUndefined(display.interacting)
      assert.deepStrictEqual(commands, [])
      assert.strictEqual(press(interacting, { _tag: "SelectTile", slot: 8 }, stage).display, interacting)
    })

    it("ToggleSolo solos the selected slot, or unsolos while soloed", () => {
      const stage = withTiles(["live", "soon"])
      const selected = Display.initial.select(1, stage).display
      const solo = press(selected, { _tag: "ToggleSolo" }, stage)
      assert.strictEqual(solo.display, selected)
      assert.deepStrictEqual(solo.commands, [{ _tag: "Solo", tile: 1 }])
      const soloed = new Stage({ ...stage, solo: GameId.make("soon") })
      assert.deepStrictEqual(press(selected, { _tag: "ToggleSolo" }, soloed).commands, [{ _tag: "Unsolo" }])
    })

    it("ToggleSolo solos the last slot once the layout has fewer", () => {
      const quad = withTiles(["live"])
      const selected = Display.initial.select(3, quad).display
      const single = new Stage({ ...quad, layout: "Single" })
      assert.deepStrictEqual(press(selected, { _tag: "ToggleSolo" }, single).commands, [
        { _tag: "Solo", tile: 0 }
      ])
    })

    it("Esc with the key help open closes it and sends no Unsolo, even while soloed", () => {
      const soloed = new Stage({ ...withTiles(["live"]), solo: GameId.make("live") })
      const keys = Display.initial.open("Keys")
      const { display, commands } = press(keys, { _tag: "Unsolo" }, soloed)
      assert.strictEqual(display.overlay._tag, "None")
      assert.deepStrictEqual(commands, [])
    })

    it("Esc with no overlay unsolos while soloed, and otherwise does nothing", () => {
      const stage = withTiles(["live"])
      const soloed = new Stage({ ...stage, solo: GameId.make("live") })
      const unsolo = press(Display.initial, { _tag: "Unsolo" }, soloed)
      assert.strictEqual(unsolo.display, Display.initial)
      assert.deepStrictEqual(unsolo.commands, [{ _tag: "Unsolo" }])
      const idle = press(Display.initial, { _tag: "Unsolo" }, stage)
      assert.strictEqual(idle.display, Display.initial)
      assert.deepStrictEqual(idle.commands, [])
    })

    it("Interact interacts with the selected slot's stream, or ends it when it was on", () => {
      const stage = withTiles(["live"])
      const on = press(Display.initial, { _tag: "Interact" }, stage)
      assert.strictEqual(on.display.interactingOn(stage), "live")
      assert.deepStrictEqual(on.commands, [])
      assert.isUndefined(press(on.display, { _tag: "Interact" }, stage).display.interactingOn(stage))
    })

    it("Interact does nothing on a tile with no stream", () => {
      const empty = withTiles([])
      assert.strictEqual(press(Display.initial, { _tag: "Interact" }, empty).display, Display.initial)
      const data = new Stage({
        ...Stage.initial,
        tiles: [{ _tag: "DataTile", game: GameId.make("live"), why: { _tag: "NoStream" } }]
      })
      assert.strictEqual(press(Display.initial, { _tag: "Interact" }, data).display, Display.initial)
    })

    it("StepPick moves the pick as nextPick does", () => {
      const stage = withTiles(["soon", undefined, undefined, undefined, "done"])
      const cards = stripCards(stage, slate)
      const first = press(Display.initial, { _tag: "StepPick", step: 1 }, stage)
      assert.strictEqual(first.display.pick, nextPick(cards, undefined, 1))
      assert.deepStrictEqual(first.commands, [])
      const second = press(first.display, { _tag: "StepPick", step: -1 }, stage)
      assert.strictEqual(second.display.pick, nextPick(cards, first.display.pick, -1))
    })

    it("DropPick drops the picked card as drop does", () => {
      const stage = withTiles(["soon"])
      const picked = press(Display.initial, { _tag: "StepPick", step: 1 }, stage).display
      const [free] = stripCards(stage, slate)
      assert.deepStrictEqual(press(picked, { _tag: "DropPick" }, stage), free && picked.drop(free, stage))
    })

    it("DropPick with no pick does nothing", () => {
      const { display, commands } = press(Display.initial, { _tag: "DropPick" }, withTiles([]))
      assert.strictEqual(display, Display.initial)
      assert.deepStrictEqual(commands, [])
    })

    it("ToggleSlate toggles the slate as toggleSlate does", () => {
      const { display, commands } = press(Display.initial, { _tag: "ToggleSlate" }, withTiles([]))
      assert.isFalse(display.slateOpen)
      assert.deepStrictEqual(display, Display.initial.toggleSlate())
      assert.deepStrictEqual(commands, [])
    })

    it("ShowKeys opens the key help, or closes it when it was open", () => {
      const stage = withTiles([])
      const open = press(Display.initial, { _tag: "ShowKeys" }, stage)
      assert.strictEqual(open.display.overlay._tag, "Keys")
      assert.deepStrictEqual(open.commands, [])
      assert.strictEqual(press(open.display, { _tag: "ShowKeys" }, stage).display.overlay._tag, "None")
    })

    it("CommandPalette opens the palette, replacing the key help, or closes it when it was open", () => {
      const stage = withTiles([])
      const open = press(Display.initial.open("Keys"), { _tag: "CommandPalette" }, stage)
      assert.strictEqual(open.display.overlay._tag, "Palette")
      assert.deepStrictEqual(open.commands, [])
      assert.strictEqual(press(open.display, { _tag: "CommandPalette" }, stage).display.overlay._tag, "None")
    })

    it("FocusAudio, Promote, and NextLayout send their commands and change nothing", () => {
      const stage = withTiles(["live", "soon"])
      const focus = press(Display.initial, { _tag: "FocusAudio", slot: 1 }, stage)
      assert.strictEqual(focus.display, Display.initial)
      assert.deepStrictEqual(focus.commands, [{ _tag: "FocusAudio", tile: 1 }])
      const promote = press(Display.initial, { _tag: "Promote", slot: 1 }, stage)
      assert.strictEqual(promote.display, Display.initial)
      assert.deepStrictEqual(promote.commands, [{ _tag: "Promote", tile: 1 }])
      const layout = press(Display.initial, { _tag: "NextLayout" }, stage)
      assert.strictEqual(layout.display, Display.initial)
      assert.deepStrictEqual(layout.commands, [{ _tag: "SetLayout", layout: "MainThree" }])
    })

    it("FullScreen returns the same display and sends nothing", () => {
      const { display, commands } = press(Display.initial, { _tag: "FullScreen" }, withTiles([]))
      assert.strictEqual(display, Display.initial)
      assert.deepStrictEqual(commands, [])
    })
  })

  describe("overlays", () => {
    it("open replaces any open overlay, so opening the palette over the key help leaves only the palette", () => {
      assert.strictEqual(Display.initial.open("Keys").open("Palette").overlay._tag, "Palette")
      assert.strictEqual(Display.initial.open("Palette").open("JoinRemote").overlay._tag, "JoinRemote")
    })

    it("close closes the open overlay", () => {
      assert.strictEqual(Display.initial.open("JoinRemote").close().overlay._tag, "None")
    })
  })
})

function press(display: Display, hotkey: Parameters<Display["press"]>[0], stage: Stage) {
  return display.press(hotkey, stage, stripCards(stage, slate))
}

/** A Quad with these games streaming in its tiles, in order; past the fourth they are benched. */
function withTiles(games: ReadonlyArray<string | undefined>) {
  const tiles = games.map((game) =>
    game === undefined
      ? { _tag: "Empty" as const }
      : {
          _tag: "StreamTile" as const,
          game: GameId.make(game),
          channel: {
            name: game,
            source: "Scenario" as const,
            locator: { _tag: "WebView" as const, url: `https://example.test/${game}` }
          }
        }
  )
  return new Stage({ ...Stage.initial, tiles: [...tiles, ...Stage.initial.tiles.slice(tiles.length)] })
}
