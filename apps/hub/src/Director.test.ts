import { assert, describe, it } from "@effect/vitest"
import { ChannelAvailability } from "@sportal/domain/Channel"
import { GameId, GameSnapshot, Network } from "@sportal/domain/Game"
import type { Play } from "@sportal/domain/Play"
import { type Screen, Tile } from "@sportal/domain/Screen"
import { broadcast, liveSnapshot, play, snapshot, team } from "@sportal/domain/TestGame"
import {
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Ref,
  Stream,
  type Tracer
} from "effect"
import { TestClock } from "effect/testing"
import { Director } from "./Director.ts"
import { decodedFrames, recordedNeAtBuf, recordedPlays } from "./provider/espn/TestEspn.ts"
import { Provider, ProviderFeed } from "./provider/Provider.ts"
import { Delivery } from "./slate/Delivery.ts"
import { Slate } from "./slate/Slate.ts"
import { Source } from "./source/Source.ts"
import { recordedGuide } from "./source/youtube-tv/TestYouTubeTv.ts"
import * as YouTubeTv from "./source/youtube-tv/YouTubeTv.ts"
import { delivered, directorOver } from "./TestDirector.ts"
import { gauged, recordingLogs, recordingSpans, withMetrics } from "./TestTelemetry.ts"

const one = GameId.make("1")
const two = GameId.make("2")
const three = GameId.make("3")
const neAtBuf = GameId.make("401872971")

describe("Director, the slate", () => {
  it.effect("should start from the empty slate", () =>
    Effect.gen(function* () {
      const current = yield* latest

      assert.strictEqual(current, Slate.empty)
    }).pipe(Effect.provide(directed))
  )

  it.effect("should take a listing delivered, keeping its games in order", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const live = liveSnapshot({ id: one })
      const soon = snapshot({ id: two, kickoff: DateTime.add(now, { minutes: 20 }) })
      const later = snapshot({ id: three, kickoff: DateTime.add(now, { hours: 3 }) })

      const current = yield* listing([live, soon, later])

      assert.deepStrictEqual(
        current.games.map(({ snapshot }) => snapshot),
        [live, soon, later]
      )
    }).pipe(Effect.provide(directed))
  )

  it.effect("should ignore a snapshot behind its game's", () =>
    Effect.gen(function* () {
      yield* listing([snapshot({ id: one, status: "live", period: 2, clock: "5:00" })])

      const current = yield* takenSnapshot(snapshot({ id: one, status: "live", period: 1, clock: "5:00" }))

      assert.strictEqual(snapshotIn(current, one)?.period, 2)
    }).pipe(Effect.provide(directed))
  )

  it.effect("should keep a snapshot of its own for each game", () =>
    Effect.gen(function* () {
      const first = liveSnapshot({ id: one, clock: "9:00" })
      const second = snapshot({ id: two, status: "live", period: 3, clock: "1:00" })
      yield* listing([liveSnapshot({ id: one }), snapshot({ id: two, status: "live", period: 2 })])

      yield* takenSnapshot(first)
      const current = yield* takenSnapshot(second)

      assert.deepStrictEqual(snapshotIn(current, one), first)
      assert.deepStrictEqual(snapshotIn(current, two), second)
    }).pipe(Effect.provide(directed))
  )

  it.effect("should take a listed game's plays", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one })])

      const current = yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [play()] }))

      assert.deepStrictEqual(playsIn(current, one), [play()])
    }).pipe(Effect.provide(directed))
  )

  it.effect("should drop plays for a game no listing names", () =>
    Effect.gen(function* () {
      const current = yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [play()] }))

      assert.deepStrictEqual(current.games, [])
    }).pipe(Effect.provide(directed))
  )

  it.effect("should take every delivery of a frame", () =>
    Effect.gen(function* () {
      const feed = yield* ProviderFeed
      const next = liveSnapshot({ id: one, clock: "9:00" })

      yield* feed.deliver([
        listingOf([liveSnapshot({ id: one })]),
        Delivery.cases.Snapshot.make({ snapshot: next })
      ])
      const current = yield* latest

      assert.strictEqual(snapshotIn(current, one), next)
    }).pipe(Effect.provide(directed))
  )

  it.effect("should span each take with its count of deliveries", () => {
    const ended: Array<Tracer.Span> = []
    return Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one })])

      // `deliver` answers once the Director has asked for the next frame, which can be before the span around it ends.
      const take = yield* Effect.yieldNow.pipe(
        Effect.andThen(Effect.sync(() => ended.find((span) => span.name === "Director.take"))),
        Effect.repeat({ until: (span) => span !== undefined, times: 100 })
      )

      assert.isDefined(take, "the take's span ended")
      assert.strictEqual(take?.attributes.get("sportal.deliveries"), 1)
    }).pipe(Effect.provide(directed.pipe(Layer.provideMerge(recordingSpans(ended)))))
  })

  it.effect("should log at Error when the provider's frames end", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* Director

      yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => logs.length > 0, times: 100 }))
      const stopped = logs.filter(({ level }) => level === "Error")
      assert.strictEqual(stopped.length, 1)
      assert.include(stopped[0]?.message, "the provider's frames stopped")
      assert.include(stopped[0]?.message, "the provider's frames ended")
    }).pipe(
      Effect.provide(
        Director.layer.pipe(
          Layer.provide(Provider.layerTest(Stream.empty)),
          Layer.provide(YouTubeTv.layer),
          Layer.provideMerge(layer)
        )
      )
    )
  })
})

