import { assert, describe, it } from "@effect/vitest"
import { DateTime, Option, Result } from "effect"
import { GameId, Network } from "./Game.ts"
import { Layout } from "./Layout.ts"
import { ChannelAvailability } from "./Source.ts"
import { Stage, type StageCommand, type Tile } from "./Stage.ts"

const bama = GameId.make("401856707")
const irish = GameId.make("401858250")
const usc = GameId.make("401856800")
const ohio = GameId.make("401858473")
const fox = Network.make("FOX")
const foxChannel = {
  name: "FOX",
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/fox" }
}
const guide = { _tag: "WebView" as const, url: "https://tv.youtube.com/live" }
const onFox = () => ChannelAvailability.Carried({ channel: foxChannel, learnedFor: Option.some(fox) })
const foxUnlearned = () => ChannelAvailability.Unlearned({ network: fox, source: "YouTube TV", guide })
const nowhere = () => ChannelAvailability.NotCarried({ why: "NoStream" })
const onGuide = () => ChannelAvailability.Carried({ channel: foxChannel, learnedFor: Option.none() })

describe("Stage#apply", () => {
  it("assigns a carried game as a stream tile", () => {
    const stage = assign(Stage.initial, 1, bama, onFox)
    assert.deepStrictEqual(stage.tiles[1], {
      _tag: "StreamTile",
      game: bama,
      channel: foxChannel,
      learnedFor: fox
    })
  })

  it("assigns a game on an unlearned network as a picking tile", () => {
    const stage = assign(Stage.initial, 0, bama, foxUnlearned)
    assert.deepStrictEqual(stage.tiles[0], {
      _tag: "PickingChannel",
      game: bama,
      network: fox,
      source: "YouTube TV",
      guide
    })
  })

  it("assigns a game that is not carried as a data tile", () => {
    const stage = assign(Stage.initial, 0, bama, nowhere)
    assert.deepStrictEqual(stage.tiles[0], { _tag: "DataTile", game: bama, why: { _tag: "NoStream" } })
  })

  it("replaces whatever an occupied tile held", () => {
    const first = assign(Stage.initial, 0, bama, onFox)
    const second = assign(first, 0, irish, nowhere)
    assert.deepStrictEqual(second.tiles[0], { _tag: "DataTile", game: irish, why: { _tag: "NoStream" } })
  })

  it("moves a game rather than showing it twice", () => {
    const first = assign(Stage.initial, 0, bama, onFox)
    const second = assign(first, 2, bama, onFox)
    assert.strictEqual(second.tiles[0]?._tag, "Empty")
    assert.strictEqual(second.tiles[2]?._tag, "StreamTile")
  })

  it("re-resolves a moved game, so a game that lost its stream moves as a data tile", () => {
    const first = assign(Stage.initial, 0, bama, onFox)
    const second = assign(first, 1, bama, nowhere)
    assert.strictEqual(second.tiles[0]?._tag, "Empty")
    assert.deepStrictEqual(second.tiles[1], { _tag: "DataTile", game: bama, why: { _tag: "NoStream" } })
  })

  it("clears a tile and leaves the others", () => {
    const a = assign(Stage.initial, 0, bama, onFox)
    const b = assign(a, 1, irish, onFox)
    const c = Result.getOrThrow(b.apply({ _tag: "Clear", tile: 0 }, onFox))
    assert.strictEqual(c.tiles[0]?._tag, "Empty")
    assert.strictEqual(c.tiles[1]?._tag, "StreamTile")
  })

  it("gives audio to the first game on stage when no game has it", () => {
    assert.strictEqual(assign(Stage.initial, 2, bama, onFox).audioFocus, bama)
  })

  it("moves audio focus to a tile's game, and keeps it there on assign elsewhere", () => {
    const two = assign(assign(Stage.initial, 0, bama, onFox), 1, irish, onFox)
    const focused = run(two, { _tag: "FocusAudio", tile: 1 })
    assert.strictEqual(focused.audioFocus, irish)
    assert.strictEqual(assign(focused, 2, usc, onFox).audioFocus, irish)
  })

  it("moves audio to the main tile's game when the focused game is cleared", () => {
    const two = run(assign(assign(Stage.initial, 0, bama, onFox), 1, irish, onFox), {
      _tag: "FocusAudio",
      tile: 1
    })
    assert.strictEqual(run(two, { _tag: "Clear", tile: 1 }).audioFocus, bama)
  })

  it("rejects audio for an empty tile", () => {
    assert.strictEqual(rejection(Stage.initial, { _tag: "FocusAudio", tile: 3 }), "empty-tile")
  })

  it("rejects a tile that does not exist, saying why", () => {
    assert.strictEqual(rejection(Stage.initial, { _tag: "FocusAudio", tile: 4 }), "no-such-tile")
    assert.strictEqual(rejection(Stage.initial, { _tag: "Swap", a: 0, b: 4 }), "no-such-tile")
  })

  it("assigns a game still to come as a data tile saying where and when", () => {
    const begin = DateTime.makeUnsafe("2026-10-04T17:00:00Z")
    const stage = assign(Stage.initial, 0, bama, () =>
      ChannelAvailability.Upcoming({ channel: Option.some("NFL ST - CBS"), begin: Option.some(begin) })
    )
    assert.deepStrictEqual(stage.tiles[0], {
      _tag: "DataTile",
      game: bama,
      why: { _tag: "NotYet", channel: "NFL ST - CBS", begin }
    })
  })

  it("assigns a game whose time and channel are unknown as a data tile with neither", () => {
    const stage = assign(Stage.initial, 0, bama, () =>
      ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() })
    )
    assert.deepStrictEqual(stage.tiles[0], { _tag: "DataTile", game: bama, why: { _tag: "NotYet" } })
  })

  it("says why a game is not carried", () => {
    const stage = assign(Stage.initial, 0, bama, () =>
      ChannelAvailability.NotCarried({ why: "StreamingOnly" })
    )
    assert.deepStrictEqual(stage.tiles[0], { _tag: "DataTile", game: bama, why: { _tag: "StreamingOnly" } })
  })
})

