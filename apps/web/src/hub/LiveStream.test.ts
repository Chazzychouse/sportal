import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { LiveMessageJson } from "@sportal/api/LiveMessage"
import { GameId } from "@sportal/domain/Game"
import { Completion, PlayId } from "@sportal/domain/Play"
import { Stage } from "@sportal/domain/Stage"
import { play, team } from "@sportal/domain/TestGame"
import { Deferred, Effect, Fiber, Schema, Stream, SubscriptionRef } from "effect"
import { vi } from "vitest"
import { LiveStream } from "./LiveStream.ts"

describe("LiveStream", () => {
  beforeEach(() => {
    FakeEventSource.opened = []
    vi.stubGlobal("EventSource", FakeEventSource)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("is connecting before the stream first opens, even after an error", () =>
    Effect.gen(function* () {
      const live = yield* LiveStream
      const source = yield* opened()
      assert.strictEqual((yield* SubscriptionRef.get(live)).connection._tag, "Connecting")
      source.onerror?.()
      source.onmessage?.({ data: message({ _tag: "StageChanged", stage: pair }) })
      const after = yield* until(live, (state) => state.stage.layout === "Pair")
      assert.strictEqual(after.connection._tag, "Connecting")
    }).pipe(Effect.provide(LiveStream.layer))
  )

  it.effect("publishes nothing for an error while connecting or already lost", () =>
    Effect.gen(function* () {
      const live = yield* LiveStream
      const source = yield* opened()
      const listening = yield* Deferred.make<void>()
      const published = yield* SubscriptionRef.changes(live).pipe(
        Stream.tap(() => Deferred.succeed(listening, undefined)),
        Stream.takeUntil((state) => state.stage.layout === "Pair"),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Deferred.await(listening)
      source.onerror?.()
      source.onopen?.()
      source.onerror?.()
      source.onerror?.()
      source.onmessage?.({ data: message({ _tag: "StageChanged", stage: pair }) })
      const connections = Array.from(yield* Fiber.join(published), (state) => state.connection._tag)
      assert.deepStrictEqual(connections, ["Connecting", "Connected", "Lost", "Lost"])
    }).pipe(Effect.provide(LiveStream.layer))
  )

  it.effect("is connected once open, lost after an error, and connected again when it reopens", () =>
    Effect.gen(function* () {
      const live = yield* LiveStream
      const source = yield* opened()
      source.onopen?.()
      yield* until(live, (state) => state.connection._tag === "Connected")
      source.onerror?.()
      yield* until(live, (state) => state.connection._tag === "Lost")
      source.onerror?.()
      source.onopen?.()
      yield* until(live, (state) => state.connection._tag === "Connected")
    }).pipe(Effect.provide(LiveStream.layer))
  )

  it.effect("replaces the stage and the slate from their messages", () =>
    Effect.gen(function* () {
      const live = yield* LiveStream
      const source = yield* opened()
      source.onmessage?.({ data: message({ _tag: "StageChanged", stage: pair }) })
      source.onmessage?.({ data: message({ _tag: "SlateChanged", slate: [], recentPlays: {} }) })
      const state = yield* until(live, (current) => current.stage.layout === "Pair")
      assert.deepStrictEqual(state.slate, [])
    }).pipe(Effect.provide(LiveStream.layer))
  )

  it.effect(
    "should keep the recent plays a slate message carries, each read back from its JSON as its case",
    () =>
      Effect.gen(function* () {
        const live = yield* LiveStream
        const source = yield* opened()
        const home = team("HOME").id
        const away = team("AWAY").id
        const touchdown = new Completion({
          id: PlayId.make("2"),
          sequence: 2,
          period: 1,
          clock: "14:30",
          text: "Pass complete for 1 yard",
          scoring: true,
          homeScore: 7,
          awayScore: 0,
          start: { down: 1, distance: 10, yardsToEndzone: 1, team: home },
          end: { team: away },
          homeWinProbability: 0.62,
          team: home,
          yards: 1,
          touchdown: true
        })
        const recentPlays = { [GameId.make("401")]: [play(), touchdown] }

        source.onmessage?.({ data: message({ _tag: "SlateChanged", slate: [], recentPlays }) })
        const state = yield* until(live, (current) => Object.keys(current.recentPlays).length > 0)

        assert.deepStrictEqual(state.recentPlays, recentPlays)
        assert.instanceOf(state.recentPlays[GameId.make("401")]?.[1], Completion)
      }).pipe(Effect.provide(LiveStream.layer))
  )

  it.effect("skips a malformed message and keeps reading", () =>
    Effect.gen(function* () {
      const live = yield* LiveStream
      const source = yield* opened()
      source.onopen?.()
      const before = yield* until(live, (state) => state.connection._tag === "Connected")
      source.onmessage?.({ data: "{not json" })
      source.onmessage?.({ data: JSON.stringify({ _tag: "StageChanged", stage: "nope" }) })
      source.onmessage?.({ data: message({ _tag: "StageChanged", stage: pair }) })
      const after = yield* until(live, (state) => state.stage.layout === "Pair")
      assert.strictEqual(after.connection, before.connection)
      assert.strictEqual(after.slate, before.slate)
    }).pipe(Effect.provide(LiveStream.layer))
  )

  it.effect("opens /api/live and closes it when the runtime goes", () =>
    Effect.gen(function* () {
      const source = yield* Effect.scoped(Effect.provide(opened(), LiveStream.layer))
      assert.strictEqual(source.url, "/api/live")
      assert.isTrue(source.closed)
    })
  )
})

const pair = new Stage({ ...Stage.initial, layout: "Pair" })
const message = Schema.encodeSync(LiveMessageJson)

function until<A>(live: SubscriptionRef.SubscriptionRef<A>, predicate: (state: A) => boolean) {
  return SubscriptionRef.changes(live).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption)
  )
}

/** The EventSource the live stream opened, once its fiber has started. */
function opened(): Effect.Effect<FakeEventSource> {
  return Effect.suspend(() => {
    const last = FakeEventSource.opened.at(-1)
    return last === undefined ? Effect.yieldNow.pipe(Effect.flatMap(opened)) : Effect.succeed(last)
  })
}

class FakeEventSource {
  static opened: Array<FakeEventSource> = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false

  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeEventSource.opened.push(this)
  }

  close() {
    this.closed = true
  }
}