describe("Director#slateChanges", () => {
  it.effect("should give the latest, then each change once", () =>
    Effect.gen(function* () {
      const director = yield* Director
      const published = yield* Ref.make<ReadonlyArray<GameSnapshot | undefined>>([])
      yield* director.slateChanges.pipe(
        Stream.runForEach((current) => Ref.update(published, (all) => [...all, snapshotIn(current, one)])),
        Effect.forkScoped({ startImmediately: true })
      )
      const first = liveSnapshot({ id: one })
      const second = liveSnapshot({ id: one, clock: "9:00" })

      yield* listing([first])
      yield* takenSnapshot(second)
      yield* Effect.yieldNow
      const all = yield* Ref.get(published)

      assert.deepStrictEqual(all, [undefined, first, second])
    }).pipe(Effect.provide(directed))
  )

  it.effect("should give no change for a take that changes nothing", () =>
    Effect.gen(function* () {
      const director = yield* Director
      const published = yield* Ref.make(0)
      yield* director.slateChanges.pipe(
        Stream.runForEach(() => Ref.update(published, (count) => count + 1)),
        Effect.forkScoped({ startImmediately: true })
      )
      yield* listing([liveSnapshot({ id: one })])

      yield* takenSnapshot(liveSnapshot({ id: one, clock: "11:00" }))
      yield* Effect.yieldNow
      const count = yield* Ref.get(published)

      assert.strictEqual(count, 2)
    }).pipe(Effect.provide(directed))
  )
})

describe("Director, a take that raises a defect", () => {
  it.effect("should keep the slate as it was", () =>
    Effect.gen(function* () {
      const before = yield* listing([liveSnapshot({ id: one, clock: "9:00" })])

      const current = yield* takenSnapshot(broken(one))

      assert.strictEqual(current, before)
    }).pipe(Effect.provide(directed))
  )

  it.effect("should log the defect at Error with its cause", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one, clock: "9:00" })])

      yield* takenSnapshot(broken(one))
      const errors = logs.filter(({ level }) => level === "Error")

      assert.strictEqual(errors.length, 1)
      assert.include(errors[0]?.message, "a take raised a defect; the slate keeps what it had")
      assert.include(errors[0]?.cause, "a broken snapshot")
    }).pipe(Effect.provide(directed.pipe(Layer.provideMerge(layer))))
  })

  it.effect("should take the game's next snapshot", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one, clock: "9:00" })])
      yield* takenSnapshot(broken(one))
      const next = liveSnapshot({ id: one, clock: "7:00" })

      const current = yield* takenSnapshot(next)

      assert.strictEqual(snapshotIn(current, one), next)
    }).pipe(Effect.provide(directed))
  )
})