describe("Stage#refresh", () => {
  it("turns every picking tile for a network into a stream once its channel is learned", () => {
    const picking = assign(assign(Stage.initial, 0, bama, foxUnlearned), 1, irish, foxUnlearned)
    const refreshed = picking.refresh(some(onFox))
    assert.deepStrictEqual(refreshed.tiles[0], {
      _tag: "StreamTile",
      game: bama,
      channel: foxChannel,
      learnedFor: fox
    })
    assert.deepStrictEqual(refreshed.tiles[1], {
      _tag: "StreamTile",
      game: irish,
      channel: foxChannel,
      learnedFor: fox
    })
  })

  it("moves a picking tile to the game's next unlearned network when one is not carried", () => {
    const espn = Network.make("ESPN")
    const picking = assign(Stage.initial, 0, bama, foxUnlearned)
    const refreshed = picking.refresh(() =>
      Option.some(ChannelAvailability.Unlearned({ network: espn, source: "YouTube TV", guide }))
    )
    assert.deepStrictEqual(refreshed.tiles[0], {
      _tag: "PickingChannel",
      game: bama,
      network: espn,
      source: "YouTube TV",
      guide
    })
  })

  it("turns a stream tile back into a picking tile when its channel is forgotten", () => {
    const streaming = assign(Stage.initial, 0, bama, onFox)
    assert.strictEqual(streaming.refresh(some(foxUnlearned)).tiles[0]?._tag, "PickingChannel")
  })

  it("leaves a tile whose game has no availability to report as it was", () => {
    const streaming = assign(assign(Stage.initial, 0, bama, onFox), 1, irish, foxUnlearned)
    const refreshed = streaming.refresh((game) => (game === irish ? Option.some(onFox()) : Option.none()))
    assert.deepStrictEqual(refreshed.tiles[0], streaming.tiles[0])
    assert.deepStrictEqual(refreshed.tiles[1], {
      _tag: "StreamTile",
      game: irish,
      channel: foxChannel,
      learnedFor: fox
    })
  })

  it("leaves empty tiles empty and audio focus where it was", () => {
    const two = run(assign(assign(Stage.initial, 0, bama, foxUnlearned), 1, irish, onFox), {
      _tag: "FocusAudio",
      tile: 1
    })
    const refreshed = two.refresh(some(onFox))
    assert.deepStrictEqual(
      refreshed.tiles.map((tile) => tile._tag),
      ["StreamTile", "StreamTile", "Empty", "Empty"]
    )
    assert.strictEqual(refreshed.audioFocus, irish)
  })

  it("re-resolves benched tiles too", () => {
    const benched = run(assign(assign(Stage.initial, 0, bama, onFox), 1, irish, foxUnlearned), {
      _tag: "SetLayout",
      layout: "Single"
    })
    assert.strictEqual(benched.refresh(some(onFox)).tiles[1]?._tag, "StreamTile")
  })

  it("keeps a guide-matched stream tile playing on any answer but a channel", () => {
    const streaming = assign(Stage.initial, 0, bama, onGuide)
    const begin = DateTime.makeUnsafe("2026-10-04T17:00:00Z")
    for (const answer of [
      foxUnlearned(),
      nowhere(),
      ChannelAvailability.NotCarried({ why: "StreamingOnly" }),
      ChannelAvailability.NotCarried({ why: "NotInGuide" }),
      ChannelAvailability.Upcoming({ channel: Option.some("FOX 43"), begin: Option.some(begin) })
    ])
      assert.deepStrictEqual(streaming.refresh(() => Option.some(answer)).tiles[0], streaming.tiles[0])
  })

  it("moves a guide-matched stream tile to the channel a later guide carries it on", () => {
    const streaming = assign(Stage.initial, 0, bama, onGuide)
    const elsewhere = { ...foxChannel, name: "FOX 43" }
    const moved = streaming.refresh(
      some(() => ChannelAvailability.Carried({ channel: elsewhere, learnedFor: Option.none() }))
    )
    assert.deepStrictEqual(moved.tiles[0], { _tag: "StreamTile", game: bama, channel: elsewhere })
    assert.deepStrictEqual(streaming.refresh(some(onGuide)).tiles[0], streaming.tiles[0])
  })

  it("makes a hand-picked stream tile follow its channel, so wrong channel returns it to the guide", () => {
    const picked = assign(Stage.initial, 0, bama, onFox)
    assert.deepStrictEqual(picked.refresh(some(foxUnlearned)).tiles[0], {
      _tag: "PickingChannel",
      game: bama,
      network: fox,
      source: "YouTube TV",
      guide
    })
    assert.deepStrictEqual(
      picked.refresh(some(() => ChannelAvailability.NotCarried({ why: "NotInGuide" }))).tiles[0],
      { _tag: "DataTile", game: bama, why: { _tag: "NotInGuide" } }
    )
    assert.deepStrictEqual(
      picked.refresh(
        some(() => ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() }))
      ).tiles[0],
      { _tag: "DataTile", game: bama, why: { _tag: "NotYet" } }
    )
  })

  it("re-resolves a data tile whose game has left the guide", () => {
    const waiting = assign(Stage.initial, 0, bama, () =>
      ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() })
    )
    const refreshed = waiting.refresh(some(() => ChannelAvailability.NotCarried({ why: "NotInGuide" })))
    assert.deepStrictEqual(refreshed.tiles[0], { _tag: "DataTile", game: bama, why: { _tag: "NotInGuide" } })
  })
})

