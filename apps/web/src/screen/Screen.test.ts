import { assert, describe, it } from "@effect/vitest"
import { TileKey } from "@sportal/api/TileKey"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { GameId } from "@sportal/domain/Game"
import { highlight } from "@sportal/domain/TestGame"
import { DateTime, Option, Result, Schema } from "effect"
import * as TestWeb from "../TestWeb.ts"
import { type LayoutName, Screen, ScreenCommand, Tile } from "./Screen.ts"

const usc = GameId.make("401856800")
const ohio = GameId.make("401858473")
const noGuide = (): ReadonlyArray<ChannelAvailability> => [{ _tag: "NoGuide", source: "YouTube TV" }]

describe("Screen#apply", () => {
  it("should assign a carried game as a stream tile", () => {
    const screen = TestWeb.assign(Screen.initial, 1, TestWeb.bama, TestWeb.onFox)

    assert.deepStrictEqual(screen.tiles[1], {
      _tag: "StreamTile",
      game: TestWeb.bama,
      channel: TestWeb.foxChannel
    })
  })

  it("should assign a game that is not carried as a data tile", () => {
    const screen = TestWeb.assign(Screen.initial, 0, TestWeb.bama, TestWeb.nowhere)

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: TestWeb.bama,
      why: { _tag: "NoStream" }
    })
  })

  it("should assign a game its source has no guide for as a data tile saying so", () => {
    const screen = TestWeb.assign(Screen.initial, 0, TestWeb.bama, noGuide)

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: TestWeb.bama,
      why: { _tag: "NoGuide", source: "YouTube TV" }
    })
  })

  it("should replace whatever an occupied tile held", () => {
    const first = TestWeb.assign(Screen.initial, 0, TestWeb.bama, TestWeb.onFox)

    const second = TestWeb.assign(first, 0, TestWeb.irish, TestWeb.nowhere)

    assert.deepStrictEqual(second.tiles[0], {
      _tag: "DataTile",
      game: TestWeb.irish,
      why: { _tag: "NoStream" }
    })
  })

  it("should move a game rather than show it twice", () => {
    const first = TestWeb.assign(Screen.initial, 0, TestWeb.bama, TestWeb.onFox)

    const second = TestWeb.assign(first, 2, TestWeb.bama, TestWeb.onFox)

    assert.strictEqual(second.tiles[0]?._tag, "Empty")
    assert.strictEqual(second.tiles[2]?._tag, "StreamTile")
  })

  it("should re-resolve a moved game, so a game that lost its stream moves as a data tile", () => {
    const first = TestWeb.assign(Screen.initial, 0, TestWeb.bama, TestWeb.onFox)

    const second = TestWeb.assign(first, 1, TestWeb.bama, TestWeb.nowhere)

    assert.strictEqual(second.tiles[0]?._tag, "Empty")
    assert.deepStrictEqual(second.tiles[1], {
      _tag: "DataTile",
      game: TestWeb.bama,
      why: { _tag: "NoStream" }
    })
  })

  it("should clear a tile and leave the others", () => {
    const screen = TestWeb.fill([TestWeb.bama, TestWeb.irish])

    const cleared = run(screen, { _tag: "Clear", tile: 0 })

    assert.strictEqual(cleared.tiles[0]?._tag, "Empty")
    assert.strictEqual(cleared.tiles[1]?._tag, "StreamTile")
  })

  it("should give audio to the first game on screen when no game has it", () => {
    const screen = TestWeb.assign(Screen.initial, 2, TestWeb.bama, TestWeb.onFox)

    assert.deepStrictEqual(screen.audioFocus, Option.some(TileKey.game(TestWeb.bama)))
  })

  it("should move audio focus to a tile's game", () => {
    const two = TestWeb.fill([TestWeb.bama, TestWeb.irish])

    const focused = run(two, { _tag: "FocusAudio", tile: 1 })

    assert.deepStrictEqual(focused.audioFocus, Option.some(TileKey.game(TestWeb.irish)))
  })

  it("should keep audio focus where it is when another game is assigned", () => {
    const focused = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "FocusAudio", tile: 1 })

    const assigned = TestWeb.assign(focused, 2, usc, TestWeb.onFox)

    assert.deepStrictEqual(assigned.audioFocus, Option.some(TileKey.game(TestWeb.irish)))
  })

  it("should move audio to the main tile's game when the focused game is cleared", () => {
    const focused = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "FocusAudio", tile: 1 })

    const cleared = run(focused, { _tag: "Clear", tile: 1 })

    assert.deepStrictEqual(cleared.audioFocus, Option.some(TileKey.game(TestWeb.bama)))
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

    const screen = TestWeb.assign(Screen.initial, 0, TestWeb.bama, () => [
      { _tag: "Upcoming", channel: Option.some("NFL ST - CBS"), begin: Option.some(begin) }
    ])

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: TestWeb.bama,
      why: { _tag: "NotYet", channel: Option.some("NFL ST - CBS"), begin: Option.some(begin) }
    })
  })

  it("should assign a game whose time and channel are unknown as a data tile with neither", () => {
    const screen = TestWeb.assign(Screen.initial, 0, TestWeb.bama, unknownUpcoming)

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: TestWeb.bama,
      why: { _tag: "NotYet", channel: Option.none(), begin: Option.none() }
    })
  })

  it("should say why a game is not carried", () => {
    const screen = TestWeb.assign(Screen.initial, 0, TestWeb.bama, () => [streamingOnly])

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: TestWeb.bama,
      why: { _tag: "StreamingOnly" }
    })
  })

  it("should assign a later source's carried game over an earlier source's not carried as a stream tile", () => {
    const screen = TestWeb.assign(Screen.initial, 0, TestWeb.bama, () => [streamingOnly, onTwitch])

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "StreamTile",
      game: TestWeb.bama,
      channel: twitchChannel
    })
  })

  it("should assign a carried game over an upcoming one as a stream tile", () => {
    const screen = TestWeb.assign(Screen.initial, 0, TestWeb.bama, () => [upcomingOnPrime, onTwitch])

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "StreamTile",
      game: TestWeb.bama,
      channel: twitchChannel
    })
  })

  it("should assign upcoming on a named channel over upcoming with nothing known", () => {
    const screen = TestWeb.assign(Screen.initial, 0, TestWeb.bama, () => [
      ...unknownUpcoming(),
      upcomingOnPrime
    ])

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: TestWeb.bama,
      why: { _tag: "NotYet", channel: Option.some("Prime Video"), begin: Option.some(primeBegin) }
    })
  })

  it("should assign upcoming over no guide", () => {
    const screen = TestWeb.assign(Screen.initial, 0, TestWeb.bama, () => [...noGuide(), ...unknownUpcoming()])

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: TestWeb.bama,
      why: { _tag: "NotYet", channel: Option.none(), begin: Option.none() }
    })
  })

  it("should assign no guide over not carried", () => {
    const screen = TestWeb.assign(Screen.initial, 0, TestWeb.bama, () => [streamingOnly, ...noGuide()])

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: TestWeb.bama,
      why: { _tag: "NoGuide", source: "YouTube TV" }
    })
  })

  it("should assign streaming only over not in the guide", () => {
    const screen = TestWeb.assign(Screen.initial, 0, TestWeb.bama, () => [notInGuide, streamingOnly])

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: TestWeb.bama,
      why: { _tag: "StreamingOnly" }
    })
  })

  it("should assign a game with no availability from any source as a data tile with no stream", () => {
    const screen = TestWeb.assign(Screen.initial, 0, TestWeb.bama, () => [])

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: TestWeb.bama,
      why: { _tag: "NoStream" }
    })
  })

  it("should put a game's stats in a stats tile", () => {
    const screen = run(Screen.initial, { _tag: "AssignStats", tile: 1, game: TestWeb.bama })

    assert.deepStrictEqual(screen.tiles[1], { _tag: "StatsTile", game: TestWeb.bama })
  })

  it("should keep a game's stream where it is when its stats go beside it", () => {
    const screen = TestWeb.fill([TestWeb.bama])

    const beside = run(screen, { _tag: "AssignStats", tile: 1, game: TestWeb.bama })

    assert.strictEqual(beside.tiles[0]?._tag, "StreamTile")
    assert.strictEqual(beside.tiles[1]?._tag, "StatsTile")
  })

  it("should move a game's stats rather than show them twice", () => {
    const first = run(Screen.initial, { _tag: "AssignStats", tile: 0, game: TestWeb.bama })

    const second = run(first, { _tag: "AssignStats", tile: 2, game: TestWeb.bama })

    assert.deepStrictEqual(
      second.tiles.map(({ _tag }) => _tag),
      ["Empty", "Empty", "StatsTile", "Empty"]
    )
  })

  it("should refuse to focus audio on a stats tile", () => {
    const screen = run(TestWeb.fill([TestWeb.bama]), { _tag: "AssignStats", tile: 1, game: TestWeb.bama })

    const result = screen.apply({ _tag: "FocusAudio", tile: 1 }, TestWeb.onFox)

    assert.deepStrictEqual(
      Result.getFailure(result).pipe(Option.map(({ reason }) => reason)),
      Option.some("silent-tile")
    )
  })

  it("should give audio focus to no stats tile", () => {
    const screen = run(Screen.initial, { _tag: "AssignStats", tile: 0, game: TestWeb.bama })

    assert.isTrue(Option.isNone(screen.audioFocus))
  })

  it("should keep the audio focus where it is when a stats tile is promoted", () => {
    const screen = run(TestWeb.fill([TestWeb.bama]), { _tag: "AssignStats", tile: 1, game: TestWeb.bama })

    const promoted = run(screen, { _tag: "Promote", tile: 1 })

    assert.deepStrictEqual(promoted.audioFocus, Option.some(TileKey.game(TestWeb.bama)))
  })

  it("should keep the audio focus where it is when a stats tile is soloed", () => {
    const screen = run(TestWeb.fill([TestWeb.bama]), { _tag: "AssignStats", tile: 1, game: TestWeb.bama })

    const soloed = run(screen, { _tag: "Solo", tile: 1 })

    assert.deepStrictEqual(soloed.audioFocus, Option.some(TileKey.game(TestWeb.bama)))
  })

  it("should put a highlight in a clip tile", () => {
    const clip = highlight()

    const screen = run(Screen.initial, { _tag: "AssignClip", tile: 2, highlight: clip })

    assert.deepStrictEqual(screen.tiles[2], { _tag: "ClipTile", highlight: clip })
  })

  it("should give audio focus to a clip tile", () => {
    const screen = run(TestWeb.fill([TestWeb.bama]), { _tag: "AssignClip", tile: 1, highlight: highlight() })

    const focused = run(screen, { _tag: "FocusAudio", tile: 1 })

    assert.deepStrictEqual(focused.audioFocus, Option.some(TileKey.clip(highlight().id)))
  })
})

