import { assert, describe, it } from "@effect/vitest"
import { Network } from "@sportal/domain/Game"
import { ChannelAvailability } from "@sportal/domain/Source"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import * as Database from "../database/Database.ts"
import { ChannelStore } from "./ChannelStore.ts"
import { Source } from "./Source.ts"
import * as SqlChannelStore from "./SqlChannelStore.ts"
import * as YouTubeTv from "./YouTubeTv.ts"

// Addresses recorded from YouTube TV's live guide on 2026-10-03.
const cbsLive = "https://tv.youtube.com/watch/y6zFA17zDsw?vp=0gEEEgIwAQ%3D%3D"
const foxLive = "https://tv.youtube.com/watch/_MpmFlh-Wzc?vp=0gEEEgIwAQ%3D%3D"
const foxFromTheBeginning =
  "https://tv.youtube.com/watch/_MpmFlh-Wzc?vpp=gAKAzYTWBg%3D%3D&vp=0gEKEgIwARiAzYTWBg%3D%3D"

const espn = Network.make("ESPN")
const disney = Network.make("Disney+")
const onEspn = snapshot({ broadcasts: [espn] })
const onEspnAndDisney = snapshot({ broadcasts: [disney, espn] })
const guide = { _tag: "WebView" as const, url: "https://tv.youtube.com/live" }
const decodeLive = Schema.decodeUnknownOption(YouTubeTv.LiveChannelUrl)

describe("YouTubeTv.LiveChannelUrl", () => {
  it("keeps a live channel address as it is", () => {
    assert.deepStrictEqual(decodeLive(cbsLive), Option.some(cbsLive))
  })

  it("decodes a from-the-beginning address to the live address for the same channel", () => {
    assert.deepStrictEqual(decodeLive(foxFromTheBeginning), Option.some(foxLive))
  })

  it.each([
    "https://tv.youtube.com/live",
    "https://tv.youtube.com/watch/",
    "https://tv.youtube.com/watch/abc/extra",
    "http://tv.youtube.com/watch/abc",
    "https://www.youtube.com/watch/abc",
    "https://tv.youtube.com.evil.example/watch/abc",
    "not a url"
  ])("refuses %s", (url) => {
    assert.isTrue(Option.isNone(decodeLive(url)))
  })
})

describe("YouTubeTv source", () => {
  it.effect("starts with every network unlearned, pointing at the live guide", () =>
    Effect.gen(function* () {
      const lineup = yield* (yield* Source).lineup
      assert.deepStrictEqual(
        lineup.availabilityOf(onEspn),
        ChannelAvailability.Unlearned({ network: espn, source: "YouTube TV", guide })
      )
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("learns a channel from a guide address and keeps its live address", () =>
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.learn(espn, foxFromTheBeginning)
      assert.deepStrictEqual(
        (yield* source.lineup).availabilityOf(onEspn),
        ChannelAvailability.Carried({
          channel: { network: espn, source: "YouTube TV", locator: { _tag: "WebView", url: foxLive } }
        })
      )
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("refuses to learn an address that is not a channel, and learns nothing", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const error = yield* source.learn(espn, "https://tv.youtube.com/live").pipe(Effect.flip)
      assert.strictEqual(error._tag, "ChannelUrlRefused")
      assert.strictEqual((yield* source.lineup).availabilityOf(onEspn)._tag, "Unlearned")
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("moves on to the next network once one is marked not carried", () =>
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.markNotCarried(disney)
      assert.deepStrictEqual(
        (yield* source.lineup).availabilityOf(onEspnAndDisney),
        ChannelAvailability.Unlearned({ network: espn, source: "YouTube TV", guide })
      )
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("forgets a learned channel", () =>
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.learn(espn, cbsLive)
      yield* source.forget(espn)
      assert.strictEqual((yield* source.lineup).availabilityOf(onEspn)._tag, "Unlearned")
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("signals a change after each write, not before", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const signals = yield* source.changes.pipe(Stream.take(2), Stream.runCount, Effect.forkChild)
      yield* Effect.yieldNow
      yield* source.learn(espn, cbsLive)
      yield* source.markNotCarried(disney)
      assert.strictEqual(yield* Fiber.join(signals), 2)
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("loads what the channel store already holds", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* (yield* Source).lineup).availabilityOf(onEspn)._tag, "Carried")
    }).pipe(Effect.provide(YouTubeTv.layer.pipe(Layer.provide(storeKnowingEspn()))))
  )
})

/** The source over a fresh in-memory database. */
function testSource() {
  return YouTubeTv.layer.pipe(Layer.provide(SqlChannelStore.layer), Layer.provide(Database.layer(":memory:")))
}

/** An in-memory channel store that already holds ESPN's channel when the source starts. */
function storeKnowingEspn() {
  return Layer.effect(
    ChannelStore,
    Effect.gen(function* () {
      const store = yield* ChannelStore
      yield* store.record({
        _tag: "Carried",
        channel: { network: espn, source: "YouTube TV", locator: { _tag: "WebView", url: cbsLive } }
      })
      return store
    })
  ).pipe(Layer.provide(SqlChannelStore.layer), Layer.provide(Database.layer(":memory:")))
}
