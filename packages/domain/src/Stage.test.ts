import { assert, describe, it } from "@effect/vitest"
import { DateTime, Option, Result } from "effect"
import { GameId, Network } from "./Game.ts"
import { ChannelAvailability } from "./Source.ts"
import { Stage } from "./Stage.ts"

const bama = GameId.make("401856707")
const irish = GameId.make("401858250")
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

  it("moves audio focus", () => {
    const stage = Result.getOrThrow(Stage.initial.apply({ _tag: "FocusAudio", tile: 3 }, nowhere))
    assert.strictEqual(stage.audioFocus, 3)
  })

  it("leaves audio focus where it was on assign and clear", () => {
    const focused = Result.getOrThrow(Stage.initial.apply({ _tag: "FocusAudio", tile: 2 }, nowhere))
    const assigned = assign(focused, 0, bama, onFox)
    const cleared = Result.getOrThrow(assigned.apply({ _tag: "Clear", tile: 2 }, onFox))
    assert.strictEqual(assigned.audioFocus, 2)
    assert.strictEqual(cleared.audioFocus, 2)
  })

  it("rejects a tile that does not exist, saying why", () => {
    const result = Stage.initial.apply({ _tag: "FocusAudio", tile: 4 }, nowhere)
    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "no-such-tile")
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
    const focused = Result.getOrThrow(Stage.initial.apply({ _tag: "FocusAudio", tile: 3 }, nowhere))
    const refreshed = assign(focused, 0, bama, foxUnlearned).refresh(some(onFox))
    assert.deepStrictEqual(
      refreshed.tiles.map((tile) => tile._tag),
      ["StreamTile", "Empty", "Empty", "Empty"]
    )
    assert.strictEqual(refreshed.audioFocus, 3)
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

describe("Stage#nextBegin", () => {
  const now = DateTime.makeUnsafe("2026-10-03T20:00:00Z")
  const waiting = (begin: string) => () =>
    ChannelAvailability.Upcoming({
      channel: Option.some("FOX 43"),
      begin: Option.some(DateTime.makeUnsafe(begin))
    })

  it("is the earliest begin still to come among the games waiting for their airing", () => {
    const stage = assign(
      assign(
        assign(Stage.initial, 0, bama, waiting("2026-10-03T23:30:00Z")),
        1,
        irish,
        waiting("2026-10-03T21:00:00Z")
      ),
      2,
      GameId.make("401858251"),
      onFox
    )
    assert.deepStrictEqual(stage.nextBegin(now), Option.some(DateTime.makeUnsafe("2026-10-03T21:00:00Z")))
  })

  it("passes over a begin that has come, so a game whose airing is late is not chased", () => {
    const stage = assign(
      assign(Stage.initial, 0, bama, waiting("2026-10-03T20:00:00Z")),
      1,
      irish,
      waiting("2026-10-03T19:00:00Z")
    )
    assert.deepStrictEqual(stage.nextBegin(now), Option.none())
  })

  it("is none when no game is waiting with a begin", () => {
    const stage = assign(Stage.initial, 0, bama, () =>
      ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() })
    )
    assert.deepStrictEqual(stage.nextBegin(now), Option.none())
  })
})

function some(availability: () => ChannelAvailability) {
  return () => Option.some(availability())
}

function assign(stage: Stage, tile: number, game: GameId, availabilityOf: () => ChannelAvailability) {
  return Result.getOrThrow(stage.apply({ _tag: "Assign", tile, game }, availabilityOf))
}