describe("Screen#refresh", () => {
  it("should keep a stats tile as it is", () => {
    const screen = run(Screen.initial, { _tag: "AssignStats", tile: 0, game: TestWeb.bama })

    const refreshed = screen.refresh(() => Option.some(TestWeb.onFox()))

    assert.strictEqual(refreshed, screen)
  })

  it("should return the same Screen when no tile changes", () => {
    const screen = TestWeb.assign(Screen.initial, 0, TestWeb.bama, noGuide)

    const refreshed = screen.refresh(() => Option.some(noGuide()))

    assert.strictEqual(refreshed, screen)
  })

  it("should re-resolve only the tiles whose game has an availability to report", () => {
    const streaming = TestWeb.assign(TestWeb.fill([TestWeb.bama]), 1, TestWeb.irish, TestWeb.nowhere)

    const refreshed = streaming.refresh(reportingOnly(TestWeb.irish))

    assert.deepStrictEqual(refreshed.tiles[0], streaming.tiles[0])
    assert.deepStrictEqual(refreshed.tiles[1], {
      _tag: "StreamTile",
      game: TestWeb.irish,
      channel: TestWeb.foxChannel
    })
  })

  it("should leave empty tiles empty", () => {
    const screen = TestWeb.assign(
      TestWeb.assign(Screen.initial, 0, TestWeb.bama, TestWeb.nowhere),
      1,
      TestWeb.irish,
      TestWeb.onFox
    )

    const refreshed = screen.refresh(some(TestWeb.onFox))

    assert.deepStrictEqual(
      refreshed.tiles.map((tile) => tile._tag),
      ["StreamTile", "StreamTile", "Empty", "Empty"]
    )
  })

  it("should leave audio focus where it was", () => {
    const focused = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "FocusAudio", tile: 1 })

    const refreshed = focused.refresh(some(TestWeb.onFox))

    assert.deepStrictEqual(refreshed.audioFocus, Option.some(TileKey.game(TestWeb.irish)))
  })

  it("should re-resolve benched tiles too", () => {
    const benched = run(TestWeb.assign(TestWeb.fill([TestWeb.bama]), 1, TestWeb.irish, TestWeb.nowhere), {
      _tag: "SetLayout",
      layout: "Single"
    })

    const refreshed = benched.refresh(some(TestWeb.onFox))

    assert.strictEqual(refreshed.tiles[1]?._tag, "StreamTile")
  })

  it.each<[string, ReadonlyArray<ChannelAvailability>]>([
    ["no guide", noGuide()],
    ["no stream", TestWeb.nowhere()],
    ["streaming only", [streamingOnly]],
    ["not in the guide", [notInGuide]],
    [
      "an upcoming game",
      [
        {
          _tag: "Upcoming",
          channel: Option.some("FOX 43"),
          begin: Option.some(DateTime.makeUnsafe("2026-10-04T17:00:00Z"))
        }
      ]
    ],
    ["the same channel", TestWeb.onFox()]
  ])("should keep a stream tile playing on the availability %s", (_name, availability) => {
    const streaming = TestWeb.assign(Screen.initial, 0, TestWeb.bama, TestWeb.onFox)

    const refreshed = streaming.refresh(() => Option.some(availability))

    assert.deepStrictEqual(refreshed.tiles[0], streaming.tiles[0])
  })

  it("should turn a no-guide data tile into a stream once the guide carries its game", () => {
    const waiting = TestWeb.assign(Screen.initial, 0, TestWeb.bama, noGuide)

    const refreshed = waiting.refresh(some(TestWeb.onFox))

    assert.deepStrictEqual(refreshed.tiles[0], {
      _tag: "StreamTile",
      game: TestWeb.bama,
      channel: TestWeb.foxChannel
    })
  })

  it("should move a stream tile to the channel a later guide carries it on", () => {
    const streaming = TestWeb.assign(Screen.initial, 0, TestWeb.bama, TestWeb.onFox)

    const moved = streaming.refresh(some(() => [{ _tag: "Carried", channel: fox43 }]))

    assert.deepStrictEqual(moved.tiles[0], { _tag: "StreamTile", game: TestWeb.bama, channel: fox43 })
  })

  it("should keep a stream tile when another source carries its game", () => {
    const streaming = TestWeb.assign(Screen.initial, 0, TestWeb.bama, TestWeb.onFox)

    const refreshed = streaming.refresh(some(() => [onTwitch]))

    assert.deepStrictEqual(refreshed.tiles[0], streaming.tiles[0])
  })

  it("should re-resolve a data tile whose game has left the guide", () => {
    const waiting = TestWeb.assign(Screen.initial, 0, TestWeb.bama, unknownUpcoming)

    const refreshed = waiting.refresh(some(() => [notInGuide]))

    assert.deepStrictEqual(refreshed.tiles[0], {
      _tag: "DataTile",
      game: TestWeb.bama,
      why: { _tag: "NotInGuide" }
    })
  })

  it("should keep a stream tile when its own source no longer carries it but another source does", () => {
    const streaming = TestWeb.assign(Screen.initial, 0, TestWeb.bama, TestWeb.onFox)

    const refreshed = streaming.refresh(() => Option.some([...noGuide(), onTwitch]))

    assert.deepStrictEqual(refreshed.tiles[0], streaming.tiles[0])
  })

  it("should move a stream tile when its own source carries it elsewhere, whatever other sources say", () => {
    const streaming = TestWeb.assign(Screen.initial, 0, TestWeb.bama, TestWeb.onFox)

    const moved = streaming.refresh(() => Option.some([onTwitch, { _tag: "Carried", channel: fox43 }]))

    assert.deepStrictEqual(moved.tiles[0], { _tag: "StreamTile", game: TestWeb.bama, channel: fox43 })
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
    const full = TestWeb.fill([TestWeb.bama, TestWeb.irish, usc, ohio])

    const pair = run(full, { _tag: "SetLayout", layout: "Pair" })

    assert.deepStrictEqual(pair.onScreen().map(Tile.game), [TestWeb.bama, TestWeb.irish])
    assert.deepStrictEqual(pair.tiles.map(Tile.game), [TestWeb.bama, TestWeb.irish, usc, ohio])
  })

  it("should bring the benched tiles back in order", () => {
    const full = TestWeb.fill([TestWeb.bama, TestWeb.irish, usc, ohio])
    const pair = run(full, { _tag: "SetLayout", layout: "Pair" })

    const quad = run(pair, { _tag: "SetLayout", layout: "Quad" })

    assert.deepStrictEqual(quad.tiles, full.tiles)
  })

  it("should pad a growing layout with empty tiles", () => {
    const one = TestWeb.fill([TestWeb.bama])

    const five = run(one, { _tag: "SetLayout", layout: "MainFive" })

    assert.strictEqual(five.tiles.length, 6)
  })

  it("should trim empties off the end of the bench", () => {
    const five = run(TestWeb.fill([TestWeb.bama]), { _tag: "SetLayout", layout: "MainFive" })

    const single = run(five, { _tag: "SetLayout", layout: "Single" })

    assert.strictEqual(single.tiles.length, 1)
  })

  it("should keep holes in the bench, so a layout that grows back restores every place", () => {
    const holed = TestWeb.fill([TestWeb.bama, TestWeb.irish, undefined, ohio])

    const single = run(holed, { _tag: "SetLayout", layout: "Single" })

    assert.deepStrictEqual(single.tiles.map(Tile.game), [TestWeb.bama, TestWeb.irish, undefined, ohio])
  })

  it("should move audio off a benched game to the main tile's game", () => {
    const focused = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "FocusAudio", tile: 1 })

    const single = run(focused, { _tag: "SetLayout", layout: "Single" })

    assert.deepStrictEqual(single.audioFocus, Option.some(TileKey.game(TestWeb.bama)))
  })

  it("should keep a game in one tile across screen and bench", () => {
    const benched = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "SetLayout", layout: "Single" })

    const assigned = TestWeb.assign(benched, 0, TestWeb.irish, TestWeb.onFox)

    assert.deepStrictEqual(assigned.tiles.map(Tile.game), [TestWeb.irish])
  })

  it("should reject audio for a benched tile", () => {
    const benched = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "SetLayout", layout: "Single" })

    const reason = rejection(benched, { _tag: "FocusAudio", tile: 1 })

    assert.strictEqual(reason, "offscreen-tile")
  })

  it("should reject solo for a benched tile", () => {
    const benched = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "SetLayout", layout: "Single" })

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
  const screen = run(run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "Solo", tile: 0 }), {
    _tag: "FocusAudio",
    tile: 1
  })

  it("should hear the on-air game", () => {
    assert.isTrue(screen.hears(TileKey.game(TestWeb.irish)))
  })

  it("should not hear the soloed game when another is on air", () => {
    assert.isFalse(screen.hears(TileKey.game(TestWeb.bama)))
  })

  it("should solo the soloed game", () => {
    assert.isTrue(screen.soloes(TileKey.game(TestWeb.bama)))
  })

  it("should not solo the game on air", () => {
    assert.isFalse(screen.soloes(TileKey.game(TestWeb.irish)))
  })

  it("should not hear a game in no tile", () => {
    assert.isFalse(screen.hears(TileKey.game(usc)))
  })

  it("should not solo a game in no tile", () => {
    assert.isFalse(screen.soloes(TileKey.game(usc)))
  })
})

