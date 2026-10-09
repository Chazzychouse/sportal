import { assert, describe, it } from "@effect/vitest"
import type { SlateChanged } from "@sportal/api/LiveMessage"
import { ChannelAvailability } from "@sportal/domain/Channel"
import { GameId, GameSnapshot, Network } from "@sportal/domain/Game"
import { type Play, PlayId } from "@sportal/domain/Play"
import { broadcast, liveSnapshot, play, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Ref, Stream, type Tracer } from "effect"
import { Director } from "./Director.ts"
import { decodedFrames, recordedNeAtBuf, recordedPlays } from "./provider/espn/TestEspn.ts"
import { Delivery, ProviderFeed } from "./provider/Provider.ts"
import { Slate } from "./Slate.ts"
import { GuideReader } from "./source/GuideReader.ts"
import { Source } from "./source/Source.ts"
import { readRecordedGuide } from "./source/youtube-tv/TestYouTubeTv.ts"
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

      const current = yield* delivered(Delivery.Plays({ game: one, plays: [play()] }))

      assert.deepStrictEqual(playsIn(current, one), [play()])
    }).pipe(Effect.provide(directed))
  )

  it.effect("should drop plays for a game no listing names", () =>
    Effect.gen(function* () {
      const current = yield* delivered(Delivery.Plays({ game: one, plays: [play()] }))

      assert.deepStrictEqual(current.games, [])
    }).pipe(Effect.provide(directed))
  )

  it.effect("should take every delivery of a frame", () =>
    Effect.gen(function* () {
      const feed = yield* ProviderFeed
      const next = liveSnapshot({ id: one, clock: "9:00" })

      yield* feed.deliver([listingOf([liveSnapshot({ id: one })]), Delivery.Snapshot({ snapshot: next })])
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
      const feed = yield* ProviderFeed

      yield* feed.end
      yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => logs.length > 0, times: 100 }))

      const stopped = logs.filter(({ level }) => level === "Error")
      assert.strictEqual(stopped.length, 1)
      assert.include(stopped[0]?.message, "the provider's frames stopped")
      assert.include(stopped[0]?.message, "the provider's frames ended")
    }).pipe(
      Effect.provide(
        directorOver.pipe(
          Layer.provide(
            Source.layerTest(() => ChannelAvailability.cases.NoGuide.make({ source: "YouTube TV" }))
          ),
          Layer.provideMerge(layer)
        )
      )
    )
  })
})

