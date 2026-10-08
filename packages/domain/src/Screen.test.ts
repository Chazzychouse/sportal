import { assert, describe, it } from "@effect/vitest"
import { DateTime, Option, Result, Schema } from "effect"
import { ChannelAvailability } from "./Channel.ts"
import { GameId } from "./Game.ts"
import { type LayoutName, Screen, ScreenCommand, Tile } from "./Screen.ts"
import { assign, bama, fill, foxChannel, irish, nowhere, onFox } from "./TestScreen.ts"

const usc = GameId.make("401856800")
const ohio = GameId.make("401858473")
const noGuide = () => ChannelAvailability.NoGuide({ source: "YouTube TV" })

describe("Screen#apply", () => {
  it("should assign a carried game as a stream tile", () => {
    const screen = assign(Screen.initial, 1, bama, onFox)

    assert.deepStrictEqual(screen.tiles[1], {
      _tag: "StreamTile",
      game: bama,
      channel: foxChannel
    })
  })

  it("should assign a game that is not carried as a data tile", () => {
    const screen = assign(Screen.initial, 0, bama, nowhere)

    assert.deepStrictEqual(screen.tiles[0], { _tag: "DataTile", game: bama, why: { _tag: "NoStream" } })
  })

  it("should assign a game its source has no guide for as a data tile saying so", () => {
    const screen = assign(Screen.initial, 0, bama, noGuide)

    assert.deepStrictEqual(screen.tiles[0], { _tag: "DataTile", game: bama, why: { _tag: "NoGuide" } })
  })

  it("should replace whatever an occupied tile held", () => {
    const first = assign(Screen.initial, 0, bama, onFox)

    const second = assign(first, 0, irish, nowhere)

    assert.deepStrictEqual(second.tiles[0], { _tag: "DataTile", game: irish, why: { _tag: "NoStream" } })
  })

  it("should move a game rather than show it twice", () => {
    const first = assign(Screen.initial, 0, bama, onFox)

    const second = assign(first, 2, bama, onFox)

    assert.strictEqual(second.tiles[0]?._tag, "Empty")
    assert.strictEqual(second.tiles[2]?._tag, "StreamTile")
  })

  it("should re-resolve a moved game, so a game that lost its stream moves as a data tile", () => {
    const first = assign(Screen.initial, 0, bama, onFox)

    const second = assign(first, 1, bama, nowhere)

    assert.strictEqual(second.tiles[0]?._tag, "Empty")
    assert.deepStrictEqual(second.tiles[1], { _tag: "DataTile", game: bama, why: { _tag: "NoStream" } })
  })

  it("should clear a tile and leave the others", () => {
    const screen = fill([bama, irish])

    const cleared = run(screen, { _tag: "Clear", tile: 0 })

    assert.strictEqual(cleared.tiles[0]?._tag, "Empty")
    assert.strictEqual(cleared.tiles[1]?._tag, "StreamTile")
  })

  it("should give audio to the first game on screen when no game has it", () => {
    const screen = assign(Screen.initial, 2, bama, onFox)

    assert.deepStrictEqual(screen.audioFocus, Option.some(bama))
  })

  it("should move audio focus to a tile's game", () => {
    const two = fill([bama, irish])

    const focused = run(two, { _tag: "FocusAudio", tile: 1 })

    assert.deepStrictEqual(focused.audioFocus, Option.some(irish))
  })

  it("should keep audio focus where it is when another game is assigned", () => {
    const focused = run(fill([bama, irish]), { _tag: "FocusAudio", tile: 1 })

    const assigned = assign(focused, 2, usc, onFox)

    assert.deepStrictEqual(assigned.audioFocus, Option.some(irish))
  })

  it("should move audio to the main tile's game when the focused game is cleared", () => {
    const focused = run(fill([bama, irish]), { _tag: "FocusAudio", tile: 1 })

    const cleared = run(focused, { _tag: "Clear", tile: 1 })

    assert.deepStrictEqual(cleared.audioFocus, Option.some(bama))
  })

  it("should reject audio for an empty tile", () => {
    const reason = rejection(Screen.initial, { _tag: "FocusAudio", tile: 3 })

    assert.strictEqual(reason, "empty-tile")
  })

  it("should reject audio for a tile that does not exist, saying why", () => {
    const reason = rejection(Screen.initial, { _tag: "FocusAudio", tile: 4 })

    assert.strictEqual(reason, "no-such-tile")
  })

  it("should reject a swap with a tile that does not exist, saying why", () => {
    const reason = rejection(Screen.initial, { _tag: "Swap", a: 0, b: 4 })

    assert.strictEqual(reason, "no-such-tile")
  })

  it("should assign a game still to come as a data tile saying where and when", () => {
    const begin = DateTime.makeUnsafe("2026-10-04T17:00:00Z")

    const screen = assign(Screen.initial, 0, bama, () =>
      ChannelAvailability.Upcoming({ channel: Option.some("NFL ST - CBS"), begin: Option.some(begin) })
    )

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: bama,
      why: { _tag: "NotYet", channel: Option.some("NFL ST - CBS"), begin: Option.some(begin) }
    })
  })

  it("should assign a game whose time and channel are unknown as a data tile with neither", () => {
    const screen = assign(Screen.initial, 0, bama, unknownUpcoming)

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: bama,
      why: { _tag: "NotYet", channel: Option.none(), begin: Option.none() }
    })
  })

  it("should say why a game is not carried", () => {
    const screen = assign(Screen.initial, 0, bama, () =>
      ChannelAvailability.NotCarried({ why: "StreamingOnly" })
    )

    assert.deepStrictEqual(screen.tiles[0], { _tag: "DataTile", game: bama, why: { _tag: "StreamingOnly" } })
  })
})

