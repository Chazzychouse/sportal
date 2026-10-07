import { assert, describe, it } from "@effect/vitest"
import { ChannelAvailability } from "@sportal/domain/Channel"
import { GameId, type GameSnapshot, Network } from "@sportal/domain/Game"
import type { Tile } from "@sportal/domain/Stage"
import { broadcast, liveSnapshot, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Slate } from "./Slate.ts"
import { StageSessions } from "./StageSessions.ts"
import { Source } from "./source/Source.ts"
import { recordedGuide } from "./source/youtube-tv/TestYouTubeTv.ts"
import * as YouTubeTv from "./source/youtube-tv/YouTubeTv.ts"

const espn = Network.make("ESPN")
const espnPlus = Network.make("ESPN+")
const fox = Network.make("FOX")
const slate = [
  liveSnapshot({ id: GameId.make("1"), broadcasts: [broadcast(espn)] }),
  liveSnapshot({ id: GameId.make("2"), broadcasts: [broadcast(espn)] }),
  liveSnapshot({ id: GameId.make("3"), broadcasts: [broadcast(espn)] }),
  liveSnapshot({ id: GameId.make("4"), broadcasts: [broadcast(espnPlus)] }),
  liveSnapshot({ id: GameId.make("5"), broadcasts: [broadcast(fox)] })
]

const ohioStateAtIowa = snapshot({
  id: GameId.make("401858473"),
  status: "live",
  kickoff: DateTime.makeUnsafe("2026-10-03T19:30:00Z"),
  away: { team: team("OSU", "fbs", { name: "Ohio State Buckeyes", location: "Ohio State" }), score: 0 },
  home: { team: team("IOWA", "fbs", { name: "Iowa Hawkeyes", location: "Iowa" }), score: 0 },
  broadcasts: [broadcast("CBS")]
})

// When the recorded guide was read, and News 3's live address in it.
const recordedAt = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T20:24:45Z"))
const news3Live = "https://tv.youtube.com/watch/y6zFA17zDsw?vp=0gEEEgIwAQ%3D%3D"

const TestSessions = sessionsOver(slate)

