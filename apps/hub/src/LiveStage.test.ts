import { assert, describe, it } from "@effect/vitest"
import { ChannelAvailability } from "@sportal/domain/Channel"
import { GameId, type GameSnapshot, Network } from "@sportal/domain/Game"
import { Slate } from "@sportal/domain/Slate"
import type { Stage, Tile } from "@sportal/domain/Stage"
import { broadcast, liveSnapshot, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { LiveSlate, type Published } from "./LiveSlate.ts"
import { LiveStage } from "./LiveStage.ts"
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

describe("LiveStage", () => {
  it.effect("should apply concurrent commands without losing any", () =>
    Effect.gen(function* () {
      const liveStage = yield* LiveStage

      yield* Effect.forEach(
        slate.slice(0, 4),
        (snapshot, tile) => liveStage.dispatch({ _tag: "Assign", tile, game: snapshot.id }),
        { concurrency: "unbounded" }
      )

      const stage = yield* liveStage.stage
      assert.isTrue(stage.tiles.every((tile) => tile._tag !== "Empty"))
    }).pipe(Effect.provide(liveStageOver(slate)))
  )

  it.effect("should reject a command for a missing tile, leaving the stage unchanged", () =>
    Effect.gen(function* () {
      const liveStage = yield* LiveStage
      yield* liveStage.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("1") })
      const before = yield* liveStage.stage

      const rejection = yield* liveStage.dispatch({ _tag: "FocusAudio", tile: 9 }).pipe(Effect.flip)

      const after = yield* liveStage.stage
      assert.strictEqual(rejection.reason, "no-such-tile")
      assert.deepStrictEqual(after, before)
    }).pipe(Effect.provide(liveStageOver(slate)))
  )

  it.effect("should assign a game the guide carries as a stream tile", () =>
    Effect.gen(function* () {
      const liveStage = yield* LiveStage
      yield* guideReadAtRecording()

      const stage = yield* liveStage.dispatch({ _tag: "Assign", tile: 0, game: ohioStateAtIowa.id })

      assert.deepStrictEqual(stage.tiles[0], {
        _tag: "StreamTile",
        game: ohioStateAtIowa.id,
        channel: { name: "News 3", source: "YouTube TV", locator: { _tag: "WebView", url: news3Live } }
      })
    }).pipe(Effect.provide(liveStageOver([ohioStateAtIowa, ...slate])))
  )

  it.effect("should assign a game the guide does not carry as a data tile, not in the guide", () =>
    Effect.gen(function* () {
      const liveStage = yield* LiveStage
      yield* guideReadAtRecording()
      yield* liveStage.dispatch({ _tag: "Assign", tile: 0, game: ohioStateAtIowa.id })

      const stage = yield* liveStage.dispatch({ _tag: "Assign", tile: 1, game: GameId.make("4") })

      assert.deepStrictEqual(stage.tiles[1], {
        _tag: "DataTile",
        game: GameId.make("4"),
        why: { _tag: "NotInGuide" }
      })
    }).pipe(Effect.provide(liveStageOver([ohioStateAtIowa, ...slate])))
  )

  it.effect("should assign a game as a data tile with no guide while the source has read none", () =>
    Effect.gen(function* () {
      const liveStage = yield* LiveStage

      const stage = yield* liveStage.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("5") })

      assert.deepStrictEqual(stage.tiles[0], noGuideTile(GameId.make("5")))
    }).pipe(Effect.provide(liveStageOver(slate)))
  )

  it.live("should refresh the stage when the source reads a guide", () =>
    Effect.gen(function* () {
      const liveStage = yield* LiveStage
      const source = yield* Source
      yield* liveStage.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("5") })

      yield* source.readGuide(recordedGuide)

      const stage = yield* firstStageWhere(liveStage.changes, (stage) => !isNoGuideTile(stage.tiles[0]))
      const tile = Option.getOrThrow(stage).tiles[0]
      assert.deepStrictEqual(tile === undefined || tile._tag === "Empty" ? tile : tile.game, GameId.make("5"))
    }).pipe(Effect.provide(liveStageOver(slate)))
  )

  it.live("should not miss a change made the moment the layer has built", () =>
    Effect.gen(function* () {
      const refreshed = yield* Deferred.make<void>()
      const refreshes = yield* Ref.make(0)
      // Reading the slate is the first step of every refresh, so it counts them.
      const countingSlate = slateOf(
        Ref.update(refreshes, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(refreshed, undefined)),
          Effect.as({ games: slate, recentPlays: {} })
        )
      )
      const guideReadAtOnce = readAtOnce().pipe(
        Layer.provideMerge(LiveStage.layer),
        Layer.provide(Layer.succeed(LiveSlate, countingSlate)),
        Layer.provide(YouTubeTv.layer)
      )

      yield* Effect.gen(function* () {
        yield* Deferred.await(refreshed).pipe(Effect.timeout("2 seconds"))
        // Give a second, wrong refresh the chance to happen.
        yield* Effect.yieldNow.pipe(Effect.repeat({ times: 50 }))
      }).pipe(Effect.provide(guideReadAtOnce))

      const count = yield* Ref.get(refreshes)
      assert.strictEqual(count, 1)
    })
  )

  it.live(
    "should apply a command with availability as it is when the command lands, not as it was read",
    () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const liveStageOnStaleRead = LiveStage.layer.pipe(
          Layer.provide(Layer.succeed(LiveSlate, slateOf(Effect.succeed({ games: slate, recentPlays: {} })))),
          Layer.provideMerge(availabilityHeldOnce(reading, release))
        )

        const { assigned, stage } = yield* Effect.gen(function* () {
          const liveStage = yield* LiveStage
          const source = yield* Source
          const assigning = yield* liveStage
            .dispatch({ _tag: "Assign", tile: 0, game: GameId.make("5") })
            .pipe(Effect.forkScoped)
          yield* Deferred.await(reading)
          yield* source.readGuide(recordedGuide)
          yield* Deferred.succeed(release, undefined)

          const assigned = yield* Fiber.join(assigning)
          const stage = yield* firstStageWhere(liveStage.changes, (stage) => !isNoGuideTile(stage.tiles[0]))
          return { assigned, stage }
        }).pipe(Effect.provide(liveStageOnStaleRead))

        assert.deepStrictEqual(assigned.tiles[0], noGuideTile(GameId.make("5")))
        assert.isTrue(Option.isSome(stage))
      })
  )

  it.live("should keep a tile whose game has left the slate as it was when the source reads a guide", () =>
    Effect.gen(function* () {
      const onSlate = yield* Ref.make(slate)
      const changingSlate = slateOf(Effect.map(Ref.get(onSlate), (games) => ({ games, recentPlays: {} })))
      const liveStageOverChangingSlate = LiveStage.layer.pipe(
        Layer.provide(Layer.succeed(LiveSlate, changingSlate)),
        Layer.provideMerge(YouTubeTv.layer)
      )

      const stage = yield* Effect.gen(function* () {
        const liveStage = yield* LiveStage
        const source = yield* Source
        yield* liveStage.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("1") })
        yield* liveStage.dispatch({ _tag: "Assign", tile: 1, game: GameId.make("5") })
        yield* Ref.set(
          onSlate,
          slate.filter((snapshot) => snapshot.id !== GameId.make("1"))
        )

        yield* source.readGuide(recordedGuide)

        return yield* firstStageWhere(liveStage.changes, (stage) => !isNoGuideTile(stage.tiles[1]))
      }).pipe(Effect.provide(liveStageOverChangingSlate))

      // Off the slate it would be a data tile with no stream; the refresh leaves it alone instead.
      assert.deepStrictEqual(Option.getOrThrow(stage).tiles[0], noGuideTile(GameId.make("1")))
    })
  )

  it.effect("should keep a guide-matched tile playing when its guide goes stale", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const liveStage = yield* LiveStage
      yield* guideReadAtRecording()
      const playing = yield* liveStage.dispatch({ _tag: "Assign", tile: 0, game: ohioStateAtIowa.id })

      yield* TestClock.adjust("45 minutes")
      for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow

      const availability = yield* source.availability
      const stage = yield* liveStage.stage
      assert.strictEqual(playing.tiles[0]?._tag, "StreamTile")
      assert.deepStrictEqual(
        availability(ohioStateAtIowa),
        ChannelAvailability.NoGuide({ source: "YouTube TV" })
      )
      assert.deepStrictEqual(stage.tiles[0], playing.tiles[0])
    }).pipe(Effect.provide(liveStageOver([ohioStateAtIowa])))
  )

  it.effect("should assign a game missing from the slate as a data tile", () =>
    Effect.gen(function* () {
      const liveStage = yield* LiveStage

      const stage = yield* liveStage.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("gone") })

      assert.deepStrictEqual(stage.tiles[0], {
        _tag: "DataTile",
        game: GameId.make("gone"),
        why: { _tag: "NoStream" }
      })
    }).pipe(Effect.provide(liveStageOver(slate)))
  )
})