describe("Director, a recorded game", () => {
  it.effect(
    "should take NE at BUF's recorded day to its final, with every play the recording has, logging no error",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        const frames = yield* recordedNeAtBuf
        const decoded = yield* decodedFrames(frames)
        const feed = yield* ProviderFeed

        yield* Effect.forEach(decoded, (deliveries) => feed.deliver(deliveries), { discard: true })
        const current = yield* latest
        const errors = logs.filter(({ level }) => level === "Error")

        assert.strictEqual(snapshotIn(current, neAtBuf)?.status, "final")
        assert.strictEqual(playsIn(current, neAtBuf).length, recordedPlays)
        assert.deepStrictEqual(errors, [])
      }).pipe(Effect.provide(directed.pipe(Layer.provideMerge(layer))))
    },
    { timeout: 60_000 }
  )
})

describe("Director's game state gauge", () => {
  it.effect("should gauge a listed live game as 2", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one })])

      const value = yield* gauged("sportal_game_state", { game: one })

      assert.strictEqual(value, 2)
    }).pipe(Effect.provide(directed), withMetrics)
  )

  it.effect("should gauge a game no listing names any more as 0", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one }), liveSnapshot({ id: two })])

      yield* listing([liveSnapshot({ id: two })])
      const value = yield* gauged("sportal_game_state", { game: one })

      assert.strictEqual(value, 0)
    }).pipe(Effect.provide(directed), withMetrics)
  )
})

const latest = Director.use((director) => director.slate)

function snapshotIn(slate: Slate, id: GameId): GameSnapshot | undefined {
  return Option.getOrUndefined(slate.game(id))?.snapshot
}

function playsIn(slate: Slate, id: GameId): ReadonlyArray<Play> {
  return Option.match(slate.game(id), { onNone: () => [], onSome: ({ plays }) => plays })
}

function listingOf(games: ReadonlyArray<GameSnapshot>) {
  return Delivery.cases.Listing.make({ league: "fbs", games })
}

/** Delivers an FBS listing of `games`, giving the Director's slate once it has taken it. */
function listing(games: ReadonlyArray<GameSnapshot>) {
  return delivered(listingOf(games))
}

function takenSnapshot(game: GameSnapshot) {
  return delivered(Delivery.cases.Snapshot.make({ snapshot: game }))
}

/** A live snapshot of game `id` at 8:00 in the first period whose progress raises a defect. */
function broken(id: GameId): GameSnapshot {
  class Broken extends GameSnapshot {
    override progress(): never {
      throw new Error("a broken snapshot")
    }
  }
  return new Broken({ ...liveSnapshot({ id, clock: "8:00" }) })
}

