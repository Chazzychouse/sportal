import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import { Game, GameId } from "@sportal/domain/Game"
import { Completion, PlayId } from "@sportal/domain/Play"
import { play, snapshot, team } from "@sportal/domain/TestGame"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { vi } from "vitest"
import * as LiveStream from "./LiveStream.ts"
import { FakeEventSource, opened, slateMessage } from "./TestLiveStream.ts"

describe("LiveStream.live", () => {
  beforeEach(() => {
    FakeEventSource.opened = []
    vi.stubGlobal("EventSource", FakeEventSource)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should be connecting before the stream first opens", () =>
    Effect.gen(function* () {
      yield* opened()
      const state = yield* Atom.get(LiveStream.live)

      assert.strictEqual(state.connection._tag, "Connecting")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should stay connecting after an error before the stream first opens", () =>
    Effect.gen(function* () {
      const source = yield* opened()

      source.onerror?.()
      source.onmessage?.({ data: slateMessage([{ game: someGame, availability: [] }]) })
      const after = yield* until((state) => state.slate.length > 0)

      assert.strictEqual(after.connection._tag, "Connecting")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should publish nothing for an error while connecting or already lost", () =>
    Effect.gen(function* () {
      const source = yield* opened()
      const listening = yield* Deferred.make<void>()
      const published = yield* Atom.toStream(LiveStream.live).pipe(
        Stream.tap(() => Deferred.succeed(listening, undefined)),
        Stream.takeUntil((state) => state.slate.length > 0),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Deferred.await(listening)

      source.onerror?.()
      source.onopen?.()
      source.onerror?.()
      source.onerror?.()
      source.onmessage?.({ data: slateMessage([{ game: someGame, availability: [] }]) })
      const states = yield* Fiber.join(published)

      const connections = Array.from(states, (state) => state.connection._tag)
      assert.deepStrictEqual(connections, ["Connecting", "Connected", "Lost", "Lost"])
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should be connected once open", () =>
    Effect.gen(function* () {
      const source = yield* opened()

      source.onopen?.()

      yield* until((state) => state.connection._tag === "Connected")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should be lost after an error once open", () =>
    Effect.gen(function* () {
      const source = yield* opened()
      source.onopen?.()
      yield* until((state) => state.connection._tag === "Connected")

      source.onerror?.()

      yield* until((state) => state.connection._tag === "Lost")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should be connected again when it reopens after it was lost", () =>
    Effect.gen(function* () {
      const source = yield* opened()
      source.onopen?.()
      yield* until((state) => state.connection._tag === "Connected")
      source.onerror?.()
      yield* until((state) => state.connection._tag === "Lost")

      source.onerror?.()
      source.onopen?.()

      yield* until((state) => state.connection._tag === "Connected")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should replace the slate from its message", () =>
    Effect.gen(function* () {
      const source = yield* opened()

      source.onmessage?.({ data: slateMessage([{ game: someGame, availability: [] }]) })
      const state = yield* until((current) => current.slate.length > 0)

      assert.deepStrictEqual(
        state.slate.map(({ snapshot }) => snapshot.id),
        [GameId.make("401")]
      )
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect(
    "should keep the plays each game of a slate message carries, each read back from its JSON as its case",
    () =>
      Effect.gen(function* () {
        const source = yield* opened()
        const game = new Game({
          snapshot: snapshot({ id: GameId.make("401") }),
          plays: [play(), touchdown()]
        })

        source.onmessage?.({ data: slateMessage([{ game, availability: [] }]) })
        const state = yield* until((current) => current.slate.length > 0)

        assert.deepStrictEqual(state.slate[0]?.plays, game.plays)
        assert.instanceOf(state.slate[0]?.plays[1], Completion)
      }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should keep each game's availability from a slate message, by its id", () =>
    Effect.gen(function* () {
      const source = yield* opened()
      const game = new Game({ snapshot: snapshot({ id: GameId.make("401") }), plays: [] })
      const availability: ReadonlyArray<ChannelAvailability> = [{ _tag: "NotCarried", why: "StreamingOnly" }]

      source.onmessage?.({ data: slateMessage([{ game, availability }]) })
      const state = yield* until((current) => current.slate.length > 0)

      assert.deepStrictEqual(state.availability.get(GameId.make("401")), availability)
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should skip a malformed message and keep reading", () =>
    Effect.gen(function* () {
      const source = yield* opened()
      source.onopen?.()
      const before = yield* until((state) => state.connection._tag === "Connected")

      source.onmessage?.({ data: "{not json" })
      source.onmessage?.({ data: JSON.stringify({ _tag: "SlateChanged", games: "nope" }) })
      source.onmessage?.({ data: slateMessage([{ game: someGame, availability: [] }]) })
      const after = yield* until((state) => state.slate.length > 0)

      assert.strictEqual(after.connection, before.connection)
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should open /api/live and close it when the registry goes", () =>
    Effect.gen(function* () {
      const source = yield* Effect.scoped(Effect.provide(opened(), AtomRegistry.layer))

      assert.strictEqual(source.url, "/api/live")
      assert.isTrue(source.closed)
    })
  )
})

const someGame = new Game({ snapshot: snapshot({ id: GameId.make("401") }), plays: [] })

function until(predicate: (state: Atom.Type<typeof LiveStream.live>) => boolean) {
  return Atom.toStream(LiveStream.live).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption)
  )
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