describe("Screen#refresh", () => {
  it("should return the same Screen when no tile changes", () => {
    const screen = assign(Screen.initial, 0, bama, noGuide)

    const refreshed = screen.refresh(() => Option.some(noGuide()))

    assert.strictEqual(refreshed, screen)
  })

  it("should re-resolve only the tiles whose game has an availability to report", () => {
    const streaming = assign(fill([bama]), 1, irish, nowhere)

    const refreshed = streaming.refresh(reportingOnly(irish))

    assert.deepStrictEqual(refreshed.tiles[0], streaming.tiles[0])
    assert.deepStrictEqual(refreshed.tiles[1], {
      _tag: "StreamTile",
      game: irish,
      channel: foxChannel
    })
  })

  it("should leave empty tiles empty", () => {
    const screen = assign(assign(Screen.initial, 0, bama, nowhere), 1, irish, onFox)

    const refreshed = screen.refresh(some(onFox))

    assert.deepStrictEqual(
      refreshed.tiles.map((tile) => tile._tag),
      ["StreamTile", "StreamTile", "Empty", "Empty"]
    )
  })

  it("should leave audio focus where it was", () => {
    const focused = run(fill([bama, irish]), { _tag: "FocusAudio", tile: 1 })

    const refreshed = focused.refresh(some(onFox))

    assert.deepStrictEqual(refreshed.audioFocus, Option.some(irish))
  })

  it("should re-resolve benched tiles too", () => {
    const benched = run(assign(fill([bama]), 1, irish, nowhere), { _tag: "SetLayout", layout: "Single" })

    const refreshed = benched.refresh(some(onFox))

    assert.strictEqual(refreshed.tiles[1]?._tag, "StreamTile")
  })

  it.each([
    ["no guide", noGuide()],
    ["no stream", nowhere()],
    ["streaming only", ChannelAvailability.NotCarried({ why: "StreamingOnly" })],
    ["not in the guide", ChannelAvailability.NotCarried({ why: "NotInGuide" })],
    [
      "an upcoming game",
      ChannelAvailability.Upcoming({
        channel: Option.some("FOX 43"),
        begin: Option.some(DateTime.makeUnsafe("2026-10-04T17:00:00Z"))
      })
    ],
    ["the same channel", onFox()]
  ])("should keep a stream tile playing on the answer %s", (_name, answer) => {
    const streaming = assign(Screen.initial, 0, bama, onFox)

    const refreshed = streaming.refresh(() => Option.some(answer))

    assert.deepStrictEqual(refreshed.tiles[0], streaming.tiles[0])
  })

  it("should turn a no-guide data tile into a stream once the guide carries its game", () => {
    const waiting = assign(Screen.initial, 0, bama, noGuide)

    const refreshed = waiting.refresh(some(onFox))

    assert.deepStrictEqual(refreshed.tiles[0], { _tag: "StreamTile", game: bama, channel: foxChannel })
  })

  it("should move a stream tile to the channel a later guide carries it on", () => {
    const streaming = assign(Screen.initial, 0, bama, onFox)
    const elsewhere = {
      ...foxChannel,
      name: "FOX 43",
      locator: { ...foxChannel.locator, url: "https://tv.youtube.com/watch/fox43" }
    }

    const moved = streaming.refresh(some(() => ChannelAvailability.Carried({ channel: elsewhere })))

    assert.deepStrictEqual(moved.tiles[0], { _tag: "StreamTile", game: bama, channel: elsewhere })
  })

  it("should re-resolve a data tile whose game has left the guide", () => {
    const waiting = assign(Screen.initial, 0, bama, unknownUpcoming)

    const refreshed = waiting.refresh(some(() => ChannelAvailability.NotCarried({ why: "NotInGuide" })))

    assert.deepStrictEqual(refreshed.tiles[0], { _tag: "DataTile", game: bama, why: { _tag: "NotInGuide" } })
  })
})