const espn = Network.make("ESPN")
const espnPlus = Network.make("ESPN+")
const fox = Network.make("FOX")
const games = [
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

describe("Director, the Screen", () => {
  it.effect("should apply concurrent commands without losing any", () =>
    Effect.gen(function* () {
      const director = yield* Director

      yield* Effect.forEach(
        games.slice(0, 4),
        (snapshot, tile) => director.dispatch({ _tag: "Assign", tile, game: snapshot.id }),
        { concurrency: "unbounded" }
      )

      const screen = yield* director.screen
      assert.isTrue(screen.tiles.every((tile) => !Tile.guards.Empty(tile)))
    }).pipe(Effect.provide(directing(games)))
  )

  it.effect("should reject a command for a missing tile, leaving the screen unchanged", () =>
    Effect.gen(function* () {
      const director = yield* Director
      yield* director.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("1") })
      const before = yield* director.screen

      const rejection = yield* director.dispatch({ _tag: "FocusAudio", tile: 9 }).pipe(Effect.flip)

      const after = yield* director.screen
      assert.strictEqual(rejection.reason, "no-such-tile")
      assert.deepStrictEqual(after, before)
    }).pipe(Effect.provide(directing(games)))
  )

  it.effect("should assign a game the guide carries as a stream tile", () =>
    Effect.gen(function* () {
      const director = yield* Director
      yield* guideReadAtRecording()

      const screen = yield* director.dispatch({ _tag: "Assign", tile: 0, game: ohioStateAtIowa.id })

      assert.deepStrictEqual(screen.tiles[0], {
        _tag: "StreamTile",
        game: ohioStateAtIowa.id,
        channel: { name: "News 3", source: "YouTube TV", locator: { _tag: "WebView", url: news3Live } }
      })
    }).pipe(Effect.provide(directing([ohioStateAtIowa, ...games])))
  )

  it.effect("should assign a game the guide does not carry as a data tile, not in the guide", () =>
    Effect.gen(function* () {
      const director = yield* Director
      yield* guideReadAtRecording()
      yield* director.dispatch({ _tag: "Assign", tile: 0, game: ohioStateAtIowa.id })

      const screen = yield* director.dispatch({ _tag: "Assign", tile: 1, game: GameId.make("4") })

      assert.deepStrictEqual(screen.tiles[1], {
        _tag: "DataTile",
        game: GameId.make("4"),
        why: { _tag: "NotInGuide" }
      })
    }).pipe(Effect.provide(directing([ohioStateAtIowa, ...games])))
  )

  it.effect("should assign a game as a data tile with no guide while the source has read none", () =>
    Effect.gen(function* () {
      const director = yield* Director

      const screen = yield* director.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("5") })

      assert.deepStrictEqual(screen.tiles[0], noGuideTile(GameId.make("5")))
    }).pipe(Effect.provide(directing(games)))
  )

  it.live("should refresh the screen when the source reads a guide", () =>
    Effect.gen(function* () {
      const director = yield* Director
      const source = yield* Source
      yield* director.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("5") })

      yield* source.readGuide(recordedGuide)

      const screen = yield* firstScreenWhere(
        director.screenChanges,
        (screen) => !isNoGuideTile(screen.tiles[0])
      )
      const tile = Option.getOrThrow(screen).tiles[0]
      assert.deepStrictEqual(
        tile === undefined || Tile.guards.Empty(tile) ? tile : tile.game,
        GameId.make("5")
      )
    }).pipe(Effect.provide(directing(games)))
  )

  it.live("should publish no Screen change when a refresh changes no tile", () =>
    Effect.gen(function* () {
      const pulses = yield* Queue.unbounded<void>()
      const answering = Source.layerTest(
        () => ChannelAvailability.NoGuide({ source: "YouTube TV" }),
        Stream.fromQueue(pulses)
      )

      const published = yield* Effect.gen(function* () {
        const director = yield* Director
        yield* director.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("5") })
        const next = yield* director.screenChanges.pipe(
          Stream.drop(1),
          Stream.runHead,
          Effect.timeoutOption("200 millis"),
          Effect.forkScoped
        )
        yield* Effect.yieldNow

        yield* Queue.offer(pulses, undefined)

        return yield* Fiber.join(next)
      }).pipe(
        Effect.provide(listed(games).pipe(Layer.provideMerge(directorOver), Layer.provideMerge(answering)))
      )

      assert.isTrue(Option.isNone(published))
    })
  )

  it.live("should not miss a change made the moment the layer has built", () =>
    Effect.gen(function* () {
      const refreshed = yield* Deferred.make<void>()
      const refreshes = yield* Ref.make(0)
      // Reading availability is a step of every refresh, and nothing else here reads it, so it counts them.
      const countingSource = Layer.effect(
        Source,
        Effect.gen(function* () {
          const source = yield* Source
          const availability = Ref.update(refreshes, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(refreshed, undefined)),
            Effect.andThen(source.availability)
          )
          return Source.of({ ...source, availability })
        })
      ).pipe(Layer.provide(YouTubeTv.layer))
      const guideReadAtOnce = readAtOnce().pipe(
        Layer.provideMerge(Director.layer),
        Layer.provide(Provider.layerTestFed),
        Layer.provide(countingSource)
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
        const directorOnStaleRead = listed(games).pipe(
          Layer.provideMerge(Director.layer),
          Layer.provideMerge(Provider.layerTestFed),
          Layer.provideMerge(availabilityHeldOnce(reading, release))
        )

        const { assigned, screen } = yield* Effect.gen(function* () {
          const director = yield* Director
          const source = yield* Source
          const assigning = yield* director
            .dispatch({ _tag: "Assign", tile: 0, game: GameId.make("5") })
            .pipe(Effect.forkScoped)
          yield* Deferred.await(reading)
          yield* source.readGuide(recordedGuide)
          yield* Deferred.succeed(release, undefined)

          const assigned = yield* Fiber.join(assigning)
          const screen = yield* firstScreenWhere(
            director.screenChanges,
            (screen) => !isNoGuideTile(screen.tiles[0])
          )
          return { assigned, screen }
        }).pipe(Effect.provide(directorOnStaleRead))

        assert.deepStrictEqual(assigned.tiles[0], noGuideTile(GameId.make("5")))
        assert.isTrue(Option.isSome(screen))
      })
  )

  it.live("should keep a tile whose game has left the slate as it was when the source reads a guide", () =>
    Effect.gen(function* () {
      const screen = yield* Effect.gen(function* () {
        const director = yield* Director
        const source = yield* Source
        const feed = yield* ProviderFeed
        yield* director.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("1") })
        yield* director.dispatch({ _tag: "Assign", tile: 1, game: GameId.make("5") })
        yield* feed.deliver(listings(games.filter((snapshot) => snapshot.id !== GameId.make("1"))))

        yield* source.readGuide(recordedGuide)

        return yield* firstScreenWhere(director.screenChanges, (screen) => !isNoGuideTile(screen.tiles[1]))
      }).pipe(Effect.provide(directing(games)))

      // Off the slate it would be a data tile with no stream; the refresh leaves it alone instead.
      assert.deepStrictEqual(Option.getOrThrow(screen).tiles[0], noGuideTile(GameId.make("1")))
    })
  )

  it.effect("should keep a guide-matched tile playing when its guide goes stale", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const director = yield* Director
      yield* guideReadAtRecording()
      const playing = yield* director.dispatch({ _tag: "Assign", tile: 0, game: ohioStateAtIowa.id })

      yield* TestClock.adjust("45 minutes")
      for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow

      const availability = yield* source.availability
      const screen = yield* director.screen
      assert.strictEqual(playing.tiles[0]?._tag, "StreamTile")
      assert.deepStrictEqual(
        availability(ohioStateAtIowa),
        ChannelAvailability.NoGuide({ source: "YouTube TV" })
      )
      assert.deepStrictEqual(screen.tiles[0], playing.tiles[0])
    }).pipe(Effect.provide(directing([ohioStateAtIowa])))
  )

  it.effect("should assign a game missing from the slate as a data tile", () =>
    Effect.gen(function* () {
      const director = yield* Director

      const screen = yield* director.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("gone") })

      assert.deepStrictEqual(screen.tiles[0], {
        _tag: "DataTile",
        game: GameId.make("gone"),
        why: { _tag: "NoStream" }
      })
    }).pipe(Effect.provide(directing(games)))
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