describe("Director#published", () => {
  it.effect("should give the latest, then each change once", () =>
    Effect.gen(function* () {
      const director = yield* Director
      const published = yield* Ref.make<ReadonlyArray<GameSnapshot | undefined>>([])
      yield* director.published.pipe(
        Stream.runForEach((current) => Ref.update(published, (all) => [...all, snapshotOf(current, one)])),
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
      yield* director.published.pipe(
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

  it.live("should publish again when a source's answers change", () =>
    Effect.gen(function* () {
      const carries = yield* Ref.make(false)
      const youTubeTv = Layer.succeed(
        Source,
        Source.of({
          availability: Ref.get(carries).pipe(
            Effect.map((on) => () => [
              on ? ChannelAvailability.cases.Carried.make({ channel: primeOnYouTubeTv }) : streamingOnly
            ])
          ),
          changes: Stream.tick("10 millis")
        })
      )

      const availability = yield* Effect.gen(function* () {
        const director = yield* Director
        const first = yield* Deferred.make<void>()
        const waiting = yield* director.published.pipe(
          Stream.tap(() => Deferred.succeed(first, undefined)),
          Stream.filter(({ games }) =>
            games.some(({ availability }) => availability.some(ChannelAvailability.guards.Carried))
          ),
          Stream.runHead,
          Effect.timeout("2 seconds"),
          Effect.forkScoped
        )
        yield* Deferred.await(first)

        yield* Ref.set(carries, true)

        const message = yield* Fiber.join(waiting)
        return Option.map(message, ({ games }) => games[0]?.availability)
      }).pipe(
        Effect.provide(listed(games).pipe(Layer.provideMerge(directorOver), Layer.provideMerge(youTubeTv)))
      )

      assert.deepStrictEqual(
        availability,
        Option.some([ChannelAvailability.cases.Carried.make({ channel: primeOnYouTubeTv })])
      )
    })
  )

  it.live("should publish nothing when a source's change changes no answer", () =>
    Effect.gen(function* () {
      const answering = Source.layerTest(() => streamingOnly, Stream.tick("10 millis"))

      const next = yield* Effect.gen(function* () {
        const director = yield* Director

        return yield* director.published.pipe(
          Stream.drop(1),
          Stream.runHead,
          Effect.timeoutOption("200 millis")
        )
      }).pipe(
        Effect.provide(listed(games).pipe(Layer.provideMerge(directorOver), Layer.provideMerge(answering)))
      )

      assert.isTrue(Option.isNone(next))
    })
  )
  it.effect("should publish a game the guide carries as carried on its channel", () =>
    Effect.gen(function* () {
      const director = yield* Director
      yield* readRecordedGuide

      const message = yield* director.published.pipe(
        Stream.filter(({ games }) => games.length > 0),
        Stream.runHead,
        Effect.map(Option.getOrThrow)
      )

      assert.deepStrictEqual(
        message.games.find(({ game }) => game.snapshot.id === ohioStateAtIowa.id)?.availability,
        [
          ChannelAvailability.cases.Carried.make({
            channel: { name: "News 3", source: "YouTube TV", locator: { _tag: "WebView", url: news3Live } }
          })
        ]
      )
    }).pipe(Effect.provide(directing([ohioStateAtIowa, ...games])))
  )

  it.effect("should publish a game as no guide while the source has read none", () =>
    Effect.gen(function* () {
      const director = yield* Director

      const message = yield* director.published.pipe(
        Stream.filter(({ games }) => games.length > 0),
        Stream.runHead,
        Effect.map(Option.getOrThrow)
      )

      assert.deepStrictEqual(
        message.games.find(({ game }) => game.snapshot.id === GameId.make("5"))?.availability,
        [ChannelAvailability.cases.NoGuide.make({ source: "YouTube TV" })]
      )
    }).pipe(Effect.provide(directing(games)))
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

/** Game `id`'s snapshot in a published slate, if it is there. */
function snapshotOf(message: SlateChanged, id: GameId) {
  return message.games.find(({ game }) => game.snapshot.id === id)?.game.snapshot
}

function playsIn(slate: Slate, id: GameId): ReadonlyArray<Play> {
  return Option.match(slate.game(id), { onNone: () => [], onSome: ({ plays }) => plays })
}

function listingOf(games: ReadonlyArray<GameSnapshot>) {
  return Delivery.Listing({ league: "fbs", games })
}

/** Delivers an FBS listing of `games`, giving the Director's slate once it has taken it. */
function listing(games: ReadonlyArray<GameSnapshot>) {
  return delivered(listingOf(games))
}

function takenSnapshot(game: GameSnapshot) {
  return delivered(Delivery.Snapshot({ snapshot: game }))
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

const streamingOnly = ChannelAvailability.cases.NotCarried.make({ why: "StreamingOnly" })
const primeOnYouTubeTv = {
  name: "Prime Video",
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/prime" }
}

// News 3's live address in the recorded guide.
const news3Live = "https://tv.youtube.com/watch/y6zFA17zDsw?vp=0gEEEgIwAQ%3D%3D"

describe("Director's play log", () => {
  it.effect("should log each play a take adds once, annotated with its game", () => {
    const { logs, layer } = recordingLogs()
    const game = liveSnapshot({ id: one })
    const first = play({ id: PlayId.make("p1"), sequence: 1, text: "Rush for 1 yard" })
    const second = play({ id: PlayId.make("p2"), sequence: 2, clock: "14:20", text: "Rush for 4 yards" })
    return Effect.gen(function* () {
      yield* listing([game])
      yield* delivered(Delivery.Plays({ game: one, plays: [first] }))

      yield* delivered(Delivery.Plays({ game: one, plays: [first, second] }))

      const played = logs.filter(({ annotations }) => annotations.play !== undefined)
      assert.deepStrictEqual(
        played.map(({ level, annotations }) => ({ level, game: annotations.game, play: annotations.play })),
        [
          { level: "Info", game: one, play: "Rush" },
          { level: "Info", game: one, play: "Rush" }
        ]
      )
      assert.include(played[1]?.message ?? "", `Director: ${game.matchup()} Q1 14:20 Rush for 4 yards`)
    }).pipe(Effect.provide(directed.pipe(Layer.provideMerge(layer))))
  })
})

/** Every league's listing of `games`, in their order. */
function listings(games: ReadonlyArray<GameSnapshot>) {
  const leagues = [...new Set(games.map(({ league }) => league))]
  return leagues.map((league) =>
    Delivery.Listing({ league, games: games.filter((game) => game.league === league) })
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

/** The Director over a fed provider, against YouTube TV with nothing read yet; it and the guide reader provided too. */
const directed = directorOver.pipe(
  Layer.provideMerge(Source.layerYouTubeTv),
  Layer.provideMerge(GuideReader.layerYouTubeTv)
)