describe("Stage layouts and the bench", () => {
  it("starts as an empty Quad with default splits", () => {
    assert.strictEqual(Stage.initial.layout, "Quad")
    assert.strictEqual(Stage.initial.tiles.length, 4)
    assert.deepStrictEqual(Stage.initial.splits.MainFive, Layout.defaultSplit("MainFive"))
  })

  it("benches the tiles that no longer fit, and brings them back in order", () => {
    const full = fill([bama, irish, usc, ohio])
    const pair = run(full, { _tag: "SetLayout", layout: "Pair" })
    assert.deepStrictEqual(pair.onStage().map(gameOf), [bama, irish])
    assert.deepStrictEqual(pair.tiles.map(gameOf), [bama, irish, usc, ohio])
    assert.deepStrictEqual(run(pair, { _tag: "SetLayout", layout: "Quad" }).tiles, full.tiles)
  })

  it("pads a growing layout with empty tiles and trims empties off the end of the bench", () => {
    const five = run(assign(Stage.initial, 0, bama, onFox), { _tag: "SetLayout", layout: "MainFive" })
    assert.strictEqual(five.tiles.length, 6)
    assert.strictEqual(run(five, { _tag: "SetLayout", layout: "Single" }).tiles.length, 1)
  })

  it("keeps holes in the bench, so a layout that grows back restores every place", () => {
    const holed = fill([bama, irish, undefined, ohio])
    const single = run(holed, { _tag: "SetLayout", layout: "Single" })
    assert.deepStrictEqual(single.tiles.map(gameOf), [bama, irish, undefined, ohio])
  })

  it("moves audio off a benched game to the main tile's game", () => {
    const two = run(fill([bama, irish]), { _tag: "FocusAudio", tile: 1 })
    assert.strictEqual(run(two, { _tag: "SetLayout", layout: "Single" }).audioFocus, bama)
  })

  it("keeps a game in one tile across stage and bench", () => {
    const benched = run(fill([bama, irish]), { _tag: "SetLayout", layout: "Single" })
    assert.deepStrictEqual(assign(benched, 0, irish, onFox).tiles.map(gameOf), [irish])
  })

  it("rejects audio and solo for a benched tile", () => {
    const benched = run(fill([bama, irish]), { _tag: "SetLayout", layout: "Single" })
    assert.strictEqual(rejection(benched, { _tag: "FocusAudio", tile: 1 }), "offstage-tile")
    assert.strictEqual(rejection(benched, { _tag: "Solo", tile: 1 }), "offstage-tile")
  })

  it("sets the current layout's split and remembers each layout's own", () => {
    const moved = run(Stage.initial, { _tag: "SetSplit", split: { x: 0.3, y: 0.7 } })
    assert.deepStrictEqual(moved.splits.Quad, { x: 0.3, y: 0.7 })
    assert.deepStrictEqual(moved.splits.Pair, Layout.defaultSplit("Pair"))
    assert.deepStrictEqual(moved.currentLayout().split, { x: 0.3, y: 0.7 })
  })

  it("rejects a split outside 0.2–0.8", () => {
    assert.strictEqual(
      rejection(Stage.initial, { _tag: "SetSplit", split: { x: 0.1, y: 0.5 } }),
      "split-out-of-range"
    )
  })
})

