import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { GameId, Network } from "@sportal/domain/Game"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as Database from "../database/Database.ts"
import { Slate } from "../Slate.ts"
import { Source } from "../source/Source.ts"
import * as SqlChannelStore from "../source/SqlChannelStore.ts"
import * as YouTubeTv from "../source/youtube-tv/YouTubeTv.ts"
import { StageSessions } from "./StageSessions.ts"

const espn = Network.make("ESPN")
const espnPlus = Network.make("ESPN+")
const espnChannel = {
  name: espn,
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/espn?vp=0gEEEgIwAQ%3D%3D" }
}
const fox = Network.make("FOX")
const slate = [
  game("1", [espn]),
  game("2", [espn]),
  game("3", [espn]),
  game("4", [espnPlus]),
  game("5", [fox])
]

const ohioStateAtIowa = snapshot({
  id: GameId.make("401858473"),
  status: "live",
  kickoff: DateTime.makeUnsafe("2026-10-03T19:30:00Z"),
  away: { team: team("OSU", "fbs", { name: "Ohio State Buckeyes", location: "Ohio State" }), score: 0 },
  home: { team: team("IOWA", "fbs", { name: "Iowa Hawkeyes", location: "Iowa" }), score: 0 },
  broadcasts: [broadcast("CBS")]
})

const TestSessions = StageSessions.layer.pipe(
  Layer.provide(
    Layer.succeed(
      Slate,
      Slate.of({ latest: Effect.succeed({ slate, watchability: [] }), changes: Stream.empty })
    )
  ),
  Layer.provideMerge(sourceKnowingEspn())
)

