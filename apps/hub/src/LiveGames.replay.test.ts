import { join } from "node:path"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { GameId, type GameSnapshot } from "@sportal/domain/Game"
import type { GameEvent } from "@sportal/domain/GameEvent"
import type { LiveGame } from "@sportal/domain/LiveGame"
import { DateTime, Effect, Equal, Fiber, FileSystem, Option, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as Database from "./Database.ts"
import { FeedLog } from "./FeedLog.ts"
import type { FeedFrame } from "./Frame.ts"
import { LiveGames } from "./LiveGames.ts"
import * as EspnDecode from "./provider/espn/EspnDecode.ts"
import { fixtures, neAtBufFrames } from "./provider/espn/TestEspn.ts"
import { RecordedScenarios } from "./scenario/RecordedScenarios.ts"
import { counted, recordingLogs, withMetrics } from "./TestTelemetry.ts"

const neAtBuf = GameId.make("401872971")

// Measured once over the fixture: every play id its topic's patches add, whole or one at a time (none is removed,
// moved, or copied), counted with
//   zcat nfl-2026-10-04-ne-buf.frames.jsonl.gz | jq -r 'select(.kind=="message") | .body | fromjson
//     | select(.op=="P" or .op=="R") | .pl | fromjson | .pl | fromjson | .[]
//     | select(.path|test("^/entities/plays(/[^/]+)?$"))
//     | if .path=="/entities/plays" then (.value|keys[]) else (.path|ltrimstr("/entities/plays/")) end' | sort -u | wc -l
const recordedPlays = 182

describe("a recorded game", () => {
  it.effect(
    "replays through decode and the fold to NE at BUF final, with every play the recording has, and nothing failed",
    () => {
      const { logs, layer } = recordingLogs()
      return Effect.gen(function* () {
        yield* appended(yield* frames)
        const { latest, held } = yield* replayed

        const listed = latest.listed.get("nfl")?.find((game) => game.id === neAtBuf)
        assert.strictEqual(listed?.status, "final")
        assert.isFalse(latest.live.has(neAtBuf), "a final game is let go")
        assert.strictEqual(held.at(-1)?.plays.length, recordedPlays)
        assert.strictEqual(held.at(-1)?.snapshot.period, 4)
        for (const counter of [
          "sportal_frames_undecoded",
          "sportal_events_undecoded",
          "sportal_live_feed_undecoded_plays",
          "sportal_live_feed_document_resets",
          "sportal_game_defects"
        ]) {
          assert.isUndefined(yield* counted(counter), counter)
        }
        assert.deepStrictEqual(
          logs.filter(({ level }) => level === "Error"),
          []
        )
      }).pipe(withMetrics, Effect.provide([Database.at(":memory:"), layer, NodeServices.layer]))
    },
    { timeout: 60_000 }
  )

  it.effect(
    "folds the same replayed as taken live, and the same twice: the same live games, and the same events",
    () =>
      Effect.gen(function* () {
        yield* appended(yield* frames)

        const first = yield* replayed
        const second = yield* replayed
        assert.isTrue(Equal.equals(first.latest, second.latest))
        assert.isTrue(Equal.equals(first.held, second.held))

        const once = yield* takenLive
        const again = yield* takenLive
        assert.isTrue(
          Equal.equals(first.latest.live, once.latest.live),
          "replay ends with the live games live did"
        )
        assert.isTrue(Equal.equals(first.latest.listed, once.latest.listed), "and the listings")
        assert.isTrue(Equal.equals(first.held, once.held), "and holds the game as live did, change by change")
        assert.isTrue(Equal.equals(once.held, again.held))
        assert.isTrue(Equal.equals(once.events, again.events))
        assert.strictEqual(
          once.events.filter(({ event }) => event._tag === "Played").length,
          recordedPlays,
          "each play is played once"
        )
      }).pipe(Effect.provide([Database.at(":memory:"), NodeServices.layer])),
    { timeout: 60_000 }
  )

  it.effect(
    "replayed from after its topic's checkpoint, still takes every play its patches add",
    () =>
      Effect.gen(function* () {
        yield* appended(yield* frames)
        // After the topic's checkpoint (16:44:55Z) and before the first play's patch (17:02:42Z), as a game day's
        // start falls for a socket subscribed the night before.
        const { held } = yield* replayedFrom(DateTime.makeUnsafe("2026-10-04T16:56:40Z"))
        assert.strictEqual(held.at(-1)?.plays.length, recordedPlays)
      }).pipe(Effect.provide([Database.at(":memory:"), NodeServices.layer])),
    { timeout: 60_000 }
  )

  it.effect(
    "comes back the same after a restart halfway through the day",
    () =>
      Effect.gen(function* () {
        const all = yield* frames
        const half = Math.floor(all.length / 2)
        const fs = yield* FileSystem.FileSystem
        const onDisk = Database.at(join(yield* fs.makeTempDirectoryScoped(), "feed.sqlite"))

        // Half the day logged and replayed, then every layer closed; reopened on the same file, the rest logged, and
        // the whole log replayed, as a Hub starting again would.
        yield* appended(all.slice(0, half)).pipe(Effect.provide(onDisk))
        const before = yield* replayed.pipe(Effect.provide(onDisk))
        yield* appended(all.slice(half)).pipe(Effect.provide(onDisk))
        const after = yield* replayed.pipe(Effect.provide(onDisk))

        const uninterrupted = yield* appended(all).pipe(
          Effect.andThen(replayed),
          Effect.provide([Database.at(":memory:"), NodeCrypto.layer])
        )
        assert.isTrue(Equal.equals(after.latest, uninterrupted.latest))
        assert.isTrue(Equal.equals(after.held, uninterrupted.held))
        assert.isAbove(before.held.length, 0)
        assert.isTrue(Equal.equals(before.held, uninterrupted.held.slice(0, before.held.length)))
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60_000 }
  )
})

const frames = RecordedScenarios.use((recorded) => recorded.load(neAtBufFrames)).pipe(
  Effect.map(({ frames }) => frames),
  Effect.provide(RecordedScenarios.in(fixtures))
)

/** Appends `received` to the feed log in order; the log is closed after, so every frame is written. */
function appended(received: ReadonlyArray<FeedFrame>) {
  return FeedLog.use((log) => Effect.forEach(received, log.append, { discard: true })).pipe(
    Effect.provide(FeedLog.layer)
  )
}

/**
 * A fresh fold of the log from `from`, decoded as the Hub does on startup: its state at the end, and each live game NE
 * at BUF was held as, in order.
 */
function replayedFrom(from: DateTime.Utc) {
  return Effect.gen(function* () {
    const liveGames = yield* LiveGames
    const held = yield* Ref.make<ReadonlyArray<LiveGame>>([])
    yield* liveGames.replay(
      deliveriesOf(yield* FeedLog, from).pipe(Stream.tap(() => heldAs(held, liveGames)))
    )
    yield* heldAs(held, liveGames)
    return { latest: yield* liveGames.latest, held: yield* Ref.get(held) }
  }).pipe(Effect.provide([LiveGames.layer, FeedLog.layer]))
}

/** A fresh fold of the whole log, as `replayedFrom`. */
const replayed = replayedFrom(DateTime.makeUnsafe(0))

/**
 * A fresh fold of the whole log taken delivery by delivery, each once the test clock reaches it, as live: its state at
 * the end, each live game NE at BUF was held as, and every event published. The log is read first and closed, so the clock moves only
 * the fold's timer.
 */
const takenLive = Effect.gen(function* () {
  const all = yield* FeedLog.use((log) => Stream.runCollect(deliveriesOf(log))).pipe(
    Effect.provide(FeedLog.layer)
  )
  const liveGames = yield* LiveGames
  const held = yield* Ref.make<ReadonlyArray<LiveGame>>([])
  const events = yield* Ref.make<
    ReadonlyArray<{ readonly snapshot: GameSnapshot; readonly event: GameEvent }>
  >([])
  const subscriber = yield* liveGames.events.pipe(
    Stream.runForEach((published) => Ref.update(events, (seen) => [...seen, published])),
    Effect.forkChild({ startImmediately: true })
  )
  yield* Effect.forEach(
    all,
    ({ delivery, at, seq }) =>
      DateTime.now.pipe(
        Effect.flatMap((now) => TestClock.adjust(DateTime.distance(now, at))),
        Effect.andThen(liveGames.take(delivery, at, Option.some(seq))),
        Effect.andThen(heldAs(held, liveGames))
      ),
    { discard: true }
  )
  yield* Effect.yieldNow
  yield* Fiber.interrupt(subscriber)
  return { latest: yield* liveGames.latest, held: yield* Ref.get(held), events: yield* Ref.get(events) }
}).pipe(Effect.provide(LiveGames.layer))

/** Every frame in `log` replayed from `from` (all of them, unless given), decoded by ESPN's decoder, as the deliveries it said. */
function deliveriesOf(log: FeedLog["Service"], from = DateTime.makeUnsafe(0)) {
  return EspnDecode.decode(log.replay(from)).pipe(
    Stream.flatMap((said) =>
      said._tag === "Delivered"
        ? Stream.make({ delivery: said.delivery, at: said.at, seq: said.seq })
        : Stream.empty
    )
  )
}

/** Notes NE at BUF's live game now, when the fold holds it and it changed since the last noted. */
function heldAs(held: Ref.Ref<ReadonlyArray<LiveGame>>, liveGames: LiveGames["Service"]) {
  return Effect.flatMap(liveGames.latest, (latest) =>
    Option.match(Option.fromUndefinedOr(latest.live.get(neAtBuf)), {
      onNone: () => Effect.void,
      onSome: (liveGame) => Ref.update(held, (all) => (all.at(-1) === liveGame ? all : [...all, liveGame]))
    })
  )
}
