import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Option } from "effect"
import { Delivery, type DeliverySource } from "./Delivery.ts"
import { GameId, GameSnapshot } from "./Game.ts"
import { LiveGameState } from "./LiveGame.ts"
import { FoldReport, LiveGames } from "./LiveGames.ts"
import { play, snapshot } from "./TestGame.ts"
import { Watchability } from "./Watchability.ts"

const t0 = DateTime.makeUnsafe("2026-10-03T16:00:00Z")
const one = GameId.make("1")
const two = GameId.make("2")

describe("LiveGames", () => {
  it("empty holds nothing", () => {
    assert.strictEqual(LiveGames.empty.live.size, 0)
    assert.strictEqual(LiveGames.empty.listed.size, 0)
    assert.deepStrictEqual(LiveGames.empty.earliestDue(), Option.none())
    assert.deepStrictEqual(LiveGames.empty.slate(["fbs", "nfl"]), [])
  })

  it.effect("a listing with a live game starts it, and the fold keeps the listing", () =>
    Effect.gen(function* () {
      const game = live(one, "10:00")
      const { next, reports } = yield* LiveGames.empty.step(listing("fbs", [game]), t0, Option.none())
      assert.strictEqual(next.live.get(one)?.snapshot, game)
      assert.deepStrictEqual(next.listed.get("fbs"), [game])
      assert.deepStrictEqual(tags(reports), ["Took", "Started"])
      assert.deepStrictEqual(outcomes(reports), ["taken"])
    })
  )

  it.effect("an upcoming game far from kickoff is listed but not held, and only its take is reported", () =>
    Effect.gen(function* () {
      const later = snapshot({ id: two, kickoff: DateTime.add(t0, { hours: 3 }) })
      const { next, reports } = yield* LiveGames.empty.step(listing("fbs", [later]), t0, Option.none())
      assert.deepStrictEqual(next.listed.get("fbs"), [later])
      assert.isFalse(next.live.has(two))
      assert.deepStrictEqual(tags(reports), ["Took"])
    })
  )

  it.effect("a pushed snapshot behind the held one is behind, and the live game is unchanged", () =>
    Effect.gen(function* () {
      const held = yield* stepped(
        LiveGames.empty,
        pushed(snapshot({ id: one, status: "live", period: 2 })),
        t0
      )
      const { next, reports } = yield* held.step(
        pushed(snapshot({ id: one, status: "live", period: 1 })),
        t0,
        Option.none()
      )
      assert.strictEqual(next.live.get(one), held.live.get(one))
      assert.deepStrictEqual(tags(reports), ["Took"])
      assert.deepStrictEqual(outcomes(reports), ["behind"])
    })
  )

  it.effect("a poll at the same game time as a pushed snapshot is kept: the push wins the tie", () =>
    Effect.gen(function* () {
      const at = (score: number) =>
        snapshot({
          id: one,
          status: "live",
          period: 2,
          clock: "4:12",
          home: { ...live(one, "4:12").home, score }
        })
      const held = yield* stepped(LiveGames.empty, pushed(at(14)), t0)
      const { next, reports } = yield* held.step(polled(at(13)), t0, Option.none())
      assert.strictEqual(next.live.get(one)?.snapshot.home.score, 14)
      assert.deepStrictEqual(outcomes(reports), ["kept"])
    })
  )

  it.effect("plays for a game not held are dropped, and nothing changes", () =>
    Effect.gen(function* () {
      const { next, reports } = yield* LiveGames.empty.step(
        Option.some(Delivery.Plays({ game: one, plays: [play()] })),
        t0,
        Option.none()
      )
      assert.strictEqual(next.live, LiveGames.empty.live)
      assert.strictEqual(next.listed, LiveGames.empty.listed)
      assert.deepStrictEqual(reports, [FoldReport.Dropped({ game: one, reason: "no game" })])
    })
  )

  it.effect("a step past a game's wake time ticks it first: a live game goes stale", () =>
    Effect.gen(function* () {
      const held = yield* stepped(LiveGames.empty, polled(live(one, "10:00")), t0)
      const { next, reports } = yield* held.step(
        Option.none(),
        DateTime.add(t0, { seconds: 100 }),
        Option.none()
      )
      assert.isTrue(LiveGameState.$is("Stale")(next.live.get(one)?.state ?? LiveGameState.Over()))
      const changed = reports.filter((report) => report._tag === "Changed")
      assert.isTrue(
        changed.some(
          ({ before, after }) =>
            LiveGameState.$is("Live")(before.state) && LiveGameState.$is("Stale")(after.state)
        )
      )
    })
  )

  it.effect("a game taken as final is stopped and let go at once", () =>
    Effect.gen(function* () {
      const held = yield* stepped(LiveGames.empty, polled(live(one, "1:00")), t0)
      const { next, reports } = yield* held.step(
        polled(snapshot({ id: one, status: "final", period: 4, clock: "0:00" })),
        t0,
        Option.none()
      )
      assert.isFalse(next.live.has(one))
      assert.deepStrictEqual(
        tags(reports).filter((tag) => tag !== "Happened"),
        ["Took", "Changed", "Stopped"]
      )
    })
  )

  it.effect("a stale game ticked past its hold is stopped and let go", () =>
    Effect.gen(function* () {
      const held = yield* stepped(LiveGames.empty, polled(live(one, "10:00")), t0)
      const { next, reports } = yield* held.step(
        Option.none(),
        DateTime.add(t0, { minutes: 31 }),
        Option.none()
      )
      assert.isFalse(next.live.has(one))
      assert.strictEqual(reports.at(-1)?._tag, "Stopped")
    })
  )

  it.effect("a step that raises a defect is reported, and the game keeps its last good live game", () =>
    Effect.gen(function* () {
      const held = yield* stepped(LiveGames.empty, polled(live(one, "9:00")), t0)
      const { next, reports } = yield* held.step(polled(broken(one)), t0, Option.none())
      assert.strictEqual(next.live.get(one), held.live.get(one))
      assert.deepStrictEqual(tags(reports), ["Raised"])
    })
  )

  it.effect("a step with no seq keeps the last one; a step with one replaces it", () =>
    Effect.gen(function* () {
      const first = (yield* LiveGames.empty.step(polled(live(one, "10:00")), t0, Option.some(7))).next
      assert.deepStrictEqual(first.seq, Option.some(7))
      const kept = (yield* first.step(Option.none(), t0, Option.none())).next
      assert.deepStrictEqual(kept.seq, Option.some(7))
      const replaced = (yield* kept.step(Option.none(), t0, Option.some(8))).next
      assert.deepStrictEqual(replaced.seq, Option.some(8))
    })
  )

  it.effect(
    "the slate shows each held game's live snapshot in place of the listed one, in the leagues' order",
    () =>
      Effect.gen(function* () {
        const listedFbs = snapshot({ id: one, status: "live", period: 1, clock: "10:00" })
        const listedNfl = snapshot({ id: two, league: "nfl", kickoff: DateTime.add(t0, { hours: 3 }) })
        const later = live(one, "9:00")
        const unlisted = live(GameId.make("3"), "5:00")
        const fold = yield* stepped(LiveGames.empty, listing("fbs", [listedFbs]), t0).pipe(
          Effect.flatMap((fold) => stepped(fold, listing("nfl", [listedNfl]), t0)),
          Effect.flatMap((fold) => stepped(fold, polled(later), t0)),
          Effect.flatMap((fold) => stepped(fold, polled(unlisted), t0))
        )
        assert.deepStrictEqual(fold.slate(["fbs"]), [later])
        assert.deepStrictEqual(fold.slate(["nfl", "fbs"]), [listedNfl, later])
      })
  )

  it.effect("games include a live game no listing holds", () =>
    Effect.gen(function* () {
      const listed = live(one, "10:00")
      const unlisted = live(two, "5:00")
      const fold = yield* stepped(LiveGames.empty, listing("fbs", [listed]), t0).pipe(
        Effect.flatMap((fold) => stepped(fold, polled(unlisted), t0))
      )
      assert.deepStrictEqual(fold.games(), [listed, unlisted])
    })
  )

  it.effect("a game's watchability is its live game's when held, and fresh otherwise", () =>
    Effect.gen(function* () {
      const held = live(one, "10:00")
      const notHeld = snapshot({ id: two, kickoff: DateTime.add(t0, { hours: 3 }) })
      const fold = yield* stepped(LiveGames.empty, listing("fbs", [held, notHeld]), t0)
      const now = DateTime.add(t0, { seconds: 10 })
      assert.strictEqual(fold.watchabilityOf(held, now), fold.live.get(one)?.watchability)
      assert.deepStrictEqual(fold.watchabilityOf(notHeld, now), Watchability.initial(notHeld, now))
    })
  )

  it.effect("a step that changed nothing publishes the same; a take does not", () =>
    Effect.gen(function* () {
      const held = yield* stepped(LiveGames.empty, polled(live(one, "10:00")), t0)
      const still = yield* stepped(held, Option.none(), DateTime.addDuration(t0, Duration.seconds(1)))
      assert.isTrue(still.publishesSameAs(held))
      const taken = yield* stepped(
        still,
        polled(live(one, "9:00")),
        DateTime.addDuration(t0, Duration.seconds(2))
      )
      assert.isFalse(taken.publishesSameAs(still))
    })
  )
})