/** The source reads the recorded guide at the moment it was recorded. */
function guideReadAtRecording() {
  return Effect.gen(function* () {
    const source = yield* Source

    yield* TestClock.setTime(recordedAt)
    yield* source.readGuide(recordedGuide)
  })
}

/** Reads the recorded guide as soon as LiveStage is built: depending on LiveStage orders it after the layer. */
function readAtOnce() {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      yield* LiveStage
      const source = yield* Source

      yield* source.readGuide(recordedGuide)
    })
  )
}

/**
 * YouTube TV whose first availability read returns what it saw, then tells `reading` and waits for `release`: a stale
 * read.
 */
function availabilityHeldOnce(reading: Deferred.Deferred<void>, release: Deferred.Deferred<void>) {
  return Layer.effect(
    Source,
    Effect.gen(function* () {
      const source = yield* Source
      let gate = true
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
}

/**
 * The first stage of `changes` that passes `test`, within two seconds. The current stage is replayed to a new
 * subscriber, so a test waits for a stage only the change it awaits makes.
 */
function firstStageWhere(changes: Stream.Stream<Stage>, test: (stage: Stage) => boolean) {
  return changes.pipe(Stream.filter(test), Stream.take(1), Stream.runHead, Effect.timeout("2 seconds"))
}

/** A LiveSlate that publishes what `published` gives, with no changes, and holds nothing else. */
function slateOf(published: Effect.Effect<Published>) {
  return LiveSlate.of({
    latest: Effect.succeed(Slate.empty),
    changes: Stream.empty,
    events: Stream.empty,
    resyncs: Effect.succeed(Stream.empty),
    through: () => Effect.succeed(Slate.empty),
    published,
    publishedChanges: Stream.empty
  })
}

/** LiveStage over a LiveSlate of `games` and YouTube TV with nothing read yet. */
function liveStageOver(games: ReadonlyArray<GameSnapshot>) {
  return LiveStage.layer.pipe(
    Layer.provide(Layer.succeed(LiveSlate, slateOf(Effect.succeed({ games, recentPlays: {} })))),
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