/** Reads the recorded guide as soon as the Director is built: depending on it orders this after the layer. */
function readAtOnce() {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Director
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
 * The first screen of `changes` that passes `test`, within two seconds. The current screen is replayed to a new
 * subscriber, so a test waits for a screen only the change it awaits makes.
 */
function firstScreenWhere(changes: Stream.Stream<Screen>, test: (screen: Screen) => boolean) {
  return changes.pipe(Stream.filter(test), Stream.take(1), Stream.runHead, Effect.timeout("2 seconds"))
}

/** Every league's listing of `games`, in their order. */
function listings(games: ReadonlyArray<GameSnapshot>) {
  const leagues = [...new Set(games.map(({ league }) => league))]
  return leagues.map((league) =>
    Delivery.cases.Listing.make({ league, games: games.filter((game) => game.league === league) })
  )
}

/** Delivers every league's listing of `games` once the Director is built. */
function listed(games: ReadonlyArray<GameSnapshot>) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const feed = yield* ProviderFeed

      yield* feed.deliver(listings(games))
    })
  )
}

/** The Director over a fed provider and YouTube TV with nothing read yet, its slate listing `games`. */
function directing(games: ReadonlyArray<GameSnapshot>) {
  return listed(games).pipe(Layer.provideMerge(directed))
}

/** The data tile a game gets while the source has no guide. */
function noGuideTile(game: GameId) {
  return { _tag: "DataTile" as const, game, why: { _tag: "NoGuide" as const } }
}

/** Whether `tile` is the data tile of a game while the source has no guide. */
function isNoGuideTile(tile: Tile | undefined) {
  return tile !== undefined && Tile.guards.DataTile(tile) && Predicate.isTagged(tile.why, "NoGuide")
}

/** The Director over a fed provider, against YouTube TV with nothing read yet; both provided too. */
const directed = directorOver.pipe(Layer.provideMerge(YouTubeTv.layer))