describe("Screen layouts and the bench", () => {
  it("should start as an empty Quad", () => {
    assert.strictEqual(Screen.initial.layout, "Quad")
    assert.strictEqual(Screen.initial.tiles.length, 4)
  })

  it("should start with default splits", () => {
    assert.deepStrictEqual(Screen.initial.splits.MainFive, { x: 2 / 3, y: 2 / 3 })
  })

  it("should encode the initial Screen as it always has", () => {
    const encoded = JSON.stringify(Schema.encodeSync(Screen)(Screen.initial))

    assert.strictEqual(
      encoded,
      JSON.stringify({
        tiles: [{ _tag: "Empty" }, { _tag: "Empty" }, { _tag: "Empty" }, { _tag: "Empty" }],
        layout: "Quad",
        splits: {
          Single: { x: 0.5, y: 0.5 },
          Pair: { x: 0.5, y: 0.5 },
          Quad: { x: 0.5, y: 0.5 },
          MainThree: { x: 0.75, y: 0.5 },
          MainFive: { x: 2 / 3, y: 2 / 3 }
        }
      })
    )
  })

  it("should bench the tiles that no longer fit", () => {
    const full = fill([bama, irish, usc, ohio])

    const pair = run(full, { _tag: "SetLayout", layout: "Pair" })

    assert.deepStrictEqual(pair.onScreen().map(gameOf), [bama, irish])
    assert.deepStrictEqual(pair.tiles.map(gameOf), [bama, irish, usc, ohio])
  })

  it("should bring the benched tiles back in order", () => {
    const full = fill([bama, irish, usc, ohio])
    const pair = run(full, { _tag: "SetLayout", layout: "Pair" })

    const quad = run(pair, { _tag: "SetLayout", layout: "Quad" })

    assert.deepStrictEqual(quad.tiles, full.tiles)
  })

  it("should pad a growing layout with empty tiles", () => {
    const one = fill([bama])

    const five = run(one, { _tag: "SetLayout", layout: "MainFive" })

    assert.strictEqual(five.tiles.length, 6)
  })

  it("should trim empties off the end of the bench", () => {
    const five = run(fill([bama]), { _tag: "SetLayout", layout: "MainFive" })

    const single = run(five, { _tag: "SetLayout", layout: "Single" })

    assert.strictEqual(single.tiles.length, 1)
  })

  it("should keep holes in the bench, so a layout that grows back restores every place", () => {
    const holed = fill([bama, irish, undefined, ohio])

    const single = run(holed, { _tag: "SetLayout", layout: "Single" })

    assert.deepStrictEqual(single.tiles.map(gameOf), [bama, irish, undefined, ohio])
  })

  it("should move audio off a benched game to the main tile's game", () => {
    const focused = run(fill([bama, irish]), { _tag: "FocusAudio", tile: 1 })

    const single = run(focused, { _tag: "SetLayout", layout: "Single" })

    assert.deepStrictEqual(single.audioFocus, Option.some(bama))
  })

  it("should keep a game in one tile across screen and bench", () => {
    const benched = run(fill([bama, irish]), { _tag: "SetLayout", layout: "Single" })

    const assigned = assign(benched, 0, irish, onFox)

    assert.deepStrictEqual(assigned.tiles.map(gameOf), [irish])
  })

  it("should reject audio for a benched tile", () => {
    const benched = run(fill([bama, irish]), { _tag: "SetLayout", layout: "Single" })

    const reason = rejection(benched, { _tag: "FocusAudio", tile: 1 })

    assert.strictEqual(reason, "offscreen-tile")
  })

  it("should reject solo for a benched tile", () => {
    const benched = run(fill([bama, irish]), { _tag: "SetLayout", layout: "Single" })

    const reason = rejection(benched, { _tag: "Solo", tile: 1 })

    assert.strictEqual(reason, "offscreen-tile")
  })

  it("should set the current layout's split and remember each layout's own", () => {
    const moved = run(Screen.initial, { _tag: "SetSplit", split: { x: 0.3, y: 0.7 } })

    assert.deepStrictEqual(moved.splits.Quad, { x: 0.3, y: 0.7 })
    assert.deepStrictEqual(moved.splits[moved.layout], { x: 0.3, y: 0.7 })
    assert.deepStrictEqual(moved.splits.Pair, Screen.initial.splits.Pair)
  })
})

