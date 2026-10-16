import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { Game, GameId } from "@sportal/domain/Game"
import { FootballDetail, PlayId } from "@sportal/domain/Play"
import { footballDetail, play, snapshot, team } from "@sportal/domain/TestGame"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { vi } from "vitest"
import * as TestWeb from "../TestWeb.ts"
import * as LiveStream from "./LiveStream.ts"

describe("LiveStream.live", () => {
  beforeEach(() => {
    TestWeb.FakeEventSource.opened = []
    vi.stubGlobal("EventSource", TestWeb.FakeEventSource)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should be connecting before the stream first opens", () =>
    Effect.gen(function* () {
      yield* TestWeb.opened
      const state = yield* Atom.get(LiveStream.live)

      assert.strictEqual(state.connection._tag, "Connecting")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should stay connecting after an error before the stream first opens", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.opened

      source.onerror?.()
      source.onmessage?.({ data: TestWeb.slateMessage([{ game: someGame, availability: [] }]) })
      const after = yield* TestWeb.until(LiveStream.live, (state) => state.slate.games.length > 0)

      assert.strictEqual(after.connection._tag, "Connecting")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should publish nothing for an error while connecting or already lost", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.opened
      const listening = yield* Deferred.make<void>()
      const published = yield* Atom.toStream(LiveStream.live).pipe(
        Stream.tap(() => Deferred.succeed(listening, undefined)),
        Stream.takeUntil((state) => state.slate.games.length > 0),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Deferred.await(listening)

      source.onerror?.()
      source.onopen?.()
      source.onerror?.()
      source.onerror?.()
      source.onmessage?.({ data: TestWeb.slateMessage([{ game: someGame, availability: [] }]) })
      const states = yield* Fiber.join(published)

      const connections = Array.from(states, (state) => state.connection._tag)
      assert.deepStrictEqual(connections, ["Connecting", "Connected", "Lost", "Lost"])
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should be connected once open", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.opened

      source.onopen?.()

      yield* TestWeb.until(LiveStream.live, (state) => state.connection._tag === "Connected")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should be lost after an error once open", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.opened
      source.onopen?.()
      yield* TestWeb.until(LiveStream.live, (state) => state.connection._tag === "Connected")

      source.onerror?.()

      yield* TestWeb.until(LiveStream.live, (state) => state.connection._tag === "Lost")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should be connected again when it reopens after it was lost", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.opened
      source.onopen?.()
      yield* TestWeb.until(LiveStream.live, (state) => state.connection._tag === "Connected")
      source.onerror?.()
      yield* TestWeb.until(LiveStream.live, (state) => state.connection._tag === "Lost")

      source.onerror?.()
      source.onopen?.()

      yield* TestWeb.until(LiveStream.live, (state) => state.connection._tag === "Connected")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should replace the slate from its message", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.opened

      source.onmessage?.({ data: TestWeb.slateMessage([{ game: someGame, availability: [] }]) })
      const state = yield* TestWeb.until(LiveStream.live, (current) => current.slate.games.length > 0)

      assert.deepStrictEqual(
        state.slate.games.map(({ snapshot }) => snapshot.id),
        [GameId.make("401")]
      )
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect(
    "should keep the plays each game of a slate message carries, each read back from its JSON with its detail",
    () =>
      Effect.gen(function* () {
        const source = yield* TestWeb.opened
        const game = new Game({
          snapshot: snapshot({ id: GameId.make("401") }),
          plays: [play(), touchdown()]
        })

        source.onmessage?.({ data: TestWeb.slateMessage([{ game, availability: [] }]) })
        const state = yield* TestWeb.until(LiveStream.live, (current) => current.slate.games.length > 0)

        assert.deepStrictEqual(state.slate.games[0]?.plays, game.plays)
        assert.instanceOf(state.slate.games[0]?.plays[1]?.detail, FootballDetail)
      }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should keep each game's availability from a slate message, by its id", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.opened
      const game = new Game({ snapshot: snapshot({ id: GameId.make("401") }), plays: [] })
      const availability: ReadonlyArray<ChannelAvailability> = [{ _tag: "NotCarried", why: "StreamingOnly" }]

      source.onmessage?.({ data: TestWeb.slateMessage([{ game, availability }]) })
      const state = yield* TestWeb.until(LiveStream.live, (current) => current.slate.games.length > 0)

      assert.deepStrictEqual(state.availability[GameId.make("401")], availability)
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should skip a malformed message and keep reading", () =>
    Effect.gen(function* () {
      const source = yield* TestWeb.opened
      source.onopen?.()
      const before = yield* TestWeb.until(LiveStream.live, (state) => state.connection._tag === "Connected")

      source.onmessage?.({ data: "{not json" })
      source.onmessage?.({ data: JSON.stringify({ _tag: "SlateChanged", slate: "nope", availability: {} }) })
      source.onmessage?.({ data: TestWeb.slateMessage([{ game: someGame, availability: [] }]) })
      const after = yield* TestWeb.until(LiveStream.live, (state) => state.slate.games.length > 0)

      assert.strictEqual(after.connection, before.connection)
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should open /api/live and close it when the registry goes", () =>
    Effect.gen(function* () {
      const source = yield* Effect.scoped(Effect.provide(TestWeb.opened, AtomRegistry.layer))

      assert.strictEqual(source.url, "/api/live")
      assert.isTrue(source.closed)
    })
  )
})

const someGame = new Game({ snapshot: snapshot({ id: GameId.make("401") }), plays: [] })

/** A one-yard touchdown pass for the home side: a football detail, so a decode has its class to keep. */
function touchdown() {
  const home = team("HOME").id
  const away = team("AWAY").id
  return play({
    id: PlayId.make("2"),
    sequence: 2,
    clock: "14:30",
    text: "Pass complete for 1 yard",
    type: { id: "67", text: "Passing Touchdown" },
    scoring: true,
    homeScore: 7,
    detail: footballDetail({
      kind: "pass",
      start: { down: 1, distance: 10, yardsToEndzone: 1, team: home },
      end: { team: away }
    })
  })
}