describe("Tile.key", () => {
  it("should key a stream tile by its game", () => {
    const tile: Tile = { _tag: "StreamTile", game: TestWeb.bama, channel: TestWeb.foxChannel }

    const key = Tile.key(tile)

    assert.strictEqual(key, TileKey.game(TestWeb.bama))
  })

  it("should key a data tile by its game", () => {
    const tile: Tile = { _tag: "DataTile", game: TestWeb.bama, why: { _tag: "NoStream" } }

    const key = Tile.key(tile)

    assert.strictEqual(key, TileKey.game(TestWeb.bama))
  })

  it("should key a stats tile by its game's stats", () => {
    const tile: Tile = { _tag: "StatsTile", game: TestWeb.bama }

    const key = Tile.key(tile)

    assert.strictEqual(key, TileKey.stats(TestWeb.bama))
  })

  it("should give an empty tile no key", () => {
    const key = Tile.key({ _tag: "Empty" })

    assert.isUndefined(key)
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
    const full = TestWeb.fill([TestWeb.bama, TestWeb.irish, usc, ohio])

    assert.deepStrictEqual(full.benched(), [])
  })

  it("should list the games a shrunk layout benched, with their tiles", () => {
    const pair = run(TestWeb.fill([TestWeb.bama, TestWeb.irish, usc, ohio]), {
      _tag: "SetLayout",
      layout: "Pair"
    })

    assert.deepStrictEqual(pair.benched(), [
      { tile: 2, key: TileKey.game(usc) },
      { tile: 3, key: TileKey.game(ohio) }
    ])
  })

  it("should skip the empty tiles past the slots", () => {
    const single = run(TestWeb.fill([TestWeb.bama, TestWeb.irish, undefined, ohio]), {
      _tag: "SetLayout",
      layout: "Single"
    })

    assert.deepStrictEqual(single.benched(), [
      { tile: 1, key: TileKey.game(TestWeb.irish) },
      { tile: 3, key: TileKey.game(ohio) }
    ])
  })
})

