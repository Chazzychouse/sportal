import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { LiveMessageJson } from "@sportal/api/LiveMessage"
import { Game, GameId } from "@sportal/domain/Game"
import { Completion, PlayId } from "@sportal/domain/Play"
import { Screen } from "@sportal/domain/Screen"
import { play, snapshot, team } from "@sportal/domain/TestGame"
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

  it.effect("should be connecting before the stream first opens", () =>
    Effect.gen(function* () {
      const live = yield* LiveStream

      yield* opened()
      const state = yield* SubscriptionRef.get(live)

      assert.strictEqual(state.connection._tag, "Connecting")
    }).pipe(Effect.provide(LiveStream.layer))
  )

  it.effect("should stay connecting after an error before the stream first opens", () =>
    Effect.gen(function* () {
      const live = yield* LiveStream
      const source = yield* opened()

      source.onerror?.()
      source.onmessage?.({ data: message({ _tag: "ScreenChanged", screen: pair }) })
      const after = yield* until(live, (state) => state.screen.layout === "Pair")

      assert.strictEqual(after.connection._tag, "Connecting")
    }).pipe(Effect.provide(LiveStream.layer))
  )

  it.effect("should publish nothing for an error while connecting or already lost", () =>
    Effect.gen(function* () {
      const live = yield* LiveStream
      const source = yield* opened()
      const listening = yield* Deferred.make<void>()
      const published = yield* SubscriptionRef.changes(live).pipe(
        Stream.tap(() => Deferred.succeed(listening, undefined)),
        Stream.takeUntil((state) => state.screen.layout === "Pair"),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Deferred.await(listening)

      source.onerror?.()
      source.onopen?.()
      source.onerror?.()
      source.onerror?.()
      source.onmessage?.({ data: message({ _tag: "ScreenChanged", screen: pair }) })
      const states = yield* Fiber.join(published)

      const connections = Array.from(states, (state) => state.connection._tag)
      assert.deepStrictEqual(connections, ["Connecting", "Connected", "Lost", "Lost"])
    }).pipe(Effect.provide(LiveStream.layer))
  )

  it.effect("should be connected once open", () =>
    Effect.gen(function* () {
      const live = yield* LiveStream
      const source = yield* opened()

      source.onopen?.()

      yield* until(live, (state) => state.connection._tag === "Connected")
    }).pipe(Effect.provide(LiveStream.layer))
  )

  it.effect("should be lost after an error once open", () =>
    Effect.gen(function* () {
      const live = yield* LiveStream
      const source = yield* opened()
      source.onopen?.()
      yield* until(live, (state) => state.connection._tag === "Connected")

      source.onerror?.()

      yield* until(live, (state) => state.connection._tag === "Lost")
    }).pipe(Effect.provide(LiveStream.layer))
  )

  it.effect("should be connected again when it reopens after it was lost", () =>
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

  it.effect("should replace the screen and the slate from their messages", () =>
    Effect.gen(function* () {
      const live = yield* LiveStream
      const source = yield* opened()

      source.onmessage?.({ data: message({ _tag: "ScreenChanged", screen: pair }) })
      source.onmessage?.({ data: message({ _tag: "SlateChanged", games: [] }) })
      const state = yield* until(live, (current) => current.screen.layout === "Pair")

      assert.deepStrictEqual(state.slate, [])
    }).pipe(Effect.provide(LiveStream.layer))
  )

  it.effect(
    "should keep the plays each game of a slate message carries, each read back from its JSON as its case",
    () =>
      Effect.gen(function* () {
        const live = yield* LiveStream
        const source = yield* opened()
        const game = new Game({
          snapshot: snapshot({ id: GameId.make("401") }),
          plays: [play(), touchdown()]
        })

        source.onmessage?.({ data: message({ _tag: "SlateChanged", games: [game] }) })
        const state = yield* until(live, (current) => current.slate.length > 0)

        assert.deepStrictEqual(state.slate[0]?.plays, game.plays)
        assert.instanceOf(state.slate[0]?.plays[1], Completion)
      }).pipe(Effect.provide(LiveStream.layer))
  )

  it.effect("should skip a malformed message and keep reading", () =>
    Effect.gen(function* () {
      const live = yield* LiveStream
      const source = yield* opened()
      source.onopen?.()
      const before = yield* until(live, (state) => state.connection._tag === "Connected")

      source.onmessage?.({ data: "{not json" })
      source.onmessage?.({ data: JSON.stringify({ _tag: "ScreenChanged", screen: "nope" }) })
      source.onmessage?.({ data: message({ _tag: "ScreenChanged", screen: pair }) })
      const after = yield* until(live, (state) => state.screen.layout === "Pair")

      assert.strictEqual(after.connection, before.connection)
      assert.strictEqual(after.slate, before.slate)
    }).pipe(Effect.provide(LiveStream.layer))
  )

  it.effect("should open /api/live and close it when the runtime goes", () =>
    Effect.gen(function* () {
      const source = yield* Effect.scoped(Effect.provide(opened(), LiveStream.layer))

      assert.strictEqual(source.url, "/api/live")
      assert.isTrue(source.closed)
    })
  )
})

const pair = new Screen({ ...Screen.initial, layout: "Pair" })
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

/** A one-yard touchdown pass for the home side: a Completion, so a decode has its case to keep. */
function touchdown() {
  const home = team("HOME").id
  const away = team("AWAY").id
  return new Completion({
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
}
