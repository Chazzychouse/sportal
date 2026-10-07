import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Option } from "effect"
import { Delivery, type DeliverySource } from "./Delivery.ts"
import { GameId, GameSnapshot } from "./Game.ts"
import { LiveGameState } from "./LiveGame.ts"
import { FoldReport, LiveGames } from "./LiveGames.ts"
import { PlayId } from "./Play.ts"
import { play, snapshot } from "./TestGame.ts"

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
      const { next, reports } = yield* took(LiveGames.empty, [listing("fbs", [game])], t0)
      assert.strictEqual(next.live.get(one)?.snapshot, game)
      assert.deepStrictEqual(next.listed.get("fbs"), [game])
      assert.deepStrictEqual(tags(reports), ["Took", "Started"])
      assert.deepStrictEqual(outcomes(reports), ["taken"])
    })
  )

  it.effect("an upcoming game far from kickoff is listed but not held, and only its take is reported", () =>
    Effect.gen(function* () {
      const later = snapshot({ id: two, kickoff: DateTime.add(t0, { hours: 3 }) })
      const { next, reports } = yield* took(LiveGames.empty, [listing("fbs", [later])], t0)
      assert.deepStrictEqual(next.listed.get("fbs"), [later])
      assert.isFalse(next.live.has(two))
      assert.deepStrictEqual(tags(reports), ["Took"])
    })
  )

  it.effect("a pushed snapshot behind the held one is behind, and the live game is unchanged", () =>
    Effect.gen(function* () {
      const held = yield* taken(
        LiveGames.empty,
        [pushed(snapshot({ id: one, status: "live", period: 2 }))],
        t0
      )
      const { next, reports } = yield* took(
        held,
        [pushed(snapshot({ id: one, status: "live", period: 1 }))],
        t0
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
      const held = yield* taken(LiveGames.empty, [pushed(at(14))], t0)
      const { next, reports } = yield* took(held, [polled(at(13))], t0)
      assert.strictEqual(next.live.get(one)?.snapshot.home.score, 14)
      assert.deepStrictEqual(outcomes(reports), ["kept"])
    })
  )

  it.effect("plays for a game not held are dropped, and nothing changes", () =>
    Effect.gen(function* () {
      const { next, reports } = yield* took(
        LiveGames.empty,
        [Delivery.cases.Plays.make({ game: one, plays: [play()] })],
        t0
      )
      assert.strictEqual(next.live, LiveGames.empty.live)
      assert.strictEqual(next.listed, LiveGames.empty.listed)
      assert.deepStrictEqual(reports, [FoldReport.Dropped({ game: one })])
    })
  )

  it.effect("a tick past a game's wake time ticks it: a live game goes stale", () =>
    Effect.gen(function* () {
      const held = yield* taken(LiveGames.empty, [polled(live(one, "10:00"))], t0)
      const { next, reports } = yield* held.tick(DateTime.add(t0, { seconds: 100 }))
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
      const held = yield* taken(LiveGames.empty, [polled(live(one, "1:00"))], t0)
      const { next, reports } = yield* took(
        held,
        [polled(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))],
        t0
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
      const held = yield* taken(LiveGames.empty, [polled(live(one, "10:00"))], t0)
      const { next, reports } = yield* held.tick(DateTime.add(t0, { minutes: 31 }))
      assert.isFalse(next.live.has(one))
      assert.strictEqual(reports.at(-1)?._tag, "Stopped")
    })
  )

  it.effect("a take that raises a defect is reported, and the game keeps its last good live game", () =>
    Effect.gen(function* () {
      const held = yield* taken(LiveGames.empty, [polled(live(one, "9:00"))], t0)
      const { next, reports } = yield* took(held, [polled(broken(one))], t0)
      assert.strictEqual(next.live.get(one), held.live.get(one))
      assert.deepStrictEqual(tags(reports), ["Raised"])
    })
  )

  it.effect("a tick keeps the last seq; a take replaces it", () =>
    Effect.gen(function* () {
      const first = (yield* LiveGames.empty.take({
        deliveries: [polled(live(one, "10:00"))],
        at: t0,
        seq: 7
      })).next
      assert.deepStrictEqual(first.seq, Option.some(7))
      const kept = (yield* first.tick(DateTime.add(t0, { minutes: 31 }))).next
      assert.deepStrictEqual(kept.seq, Option.some(7))
      const replaced = (yield* kept.take({ deliveries: [], at: DateTime.add(t0, { minutes: 32 }), seq: 8 }))
        .next
      assert.deepStrictEqual(replaced.seq, Option.some(8))
    })
  )

  it.effect("a frame with no deliveries ticks a due game and sets seq", () =>
    Effect.gen(function* () {
      const held = yield* taken(LiveGames.empty, [polled(live(one, "10:00"))], t0)
      const { next } = yield* held.take({ deliveries: [], at: DateTime.add(t0, { seconds: 100 }), seq: 9 })
      assert.isTrue(LiveGameState.$is("Stale")(next.live.get(one)?.state ?? LiveGameState.Over()))
      assert.deepStrictEqual(next.seq, Option.some(9))
    })
  )

  it.effect(
    "a frame's deliveries are applied in order: a pushed snapshot of a game just listed is taken",
    () =>
      Effect.gen(function* () {
        const listedGame = live(one, "10:00")
        const pushedGame = live(one, "9:00")
        const { next, reports } = yield* took(
          LiveGames.empty,
          [listing("fbs", [listedGame]), pushed(pushedGame)],
          t0
        )
        assert.strictEqual(next.live.get(one)?.snapshot, pushedGame)
        assert.deepStrictEqual(
          reports.flatMap((report) =>
            report._tag === "Took" ? [[report.snapshot, report.from, report.outcome] as const] : []
          ),
          [
            [listedGame, "poll", "taken"],
            [pushedGame, "push", "taken"]
          ]
        )
      })
  )

  it.effect("two deliveries in one frame fold as the same two in two frames at the same instant", () =>
    Effect.gen(function* () {
      const deliveries = [listing("fbs", [live(one, "10:00"), live(two, "5:00")]), pushed(live(one, "9:00"))]
      const together = yield* taken(LiveGames.empty, deliveries, t0)
      const apart = yield* Effect.reduce(
        deliveries,
        () => LiveGames.empty,
        (fold, delivery) => taken(fold, [delivery], t0)
      )
      assert.deepStrictEqual(together.live, apart.live)
      assert.deepStrictEqual(together.listed, apart.listed)
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
        const fold = yield* taken(LiveGames.empty, [listing("fbs", [listedFbs])], t0).pipe(
          Effect.flatMap((fold) => taken(fold, [listing("nfl", [listedNfl])], t0)),
          Effect.flatMap((fold) => taken(fold, [polled(later)], t0)),
          Effect.flatMap((fold) => taken(fold, [polled(unlisted)], t0))
        )
        assert.deepStrictEqual(fold.slate(["fbs"]), [later])
        assert.deepStrictEqual(fold.slate(["nfl", "fbs"]), [listedNfl, later])
      })
  )

  it.effect(
    "recent plays are each asked-for game's last ten plays in sequence order, and only games with plays",
    () =>
      Effect.gen(function* () {
        const three = GameId.make("3")
        const listedNfl = live(two, "5:00")
        const fold = yield* taken(
          LiveGames.empty,
          [listing("fbs", [live(one, "10:00"), live(three, "9:00")]), listing("nfl", [listedNfl])],
          t0
        ).pipe(Effect.flatMap((fold) => taken(fold, [playsOf(one, 12), playsOf(two, 3)], t0)))
        assert.deepStrictEqual(
          fold.recentPlays(["fbs"])[one]?.map(({ sequence }) => sequence),
          [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
        )
        assert.deepStrictEqual(Object.keys(fold.recentPlays(["fbs"])), [one])
        assert.deepStrictEqual(
          fold.recentPlays(["nfl"])[two]?.map(({ sequence }) => sequence),
          [1, 2, 3]
        )
        assert.deepStrictEqual(Object.keys(fold.recentPlays(["nfl"])), [two])
        assert.deepStrictEqual(Object.keys(fold.recentPlays(["fbs", "nfl"])).toSorted(), [one, two])
      })
  )

  it.effect("games include a live game no listing holds", () =>
    Effect.gen(function* () {
      const listed = live(one, "10:00")
      const unlisted = live(two, "5:00")
      const fold = yield* taken(LiveGames.empty, [listing("fbs", [listed])], t0).pipe(
        Effect.flatMap((fold) => taken(fold, [polled(unlisted)], t0))
      )
      assert.deepStrictEqual(fold.games(), [listed, unlisted])
    })
  )

  it.effect("a take that moves only seq publishes the same", () =>
    Effect.gen(function* () {
      const held = yield* taken(LiveGames.empty, [polled(live(one, "10:00"))], t0)
      const moved = yield* taken(held, [], t0)
      assert.notDeepEqual(moved.seq, held.seq)
      assert.isTrue(moved.publishesSameAs(held))
    })
  )

  it.effect("a tick that changed nothing publishes the same; a take that changed a game does not", () =>
    Effect.gen(function* () {
      const held = yield* taken(LiveGames.empty, [polled(live(one, "10:00"))], t0)
      const still = (yield* held.tick(DateTime.addDuration(t0, Duration.seconds(1)))).next
      assert.isTrue(still.publishesSameAs(held))
      const took = yield* taken(
        still,
        [polled(live(one, "9:00"))],
        DateTime.addDuration(t0, Duration.seconds(2))
      )
      assert.isFalse(took.publishesSameAs(still))
    })
  )
})