describe("Screen#nextEmptySlot", () => {
  const holes = TestWeb.fill([undefined, TestWeb.bama, undefined, TestWeb.irish])

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
    const screen = TestWeb.fill([undefined, TestWeb.bama, TestWeb.irish, usc])

    assert.isUndefined(screen.nextEmptySlot(0))
  })

  it("should ignore the bench", () => {
    const pair = run(TestWeb.fill([TestWeb.bama, TestWeb.irish, undefined, undefined]), {
      _tag: "SetLayout",
      layout: "Pair"
    })

    assert.isUndefined(pair.nextEmptySlot(0))
  })
})

describe("Screen swap and promote", () => {
  it("should swap two tiles on screen", () => {
    const three = TestWeb.fill([TestWeb.bama, TestWeb.irish, usc])

    const swapped = run(three, { _tag: "Swap", a: 0, b: 2 })

    assert.deepStrictEqual(swapped.tiles.map(Tile.game), [usc, TestWeb.irish, TestWeb.bama, undefined])
  })

  it("should swap a benched tile onto the screen", () => {
    const benched = run(TestWeb.fill([TestWeb.bama, TestWeb.irish, usc]), {
      _tag: "SetLayout",
      layout: "Pair"
    })

    const swapped = run(benched, { _tag: "Swap", a: 1, b: 2 })

    assert.deepStrictEqual(swapped.onScreen().map(Tile.game), [TestWeb.bama, usc])
  })

  it("should keep audio with its game through a swap", () => {
    const swapped = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "Swap", a: 0, b: 1 })

    assert.deepStrictEqual(swapped.audioFocus, Option.some(TileKey.game(TestWeb.bama)))
  })

  it("should promote a tile into the main tile and give it audio", () => {
    const screen = TestWeb.fill([TestWeb.bama, undefined, undefined, TestWeb.irish])

    const promoted = run(screen, { _tag: "Promote", tile: 3 })

    assert.deepStrictEqual(promoted.tiles.map(Tile.game), [TestWeb.irish, undefined, undefined, TestWeb.bama])
    assert.deepStrictEqual(promoted.audioFocus, Option.some(TileKey.game(TestWeb.irish)))
  })

  it("should promote a benched game", () => {
    const benched = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "SetLayout", layout: "Single" })

    const promoted = run(benched, { _tag: "Promote", tile: 1 })

    assert.deepStrictEqual(promoted.onScreen().map(Tile.game), [TestWeb.irish])
  })

  it("should reject promoting an empty tile", () => {
    const reason = rejection(Screen.initial, { _tag: "Promote", tile: 1 })

    assert.strictEqual(reason, "empty-tile")
  })
})