function stepped(fold: LiveGames, delivery: Option.Option<Delivery>, at: DateTime.Utc) {
  return Effect.map(fold.step(delivery, at, Option.none()), ({ next }) => next)
}

function tags(reports: ReadonlyArray<FoldReport>): ReadonlyArray<FoldReport["_tag"]> {
  return reports.map(({ _tag }) => _tag)
}

function outcomes(reports: ReadonlyArray<FoldReport>): ReadonlyArray<string> {
  return reports.flatMap((report) => (report._tag === "Took" ? [report.outcome] : []))
}

function listing(league: "fbs" | "nfl", games: ReadonlyArray<GameSnapshot>) {
  return Option.some(Delivery.Listing({ league, games }))
}

function polled(game: GameSnapshot) {
  return delivered(game, "poll")
}

function pushed(game: GameSnapshot) {
  return delivered(game, "push")
}

function delivered(game: GameSnapshot, from: DeliverySource) {
  return Option.some(Delivery.Snapshot({ snapshot: game, from }))
}

function live(id: GameId, clock: string): GameSnapshot {
  return snapshot({ id, status: "live", period: 1, clock })
}

/** A live snapshot of game `id` at 8:00 in the first period whose events raise a defect. */
function broken(id: GameId): GameSnapshot {
  class Broken extends GameSnapshot {
    override eventsSince(): never {
      throw new Error("a broken snapshot")
    }
  }
  return new Broken({ ...live(id, "8:00") })
}