describe("Stage#benched", () => {
  it("is empty when every game fits the layout", () => {
    assert.deepStrictEqual(Stage.initial.benched(), [])
    assert.deepStrictEqual(fill([bama, irish, usc, ohio]).benched(), [])
  })

  it("lists the games a shrunk layout benched, with their tiles", () => {
    const pair = run(fill([bama, irish, usc, ohio]), { _tag: "SetLayout", layout: "Pair" })
    assert.deepStrictEqual(pair.benched(), [
      { tile: 2, game: usc },
      { tile: 3, game: ohio }
    ])
  })

  it("skips the empty tiles past the slots", () => {
    const single = run(fill([bama, irish, undefined, ohio]), { _tag: "SetLayout", layout: "Single" })
    assert.deepStrictEqual(single.benched(), [
      { tile: 1, game: irish },
      { tile: 3, game: ohio }
    ])
  })
})

describe("Stage#nextEmptySlot", () => {
  it("is the first empty slot after the given one, wrapping, never the slot itself", () => {
    const holes = fill([undefined, bama, undefined, irish])
    assert.strictEqual(holes.nextEmptySlot(0), 2)
    assert.strictEqual(holes.nextEmptySlot(2), 0)
    assert.strictEqual(holes.nextEmptySlot(3), 0)
  })

  it("is none when every other slot is filled, and ignores the bench", () => {
    assert.isUndefined(fill([undefined, bama, irish, usc]).nextEmptySlot(0))
    const pair = run(fill([bama, irish, undefined, undefined]), { _tag: "SetLayout", layout: "Pair" })
    assert.isUndefined(pair.nextEmptySlot(0))
  })
})