describe("StageSessions", () => {
  it.effect("applies concurrent commands without losing any", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      yield* Effect.forEach(
        slate.slice(0, 4),
        (snapshot, tile) => sessions.dispatch({ _tag: "Assign", tile, game: snapshot.id }),
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
      yield* TestClock.setTime(recordedAt)
      yield* (yield* Source).readGuide(recordedGuide)
      const sessions = yield* StageSessions
      yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: ohioStateAtIowa.id })
      const stage = yield* sessions.dispatch({ _tag: "Assign", tile: 1, game: GameId.make("4") })
      assert.deepStrictEqual(stage.tiles[0], {
        _tag: "StreamTile",
        game: ohioStateAtIowa.id,
        channel: { name: "News 3", source: "YouTube TV", locator: { _tag: "WebView", url: news3Live } }
      })
      assert.deepStrictEqual(stage.tiles[1], {
        _tag: "DataTile",
        game: GameId.make("4"),
        why: { _tag: "NotInGuide" }
      })
    }).pipe(Effect.provide(sessionsOver([ohioStateAtIowa, ...slate])))
  )

  it.live("refreshes the stage when the source reads a guide", () =>
    Effect.gen(function* () {
      const sessions = yield* StageSessions
      const before = yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("5") })
      assert.deepStrictEqual(before.tiles[0], noGuideTile(GameId.make("5")))

      yield* (yield* Source).readGuide(recordedGuide)
      // The current value is replayed to a new subscriber, so wait for the tile that only a refresh makes.
      const stage = yield* sessions.changes.pipe(
        Stream.filter((stage) => !isNoGuideTile(stage.tiles[0])),
        Stream.take(1),
        Stream.runHead,
        Effect.timeout("2 seconds")
      )
      const tile = Option.getOrThrow(stage).tiles[0]
      assert.deepStrictEqual(tile === undefined || tile._tag === "Empty" ? tile : tile.game, GameId.make("5"))
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
          Effect.as({ games: slate, recentPlays: {} })
        ),
        changes: Stream.empty
      })
      // Depending on StageSessions orders this after the layer has built.
      const readAtOnce = Layer.effectDiscard(
        Effect.gen(function* () {
          yield* StageSessions
          yield* (yield* Source).readGuide(recordedGuide)
        })
      )
      yield* Effect.gen(function* () {
        yield* Deferred.await(refreshed).pipe(Effect.timeout("2 seconds"))
        // Give a second, wrong refresh the chance to happen.
        yield* Effect.yieldNow.pipe(Effect.repeat({ times: 50 }))
        assert.strictEqual(yield* Ref.get(refreshes), 1)
      }).pipe(
        Effect.provide(
          readAtOnce.pipe(
            Layer.provideMerge(StageSessions.layer),
            Layer.provide(Layer.succeed(Slate, fakeSlate)),
            Layer.provide(YouTubeTv.layer)
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
      ).pipe(Layer.provide(YouTubeTv.layer))
      yield* Effect.gen(function* () {
        const sessions = yield* StageSessions
        const source = yield* Source
        const assigning = yield* sessions
          .dispatch({ _tag: "Assign", tile: 0, game: GameId.make("5") })
          .pipe(Effect.forkScoped)
        yield* Deferred.await(reading)
        yield* source.readGuide(recordedGuide)
        yield* Deferred.succeed(release, undefined)
        const assigned = yield* Fiber.join(assigning)
        assert.deepStrictEqual(assigned.tiles[0], noGuideTile(GameId.make("5")))

        const stage = yield* sessions.changes.pipe(
          Stream.filter((stage) => !isNoGuideTile(stage.tiles[0])),
          Stream.take(1),
          Stream.runHead,
          Effect.timeout("2 seconds")
        )
        assert.isTrue(Option.isSome(stage))
      }).pipe(
        Effect.provide(
          StageSessions.layer.pipe(
            Layer.provide(Layer.succeed(Slate, slateOf(slate))),
            Layer.provideMerge(gated)
          )
        )
      )
    })
  )

  it.live("keeps a tile whose game has left the slate as it was when the source reads a guide", () =>
    Effect.gen(function* () {
      const onSlate = yield* Ref.make(slate)
      const fakeSlate = Slate.of({
        latest: Effect.map(Ref.get(onSlate), (games) => ({ games, recentPlays: {} })),
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

        yield* (yield* Source).readGuide(recordedGuide)
        const stage = yield* sessions.changes.pipe(
          Stream.filter((stage) => !isNoGuideTile(stage.tiles[1])),
          Stream.take(1),
          Stream.runHead,
          Effect.timeout("2 seconds")
        )
        // Off the slate it would be a data tile with no stream; the refresh leaves it alone instead.
        assert.deepStrictEqual(Option.getOrThrow(stage).tiles[0], noGuideTile(GameId.make("1")))
      }).pipe(
        Effect.provide(
          StageSessions.layer.pipe(
            Layer.provide(Layer.succeed(Slate, fakeSlate)),
            Layer.provideMerge(YouTubeTv.layer)
          )
        )
      )
    })
  )

  it.effect("keeps a guide-matched tile playing when its guide goes stale", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recordedAt)
      const source = yield* Source
      yield* source.readGuide(recordedGuide)
      const sessions = yield* StageSessions
      const playing = yield* sessions.dispatch({ _tag: "Assign", tile: 0, game: ohioStateAtIowa.id })
      assert.strictEqual(playing.tiles[0]?._tag, "StreamTile")

      yield* TestClock.adjust("45 minutes")
      for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow
      assert.deepStrictEqual(
        (yield* source.availability)(ohioStateAtIowa),
        ChannelAvailability.NoGuide({ source: "YouTube TV" })
      )
      assert.deepStrictEqual((yield* sessions.stage).tiles[0], playing.tiles[0])
    }).pipe(Effect.provide(sessionsOver([ohioStateAtIowa])))
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

/** A Slate that lists `games`, with no changes. */
function slateOf(games: ReadonlyArray<GameSnapshot>) {
  return Slate.of({ latest: Effect.succeed({ games, recentPlays: {} }), changes: Stream.empty })
}

/** StageSessions over a Slate of `games` and YouTube TV with nothing read yet. */
function sessionsOver(games: ReadonlyArray<GameSnapshot>) {
  return StageSessions.layer.pipe(
    Layer.provide(Layer.succeed(Slate, slateOf(games))),
    Layer.provideMerge(YouTubeTv.layer)
  )
}

/** The data tile a game gets while the source has no guide. */
function noGuideTile(game: GameId) {
  return { _tag: "DataTile" as const, game, why: { _tag: "NoGuide" as const } }
}

/** Whether `tile` is the data tile of a game while the source has no guide. */
function isNoGuideTile(tile: Tile | undefined) {
  return tile?._tag === "DataTile" && tile.why._tag === "NoGuide"
}