describe("Screen#apply SetSplit", () => {
  it.each([
    { x: 0.2, y: 0.8 },
    { x: 0.8, y: 0.2 }
  ])("should accept a split at the bounds: $x,$y", (split) => {
    const moved = run(Screen.initial, { _tag: "SetSplit", split })

    assert.deepStrictEqual(moved.splits.Quad, split)
  })

  it.each([
    { x: 0.1, y: 0.5 },
    { x: 0.19, y: 0.5 },
    { x: 0.5, y: 0.19 }
  ])("should reject a split below them: $x,$y", (split) => {
    const reason = rejection(Screen.initial, { _tag: "SetSplit", split })

    assert.strictEqual(reason, "split-out-of-range")
  })

  it.each([
    { x: 0.81, y: 0.5 },
    { x: 0.5, y: 0.81 }
  ])("should reject a split above them: $x,$y", (split) => {
    const reason = rejection(Screen.initial, { _tag: "SetSplit", split })

    assert.strictEqual(reason, "split-out-of-range")
  })
})

describe("Screen.slotCount", () => {
  it.each<[LayoutName, number]>([
    ["Single", 1],
    ["Pair", 2],
    ["Quad", 4],
    ["MainThree", 4],
    ["MainFive", 6]
  ])("should give %s a slot count of %i", (name, slots) => {
    const count = Screen.slotCount(name)

    assert.strictEqual(count, slots)
  })
})

describe("Screen.splitBounds", () => {
  it("should keep dividers between 0.2 and 0.8", () => {
    const bounds = Screen.splitBounds

    assert.deepStrictEqual(bounds, { min: 0.2, max: 0.8 })
  })
})

describe("Screen#hears and Screen#soloes", () => {
  const screen = run(run(fill([bama, irish]), { _tag: "Solo", tile: 0 }), { _tag: "FocusAudio", tile: 1 })

  it("should hear the on-air game", () => {
    assert.isTrue(screen.hears(irish))
  })

  it("should not hear the soloed game when another is on air", () => {
    assert.isFalse(screen.hears(bama))
  })

  it("should solo the soloed game", () => {
    assert.isTrue(screen.soloes(bama))
  })

  it("should not solo the game on air", () => {
    assert.isFalse(screen.soloes(irish))
  })

  it("should not hear a game in no tile", () => {
    assert.isFalse(screen.hears(usc))
  })

  it("should not solo a game in no tile", () => {
    assert.isFalse(screen.soloes(usc))
  })
})

describe("Screen#withSplit", () => {
  it("should replace only the current layout's split", () => {
    const moved = Screen.initial.withSplit({ x: 0.3, y: 0.7 })

    assert.deepStrictEqual(moved.splits.Quad, { x: 0.3, y: 0.7 })
    assert.deepStrictEqual(moved.splits.Pair, Screen.initial.splits.Pair)
    assert.strictEqual(moved.layout, "Quad")
    assert.deepStrictEqual(moved.tiles, Screen.initial.tiles)
  })
})