describe("Stage swap and promote", () => {
  it("swaps two tiles, on stage or benched", () => {
    const three = fill([bama, irish, usc])
    assert.deepStrictEqual(run(three, { _tag: "Swap", a: 0, b: 2 }).tiles.map(gameOf), [
      usc,
      irish,
      bama,
      undefined
    ])
    const benched = run(three, { _tag: "SetLayout", layout: "Pair" })
    assert.deepStrictEqual(run(benched, { _tag: "Swap", a: 1, b: 2 }).onStage().map(gameOf), [bama, usc])
  })

  it("keeps audio with its game through a swap", () => {
    assert.strictEqual(run(fill([bama, irish]), { _tag: "Swap", a: 0, b: 1 }).audioFocus, bama)
  })

  it("promotes a tile into the main tile and gives it audio", () => {
    const promoted = run(fill([bama, undefined, undefined, irish]), { _tag: "Promote", tile: 3 })
    assert.deepStrictEqual(promoted.tiles.map(gameOf), [irish, undefined, undefined, bama])
    assert.strictEqual(promoted.audioFocus, irish)
  })

  it("promotes a benched game", () => {
    const benched = run(fill([bama, irish]), { _tag: "SetLayout", layout: "Single" })
    assert.deepStrictEqual(run(benched, { _tag: "Promote", tile: 1 }).onStage().map(gameOf), [irish])
  })

  it("rejects promoting an empty tile", () => {
    assert.strictEqual(rejection(Stage.initial, { _tag: "Promote", tile: 1 }), "empty-tile")
  })
})

describe("Stage solo", () => {
  it("solos a tile's game and gives it audio", () => {
    const solo = run(fill([bama, irish]), { _tag: "Solo", tile: 1 })
    assert.strictEqual(solo.solo, irish)
    assert.strictEqual(solo.audioFocus, irish)
  })

  it("follows its game through a swap, and ends when the game is cleared or benched", () => {
    const solo = run(fill([bama, irish]), { _tag: "Solo", tile: 1 })
    assert.strictEqual(run(solo, { _tag: "Swap", a: 0, b: 1 }).solo, irish)
    assert.isUndefined(run(solo, { _tag: "Clear", tile: 1 }).solo)
    assert.isUndefined(run(solo, { _tag: "SetLayout", layout: "Single" }).solo)
  })

  it("ends on Unsolo", () => {
    assert.isUndefined(run(run(fill([bama]), { _tag: "Solo", tile: 0 }), { _tag: "Unsolo" }).solo)
  })

  it("rejects soloing an empty tile", () => {
    assert.strictEqual(rejection(fill([bama]), { _tag: "Solo", tile: 2 }), "empty-tile")
  })
})

function some(availability: () => ChannelAvailability) {
  return () => Option.some(availability())
}

function assign(stage: Stage, tile: number, game: GameId, availabilityOf: () => ChannelAvailability) {
  return Result.getOrThrow(stage.apply({ _tag: "Assign", tile, game }, availabilityOf))
}

/** A Quad holding these games as stream tiles, in order; `undefined` leaves a tile empty. */
function fill(games: ReadonlyArray<GameId | undefined>) {
  return games.reduce<Stage>(
    (stage, game, tile) => (game === undefined ? stage : assign(stage, tile, game, onFox)),
    Stage.initial
  )
}

function run(stage: Stage, command: StageCommand) {
  return Result.getOrThrow(stage.apply(command, nowhere))
}

function rejection(stage: Stage, command: StageCommand) {
  const result = stage.apply(command, nowhere)
  return Result.isFailure(result) ? result.failure.reason : undefined
}

function gameOf(tile: Tile) {
  return tile._tag === "Empty" ? undefined : tile.game
}