describe("Screen solo", () => {
  it("should solo a tile's game and give it audio", () => {
    const solo = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "Solo", tile: 1 })

    assert.deepStrictEqual(solo.solo, Option.some(TileKey.game(TestWeb.irish)))
    assert.deepStrictEqual(solo.audioFocus, Option.some(TileKey.game(TestWeb.irish)))
  })

  it("should follow its game through a swap", () => {
    const solo = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "Solo", tile: 1 })

    const swapped = run(solo, { _tag: "Swap", a: 0, b: 1 })

    assert.deepStrictEqual(swapped.solo, Option.some(TileKey.game(TestWeb.irish)))
  })

  it("should end when the game is cleared", () => {
    const solo = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "Solo", tile: 1 })

    const cleared = run(solo, { _tag: "Clear", tile: 1 })

    assert.isTrue(Option.isNone(cleared.solo))
  })

  it("should end when the game is benched", () => {
    const solo = run(TestWeb.fill([TestWeb.bama, TestWeb.irish]), { _tag: "Solo", tile: 1 })

    const benched = run(solo, { _tag: "SetLayout", layout: "Single" })

    assert.isTrue(Option.isNone(benched.solo))
  })

  it("should end on Unsolo", () => {
    const solo = run(TestWeb.fill([TestWeb.bama]), { _tag: "Solo", tile: 0 })

    const unsoloed = run(solo, { _tag: "Unsolo" })

    assert.isTrue(Option.isNone(unsoloed.solo))
  })

  it("should reject soloing an empty tile", () => {
    const reason = rejection(TestWeb.fill([TestWeb.bama]), { _tag: "Solo", tile: 2 })

    assert.strictEqual(reason, "empty-tile")
  })
})