describe("Screen#benched", () => {
  it("should be empty for an empty screen", () => {
    assert.deepStrictEqual(Screen.initial.benched(), [])
  })

  it("should be empty when every game fits the layout", () => {
    const full = fill([bama, irish, usc, ohio])

    assert.deepStrictEqual(full.benched(), [])
  })

  it("should list the games a shrunk layout benched, with their tiles", () => {
    const pair = run(fill([bama, irish, usc, ohio]), { _tag: "SetLayout", layout: "Pair" })

    assert.deepStrictEqual(pair.benched(), [
      { tile: 2, game: usc },
      { tile: 3, game: ohio }
    ])
  })

  it("should skip the empty tiles past the slots", () => {
    const single = run(fill([bama, irish, undefined, ohio]), { _tag: "SetLayout", layout: "Single" })

    assert.deepStrictEqual(single.benched(), [
      { tile: 1, game: irish },
      { tile: 3, game: ohio }
    ])
  })
})

describe("Screen#nextEmptySlot", () => {
  const holes = fill([undefined, bama, undefined, irish])

  it("should be the first empty slot after the given one", () => {
    assert.strictEqual(holes.nextEmptySlot(0), 2)
  })

  it("should wrap to the first empty slot", () => {
    assert.strictEqual(holes.nextEmptySlot(3), 0)
  })

  it("should never be the slot itself", () => {
    assert.strictEqual(holes.nextEmptySlot(2), 0)
  })

  it("should be none when every other slot is filled", () => {
    const screen = fill([undefined, bama, irish, usc])

    assert.isUndefined(screen.nextEmptySlot(0))
  })

  it("should ignore the bench", () => {
    const pair = run(fill([bama, irish, undefined, undefined]), { _tag: "SetLayout", layout: "Pair" })

    assert.isUndefined(pair.nextEmptySlot(0))
  })
})

describe("Screen swap and promote", () => {
  it("should swap two tiles on screen", () => {
    const three = fill([bama, irish, usc])

    const swapped = run(three, { _tag: "Swap", a: 0, b: 2 })

    assert.deepStrictEqual(swapped.tiles.map(gameOf), [usc, irish, bama, undefined])
  })

  it("should swap a benched tile onto the screen", () => {
    const benched = run(fill([bama, irish, usc]), { _tag: "SetLayout", layout: "Pair" })

    const swapped = run(benched, { _tag: "Swap", a: 1, b: 2 })

    assert.deepStrictEqual(swapped.onScreen().map(gameOf), [bama, usc])
  })

  it("should keep audio with its game through a swap", () => {
    const swapped = run(fill([bama, irish]), { _tag: "Swap", a: 0, b: 1 })

    assert.deepStrictEqual(swapped.audioFocus, Option.some(bama))
  })

  it("should promote a tile into the main tile and give it audio", () => {
    const screen = fill([bama, undefined, undefined, irish])

    const promoted = run(screen, { _tag: "Promote", tile: 3 })

    assert.deepStrictEqual(promoted.tiles.map(gameOf), [irish, undefined, undefined, bama])
    assert.deepStrictEqual(promoted.audioFocus, Option.some(irish))
  })

  it("should promote a benched game", () => {
    const benched = run(fill([bama, irish]), { _tag: "SetLayout", layout: "Single" })

    const promoted = run(benched, { _tag: "Promote", tile: 1 })

    assert.deepStrictEqual(promoted.onScreen().map(gameOf), [irish])
  })

  it("should reject promoting an empty tile", () => {
    const reason = rejection(Screen.initial, { _tag: "Promote", tile: 1 })

    assert.strictEqual(reason, "empty-tile")
  })
})

describe("Screen solo", () => {
  it("should solo a tile's game and give it audio", () => {
    const solo = run(fill([bama, irish]), { _tag: "Solo", tile: 1 })

    assert.deepStrictEqual(solo.solo, Option.some(irish))
    assert.deepStrictEqual(solo.audioFocus, Option.some(irish))
  })

  it("should follow its game through a swap", () => {
    const solo = run(fill([bama, irish]), { _tag: "Solo", tile: 1 })

    const swapped = run(solo, { _tag: "Swap", a: 0, b: 1 })

    assert.deepStrictEqual(swapped.solo, Option.some(irish))
  })

  it("should end when the game is cleared", () => {
    const solo = run(fill([bama, irish]), { _tag: "Solo", tile: 1 })

    const cleared = run(solo, { _tag: "Clear", tile: 1 })

    assert.isTrue(Option.isNone(cleared.solo))
  })

  it("should end when the game is benched", () => {
    const solo = run(fill([bama, irish]), { _tag: "Solo", tile: 1 })

    const benched = run(solo, { _tag: "SetLayout", layout: "Single" })

    assert.isTrue(Option.isNone(benched.solo))
  })

  it("should end on Unsolo", () => {
    const solo = run(fill([bama]), { _tag: "Solo", tile: 0 })

    const unsoloed = run(solo, { _tag: "Unsolo" })

    assert.isTrue(Option.isNone(unsoloed.solo))
  })

  it("should reject soloing an empty tile", () => {
    const reason = rejection(fill([bama]), { _tag: "Solo", tile: 2 })

    assert.strictEqual(reason, "empty-tile")
  })
})