/** `fold` taking `deliveries` as one frame received at `at`, the frame after its last. */
function took(fold: LiveGames, deliveries: ReadonlyArray<Delivery>, at: DateTime.Utc) {
  return fold.take({ deliveries, at, seq: Option.getOrElse(fold.seq, () => 0) + 1 })
}

function taken(fold: LiveGames, deliveries: ReadonlyArray<Delivery>, at: DateTime.Utc) {
  return Effect.map(took(fold, deliveries, at), ({ next }) => next)
}

function tags(reports: ReadonlyArray<FoldReport>): ReadonlyArray<FoldReport["_tag"]> {
  return reports.map(({ _tag }) => _tag)
}

function outcomes(reports: ReadonlyArray<FoldReport>): ReadonlyArray<string> {
  return reports.flatMap((report) => (report._tag === "Took" ? [report.outcome] : []))
}

function listing(league: "fbs" | "nfl", games: ReadonlyArray<GameSnapshot>) {
  return Delivery.cases.Listing.make({ league, games })
}

function polled(game: GameSnapshot) {
  return delivered(game, "poll")
}

function pushed(game: GameSnapshot) {
  return delivered(game, "push")
}

function delivered(game: GameSnapshot, from: DeliverySource) {
  return Delivery.cases.Snapshot.make({ snapshot: game, from })
}

/** A `Plays` delivery of `count` plays for game `id`, sequenced from 1 and handed over out of order. */
function playsOf(id: GameId, count: number) {
  return Delivery.cases.Plays.make({
    game: id,
    plays: Array.from({ length: count }, (_, index) =>
      play({ id: PlayId.make(`p${index + 1}`), sequence: index + 1 })
    ).toReversed()
  })
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