describe("Screen custom tiles", () => {
  it("should assign a custom stream as a custom tile carrying its watch page", () => {
    const screen = TestWeb.assignCustom(Screen.initial, 1, TestWeb.video)

    assert.deepStrictEqual(screen.tiles[1], {
      _tag: "CustomTile",
      stream: TestWeb.video.id,
      name: "Highlights",
      locator: { _tag: "WebView", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }
    })
  })

  it("should move a custom stream rather than show it twice", () => {
    const first = TestWeb.assignCustom(Screen.initial, 0, TestWeb.video)

    const second = TestWeb.assignCustom(first, 2, TestWeb.video)

    assert.strictEqual(second.tiles[0]?._tag, "Empty")
    assert.strictEqual(second.tiles[2]?._tag, "CustomTile")
  })

  it("should keep a game where it is when a custom stream is assigned beside it", () => {
    const screen = TestWeb.assignCustom(TestWeb.fill([TestWeb.bama]), 1, TestWeb.video)

    assert.strictEqual(screen.tiles[0]?._tag, "StreamTile")
    assert.strictEqual(screen.tiles[1]?._tag, "CustomTile")
  })

  it("should give audio focus to a custom tile", () => {
    const screen = TestWeb.assignCustom(TestWeb.fill([TestWeb.bama]), 1, TestWeb.video)

    const focused = run(screen, { _tag: "FocusAudio", tile: 1 })

    assert.deepStrictEqual(focused.audioFocus, Option.some(TileKey.custom(TestWeb.video.id)))
  })

  it("should solo a custom tile", () => {
    const screen = TestWeb.assignCustom(TestWeb.fill([TestWeb.bama]), 1, TestWeb.video)

    const soloed = run(screen, { _tag: "Solo", tile: 1 })

    assert.deepStrictEqual(soloed.solo, Option.some(TileKey.custom(TestWeb.video.id)))
  })

  it("should promote a custom tile into the main tile", () => {
    const screen = TestWeb.assignCustom(TestWeb.fill([TestWeb.bama]), 1, TestWeb.video)

    const promoted = run(screen, { _tag: "Promote", tile: 1 })

    assert.strictEqual(promoted.tiles[0]?._tag, "CustomTile")
  })

  it("should clear a custom tile", () => {
    const screen = TestWeb.assignCustom(Screen.initial, 1, TestWeb.video)

    const cleared = run(screen, { _tag: "Clear", tile: 1 })

    assert.strictEqual(cleared.tiles[1]?._tag, "Empty")
  })

  it("should leave a custom tile as it was when what a source knows changes", () => {
    const screen = TestWeb.assignCustom(TestWeb.fill([TestWeb.bama]), 1, TestWeb.video)

    const refreshed = screen.refresh(some(TestWeb.nowhere))

    assert.deepStrictEqual(refreshed.tiles[1], screen.tiles[1])
  })
})