describe("StageSessions", () => {
  it.effect("applies concurrent commands without losing any", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      yield* Effect.all(
        slate
          .slice(0, 4)
          .map((snapshot, tile) => sessions.dispatch({ _tag: "Assign", tile, game: snapshot.id })),
        { concurrency: "unbounded" }
      )
      const stage = yield* sessions.stage
      assert.isTrue(stage.tiles.every((tile) => tile._tag !== "Empty"))
    }).pipe(Effect.provide(TestSessions))
  )

  it.effect("rejects a command for a missing tile and leaves the stage unchanged", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("1") })
      const before = yield* sessions.stage
      const rejection = yield* sessions.dispatch({ _tag: "FocusAudio", tile: 9 }).pipe(Effect.flip)
      assert.strictEqual(rejection.reason, "no-such-tile")
      assert.deepStrictEqual(yield* sessions.stage, before)
    }).pipe(Effect.provide(TestSessions))
  )

  it.effect("assigns a carried game as a stream tile and any other as a data tile", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("1") })
      const stage = yield* sessions.dispatch({ _tag: "Assign", tile: 1, game: GameId.make("4") })
      assert.deepStrictEqual(stage.tiles[0], {
        _tag: "StreamTile",
        game: GameId.make("1"),
        channel: espnChannel,
        learnedFor: espn
      })
      assert.deepStrictEqual(stage.tiles[1], {
        _tag: "DataTile",
        game: GameId.make("4"),
        why: { _tag: "NoStream" }
      })
    }).pipe(Effect.provide(TestSessions))
  )

  it.live("refreshes the stage when the source learns a channel", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      const picking = yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("5") })
      assert.strictEqual(picking.tiles[0]?._tag, "PickingChannel")

      yield* (yield* Source).learn(fox, "https://tv.youtube.com/watch/fox")
      // The current value is replayed to a new subscriber, so wait for the tile that only a refresh makes.
      const stage = yield* sessions.changes.pipe(
        Stream.filter((stage) => stage.tiles[0]?._tag === "StreamTile"),
        Stream.take(1),
        Stream.runHead,
        Effect.timeout("2 seconds")
      )
      const tile = Option.getOrThrow(stage).tiles[0]
      assert.deepStrictEqual(tile?._tag === "StreamTile" ? tile.learnedFor : tile, fox)
      assert.deepStrictEqual(tile?._tag === "StreamTile" ? tile.game : tile, GameId.make("5"))
    }).pipe(Effect.provide(TestSessions))
  )

  it.live("does not miss a change made the moment the layer has built", () =>
    Effect.gen(function* () {
      const refreshed = yield* Deferred.make<void>()
      const refreshes = yield* Ref.make(0)
      // Reading the slate is the first step of every refresh, so it counts them.
      const fakeSlate = Slate.of({
        latest: Ref.update(refreshes, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(refreshed, undefined)),
          Effect.as({ slate, watchability: [] })
        ),
        changes: Stream.empty
      })
      // Depending on StageSessions orders this after the layer has built.
      const learnAtOnce = Layer.effectDiscard(
        Effect.gen(function* () {
          yield* StageSessions
          yield* (yield* Source).learn(fox, "https://tv.youtube.com/watch/fox")
        })
      )
      yield* Effect.gen(function* () {
        yield* Deferred.await(refreshed).pipe(Effect.timeout("2 seconds"))
        // Give a second, wrong refresh the chance to happen.
        yield* Effect.yieldNow.pipe(Effect.repeat({ times: 50 }))
        assert.strictEqual(yield* Ref.get(refreshes), 1)
      }).pipe(
        Effect.provide(
          learnAtOnce.pipe(
            Layer.provideMerge(StageSessions.layer),
            Layer.provide(Layer.succeed(Slate, fakeSlate)),
            Layer.provide(sourceKnowingEspn())
          )
        )
      )
    })
  )

  it.live("applies a command with availability as it is when the command lands, not as it was read", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const gated = Layer.effect(
        Source,
        Effect.gen(function* () {
          const source = yield* Source
          let gate = true
          // The first availability read returns what it saw, then waits to be released: a stale read.
          const availability = Effect.gen(function* () {
            const seen = yield* source.availability
            if (gate) {
              gate = false
              yield* Deferred.succeed(reading, undefined)
              yield* Deferred.await(release)
            }
            return seen
          })
          return Source.of({ ...source, availability })
        })
      ).pipe(Layer.provide(sourceKnowingEspn()))
      yield* Effect.gen(function* () {
        const sessions = yield* StageSessions
        const source = yield* Source
        const assigning = yield* sessions
          .dispatch({ _tag: "Assign", tile: 0, game: GameId.make("5") })
          .pipe(Effect.forkScoped)
        yield* Deferred.await(reading)
        yield* source.learn(fox, "https://tv.youtube.com/watch/fox")
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(assigning)

        const stage = yield* sessions.changes.pipe(
          Stream.filter((stage) => stage.tiles[0]?._tag === "StreamTile"),
          Stream.take(1),
          Stream.runHead,
          Effect.timeout("2 seconds")
        )
        assert.isTrue(Option.isSome(stage))
      }).pipe(
        Effect.provide(
          StageSessions.layer.pipe(
            Layer.provide(
              Layer.succeed(
                Slate,
                Slate.of({ latest: Effect.succeed({ slate, watchability: [] }), changes: Stream.empty })
              )
            ),
            Layer.provideMerge(gated)
          )
        )
      )
    })
  )

  it.live("keeps a playing tile whose game has left the slate when another network is learned", () =>
    Effect.gen(function* () {
      const onSlate = yield* Ref.make(slate)
      const fakeSlate = Slate.of({
        latest: Effect.map(Ref.get(onSlate), (current) => ({ slate: current, watchability: [] })),
        changes: Stream.empty
      })
      yield* Effect.gen(function* () {
        const sessions = yield* StageSessions
        yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("1") })
        yield* sessions.dispatch({ _tag: "Assign", tile: 1, game: GameId.make("5") })
        yield* Ref.set(
          onSlate,
          slate.filter((snapshot) => snapshot.id !== GameId.make("1"))
        )

        yield* (yield* Source).learn(fox, "https://tv.youtube.com/watch/fox")
        const stage = yield* sessions.changes.pipe(
          Stream.filter((stage) => stage.tiles[1]?._tag === "StreamTile"),
          Stream.take(1),
          Stream.runHead,
          Effect.timeout("2 seconds")
        )
        const tiles = Option.getOrThrow(stage).tiles
        assert.deepStrictEqual(tiles[0], {
          _tag: "StreamTile",
          game: GameId.make("1"),
          channel: espnChannel,
          learnedFor: espn
        })
      }).pipe(
        Effect.provide(
          StageSessions.layer.pipe(
            Layer.provide(Layer.succeed(Slate, fakeSlate)),
            Layer.provideMerge(sourceKnowingEspn())
          )
        )
      )
    })
  )

  it.effect("keeps a guide-matched tile playing when its guide goes stale and the lineup answers", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T20:24:45Z")))
      const source = yield* Source
      yield* source.readGuide(
        readFileSync(
          new URL("../source/youtube-tv/fixtures/guide-2026-10-03T2024Z.json", import.meta.url),
          "utf8"
        )
      )
      const sessions = yield* StageSessions
      const playing = yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: ohioStateAtIowa.id })
      assert.strictEqual(playing.tiles[0]?._tag, "StreamTile")

      yield* TestClock.adjust("45 minutes")
      for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow
      // The lineup answers now, and has never heard of CBS.
      assert.strictEqual((yield* source.availability)(ohioStateAtIowa)._tag, "Unlearned")
      assert.deepStrictEqual((yield* sessions.stage).tiles[0], playing.tiles[0])
    }).pipe(
      Effect.provide(
        StageSessions.layer.pipe(
          Layer.provide(
            Layer.succeed(
              Slate,
              Slate.of({
                latest: Effect.succeed({ slate: [ohioStateAtIowa], watchability: [] }),
                changes: Stream.empty
              })
            )
          ),
          Layer.provideMerge(sourceKnowingEspn())
        )
      )
    )
  )

  it.effect("assigns a game missing from the slate as a data tile", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      const stage = yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("gone") })
      assert.deepStrictEqual(stage.tiles[0], {
        _tag: "DataTile",
        game: GameId.make("gone"),
        why: { _tag: "NoStream" }
      })
    }).pipe(Effect.provide(TestSessions))
  )
})

function game(id: string, broadcasts: ReadonlyArray<Network>) {
  return snapshot({
    id: GameId.make(id),
    status: "live",
    period: 1,
    clock: "10:00",
    broadcasts: broadcasts.map((network) => broadcast(network))
  })
}

/** YouTube TV over an in-memory database, already knowing ESPN's channel and that ESPN+ is not carried. */
function sourceKnowingEspn() {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const source = yield* Source
      yield* source.learn(espn, "https://tv.youtube.com/watch/espn")
      yield* source.markNotCarried(espnPlus)
    })
  ).pipe(
    Layer.provideMerge(YouTubeTv.layer),
    Layer.provide(SqlChannelStore.layer),
    Layer.provide(Database.layer(":memory:"))
  )
}