function some(availability: () => ChannelAvailability) {
  return () => Option.some(availability())
}

function run(screen: Screen, command: ScreenCommand) {
  return Result.getOrThrow(screen.apply(command, nowhere))
}

function rejection(screen: Screen, command: ScreenCommand) {
  const result = screen.apply(command, nowhere)
  return Result.isFailure(result) ? result.failure.reason : undefined
}

function gameOf(tile: Tile) {
  return tile._tag === "Empty" ? undefined : tile.game
}

function unknownUpcoming() {
  return ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() })
}

/** An answer for `game` only: the guide says nothing of any other. */
function reportingOnly(game: GameId) {
  return (asked: GameId) => (asked === game ? Option.some(onFox()) : Option.none())
}

const channel = {
  name: "ABC",
  source: "YouTube TV",
  locator: { _tag: "WebView", url: "https://tv.example/abc" }
}

const tiles: ReadonlyArray<readonly [string, unknown]> = [
  ["Empty", { _tag: "Empty" }],
  ["StreamTile", { _tag: "StreamTile", game: "401856800", channel }],
  ["NoStream", { _tag: "DataTile", game: "401856800", why: { _tag: "NoStream" } }],
  ["StreamingOnly", { _tag: "DataTile", game: "401856800", why: { _tag: "StreamingOnly" } }],
  ["NotInGuide", { _tag: "DataTile", game: "401856800", why: { _tag: "NotInGuide" } }],
  ["NoGuide", { _tag: "DataTile", game: "401856800", why: { _tag: "NoGuide" } }],
  ["NotYet bare", { _tag: "DataTile", game: "401856800", why: { _tag: "NotYet" } }],
  [
    "NotYet with channel and begin",
    {
      _tag: "DataTile",
      game: "401856800",
      why: { _tag: "NotYet", channel: "ESPN", begin: "2026-10-04T17:00:00.000Z" }
    }
  ]
]

describe("Tile", () => {
  it.each(tiles)("should decode what it encodes: %s", (_, json) => {
    const tile = Schema.decodeUnknownSync(Tile)(json)

    const encoded = Schema.encodeSync(Tile)(tile)

    assert.deepStrictEqual(encoded, json)
  })

  it.each(tiles)("should encode as today: %s", (_, json) => {
    const tile = Schema.decodeUnknownSync(Tile)(json)

    const encoded = JSON.stringify(Schema.encodeSync(Tile)(tile))

    assert.strictEqual(encoded, JSON.stringify(json))
  })
})

const commands: ReadonlyArray<unknown> = [
  { _tag: "Assign", tile: 1, game: "401856800" },
  { _tag: "Clear", tile: 2 },
  { _tag: "FocusAudio", tile: 0 },
  { _tag: "Swap", a: 0, b: 3 },
  { _tag: "Promote", tile: 1 },
  { _tag: "SetLayout", layout: "MainThree" },
  { _tag: "SetSplit", split: { x: 0.25, y: 0.75 } },
  { _tag: "Solo", tile: 0 },
  { _tag: "Unsolo" }
]

describe("ScreenCommand", () => {
  it.each(commands)("should decode what it encodes: %j", (json) => {
    const command = Schema.decodeUnknownSync(ScreenCommand)(json)

    const encoded = Schema.encodeSync(ScreenCommand)(command)

    assert.deepStrictEqual(encoded, json)
  })

  it.each(commands)("should encode as today: %j", (json) => {
    const command = Schema.decodeUnknownSync(ScreenCommand)(json)

    const encoded = JSON.stringify(Schema.encodeSync(ScreenCommand)(command))

    assert.strictEqual(encoded, JSON.stringify(json))
  })
})