describe("Screen#customTiles", () => {
  it("should list the tile showing a stream, benched as well as on screen", () => {
    const quad = TestWeb.assignCustom(Screen.initial, 3, TestWeb.video)
    const single = run(quad, { _tag: "SetLayout", layout: "Single" })

    const shown = single.customTiles(TestWeb.video.id)

    assert.deepStrictEqual(
      shown.map(({ index }) => index),
      [3]
    )
  })

  it("should be empty for a stream on no tile", () => {
    const screen = TestWeb.assignCustom(Screen.initial, 0, TestWeb.video)

    const shown = screen.customTiles(TestWeb.playlist.id)

    assert.deepStrictEqual(shown, [])
  })
})

function some(availability: () => ReadonlyArray<ChannelAvailability>) {
  return () => Option.some(availability())
}

describe("Screen#withoutClips", () => {
  it("should empty every clip tile", () => {
    const screen = run(TestWeb.fill([TestWeb.bama]), { _tag: "AssignClip", tile: 1, highlight: highlight() })

    const restored = screen.withoutClips()

    assert.deepStrictEqual(restored.tiles[1], { _tag: "Empty" })
  })

  it("should give audio focus on a clip tile to the first on-screen tile with sound", () => {
    const clipped = run(TestWeb.fill([TestWeb.bama]), { _tag: "AssignClip", tile: 1, highlight: highlight() })
    const screen = run(clipped, { _tag: "FocusAudio", tile: 1 })

    const restored = screen.withoutClips()

    assert.deepStrictEqual(restored.audioFocus, Option.some(TileKey.game(TestWeb.bama)))
  })

  it("should end solo on a clip tile", () => {
    const clipped = run(TestWeb.fill([TestWeb.bama]), { _tag: "AssignClip", tile: 1, highlight: highlight() })
    const screen = run(clipped, { _tag: "Solo", tile: 1 })

    const restored = screen.withoutClips()

    assert.deepStrictEqual(restored.solo, Option.none())
  })

  it("should be the same Screen when it has no clip tile", () => {
    const screen = TestWeb.fill([TestWeb.bama])

    const restored = screen.withoutClips()

    assert.strictEqual(restored, screen)
  })
})

function run(screen: Screen, command: ScreenCommand) {
  return Result.getOrThrow(screen.apply(command, TestWeb.nowhere))
}

function rejection(screen: Screen, command: ScreenCommand) {
  const result = screen.apply(command, TestWeb.nowhere)
  return Result.isFailure(result) ? result.failure.reason : undefined
}

function unknownUpcoming(): ReadonlyArray<ChannelAvailability> {
  return [{ _tag: "Upcoming", channel: Option.none(), begin: Option.none() }]
}

/** Availability for `game` only: the guide says nothing of any other. */
function reportingOnly(game: GameId) {
  return (asked: GameId) => (asked === game ? Option.some(TestWeb.onFox()) : Option.none())
}

const twitchChannel = {
  name: "Prime Video",
  source: "Twitch" as const,
  locator: { _tag: "WebView" as const, url: "https://player.twitch.tv/?channel=primevideo" }
}
const onTwitch: ChannelAvailability = { _tag: "Carried", channel: twitchChannel }
const primeBegin = DateTime.makeUnsafe("2026-10-04T00:15:00Z")
const upcomingOnPrime: ChannelAvailability = {
  _tag: "Upcoming",
  channel: Option.some("Prime Video"),
  begin: Option.some(primeBegin)
}
const streamingOnly: ChannelAvailability = { _tag: "NotCarried", why: "StreamingOnly" }
const notInGuide: ChannelAvailability = { _tag: "NotCarried", why: "NotInGuide" }
const fox43 = {
  ...TestWeb.foxChannel,
  name: "FOX 43",
  locator: { ...TestWeb.foxChannel.locator, url: "https://tv.youtube.com/watch/fox43" }
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
  ["NoGuide", { _tag: "DataTile", game: "401856800", why: { _tag: "NoGuide", source: "YouTube TV" } }],
  ["NotYet bare", { _tag: "DataTile", game: "401856800", why: { _tag: "NotYet" } }],
  [
    "NotYet with channel and begin",
    {
      _tag: "DataTile",
      game: "401856800",
      why: { _tag: "NotYet", channel: "ESPN", begin: "2026-10-04T17:00:00.000Z" }
    }
  ],
  [
    "CustomTile",
    {
      _tag: "CustomTile",
      stream: "video.dQw4w9WgXcQ",
      name: "Highlights",
      locator: { _tag: "WebView", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }
    }
  ],
  ["StatsTile", { _tag: "StatsTile", game: "401856800" }]
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
  { _tag: "AssignStats", tile: 1, game: "401856800" },
  {
    _tag: "AssignCustom",
    tile: 1,
    stream: "video.dQw4w9WgXcQ",
    name: "Highlights",
    locator: { _tag: "WebView", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }
  },
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
