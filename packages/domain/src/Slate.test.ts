import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Option } from "effect"
import { Delivery, type DeliverySource } from "./Delivery.ts"
import { GameId, GameSnapshot } from "./Game.ts"
import { GameEvent, GameEventKind } from "./GameEvent.ts"
import { LiveGame, LiveGameState } from "./LiveGame.ts"
import { PlayId } from "./Play.ts"
import { Slate, SlateObservation } from "./Slate.ts"
import { liveSnapshot, play, snapshot, team } from "./TestGame.ts"

const t0 = DateTime.makeUnsafe("2026-10-03T16:00:00Z")
const one = GameId.make("1")
const two = GameId.make("2")

describe("Slate", () => {
  it("dayStart is 04:00 local, the day before when now is earlier", () => {
    const at = (time: string) =>
      DateTime.makeZonedUnsafe(`2026-10-07T${time}:00`, {
        timeZone: "America/Chicago",
        adjustForTimeZone: true
      })
    const four = (day: string) =>
      DateTime.toUtc(
        DateTime.makeZonedUnsafe(`2026-10-${day}T04:00:00`, {
          timeZone: "America/Chicago",
          adjustForTimeZone: true
        })
      )
    assert.deepStrictEqual(Slate.dayStart(at("03:59")), four("06"))
    assert.deepStrictEqual(Slate.dayStart(at("04:00")), four("07"))
  })

  it("empty holds nothing", () => {
    assert.strictEqual(Slate.empty.live.size, 0)
    assert.strictEqual(Slate.empty.listed.size, 0)
    assert.deepStrictEqual(Slate.empty.earliestDue(), Option.none())
    assert.deepStrictEqual(Slate.empty.games(["fbs", "nfl"]), [])
  })

  it.effect("a listing with a live game starts it, and the slate keeps the listing", () =>
    Effect.gen(function* () {
      const game = live(one, "10:00")
      const { next, observations } = yield* took(Slate.empty, [listing("fbs", [game])], t0)
      assert.strictEqual(next.live.get(one)?.snapshot, game)
      assert.deepStrictEqual(next.listed.get("fbs"), [game])
      assert.deepStrictEqual(tags(observations), ["Took", "Started"])
      assert.deepStrictEqual(outcomes(observations), ["taken"])
    })
  )

  it.effect("an upcoming game far from kickoff is listed but not held, and only its take is observed", () =>
    Effect.gen(function* () {
      const later = snapshot({ id: two, kickoff: DateTime.add(t0, { hours: 3 }) })
      const { next, observations } = yield* took(Slate.empty, [listing("fbs", [later])], t0)
      assert.deepStrictEqual(next.listed.get("fbs"), [later])
      assert.isFalse(next.live.has(two))
      assert.deepStrictEqual(tags(observations), ["Took"])
    })
  )

  it.effect("a pushed snapshot behind the held one is behind, and the live game is unchanged", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [pushed(snapshot({ id: one, status: "live", period: 2 }))], t0)
      const { next, observations } = yield* took(
        held,
        [pushed(snapshot({ id: one, status: "live", period: 1 }))],
        t0
      )
      assert.strictEqual(next.live.get(one), held.live.get(one))
      assert.deepStrictEqual(tags(observations), ["Took"])
      assert.deepStrictEqual(outcomes(observations), ["behind"])
    })
  )

  it.effect("a poll at the same game time as a pushed snapshot, with fewer points, is behind", () =>
    Effect.gen(function* () {
      const at = (score: number) =>
        snapshot({
          id: one,
          status: "live",
          period: 2,
          clock: "4:12",
          home: { ...live(one, "4:12").home, score }
        })
      const held = yield* taken(Slate.empty, [pushed(at(14))], t0)
      const { next, observations } = yield* took(held, [polled(at(13))], t0)
      assert.strictEqual(next.live.get(one)?.snapshot.home.score, 14)
      assert.deepStrictEqual(outcomes(observations), ["behind"])
    })
  )

  it.effect(
    "a listing ahead of a covered game is held, then falls back at until, saying its events then",
    () =>
      Effect.gen(function* () {
        const covered = yield* taken(Slate.empty, [pushed(liveSnapshot({ id: one, clock: "5:00" }))], t0)
        const scored = liveSnapshot({ id: one, clock: "4:30", home: { ...live(one, "4:30").home, score: 7 } })
        const at = DateTime.add(t0, { seconds: 5 })
        const until = DateTime.addDuration(at, LiveGame.fallbackAfter)
        const holding = yield* took(covered, [listing("fbs", [scored])], at)
        assert.deepStrictEqual(outcomes(holding.observations), ["held"])
        assert.deepStrictEqual(holding.events, [])
        assert.deepStrictEqual(holding.next.earliestDue(), Option.some(until))
        const fellBack = yield* holding.next.tick(DateTime.add(until, { seconds: 1 }))
        assert.deepStrictEqual(outcomes(fellBack.observations), ["fellBack"])
        assert.deepStrictEqual(tags(fellBack.observations), ["Took", "Changed"])
        assert.deepStrictEqual(fellBack.events, [
          new GameEvent({
            game: one,
            at: until,
            what: GameEventKind.ScoreChanged({ team: scored.home.team.id, points: 7 })
          })
        ])
        assert.strictEqual(fellBack.next.live.get(one)?.snapshot, scored)
      })
  )

  it.effect("plays for a game not held are dropped, and nothing changes", () =>
    Effect.gen(function* () {
      const { next, observations } = yield* took(
        Slate.empty,
        [Delivery.cases.Plays.make({ game: one, plays: [play()] })],
        t0
      )
      assert.strictEqual(next.live, Slate.empty.live)
      assert.strictEqual(next.listed, Slate.empty.listed)
      assert.deepStrictEqual(observations, [SlateObservation.Dropped({ game: one })])
    })
  )

  it.effect("plays for a held game say their events, stamped with the game and the instant, in order", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)
      const at = DateTime.add(t0, { seconds: 5 })
      const { events } = yield* took(held, [playsOf(one, 3)], at)
      assert.deepStrictEqual(
        events.map(({ game, at, what }) => [game, at, what._tag, what._tag === "Played" ? what.play.id : ""]),
        [
          [one, at, "Played", "p1"],
          [one, at, "Played", "p2"],
          [one, at, "Played", "p3"]
        ]
      )
    })
  )

  it.effect("a tick past a game's wake time ticks it: a live game goes stale", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)
      const { next, observations } = yield* held.tick(DateTime.add(t0, { seconds: 100 }))
      assert.isTrue(LiveGameState.$is("Stale")(next.live.get(one)?.state ?? LiveGameState.Over()))
      const changed = observations.filter((observation) => observation._tag === "Changed")
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
      const held = yield* taken(Slate.empty, [polled(live(one, "1:00"))], t0)
      const { next, observations } = yield* took(
        held,
        [polled(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))],
        t0
      )
      assert.isFalse(next.live.has(one))
      assert.deepStrictEqual(tags(observations), ["Took", "Changed", "Stopped"])
    })
  )

  describe("a game the slate saw finish", () => {
    const later = (seconds: number) => DateTime.addDuration(t0, Duration.seconds(seconds))
    const home = (score: number) => ({ team: team("HOME"), score })
    const playing = snapshot({ id: one, status: "live", period: 4, clock: "0:39", home: home(26) })
    const final = snapshot({ id: one, status: "final", period: 4, clock: "0:00", home: home(26) })
    // The push says the final; the poll, behind it, still lists the game live.
    const finished = Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [listing("nfl", [playing]), pushed(playing)], t0)
      return yield* taken(held, [pushed(final)], later(1))
    })

    it.effect("is not started again by a lagging poll, and shows as its final", () =>
      Effect.gen(function* () {
        const { next, events, observations } = yield* took(
          yield* finished,
          [listing("nfl", [playing])],
          later(5)
        )

        assert.deepStrictEqual(events, [])
        assert.deepStrictEqual(tags(observations), ["Took"])
        assert.deepStrictEqual(outcomes(observations), ["behind"])
        assert.isFalse(next.live.has(one))
        assert.deepStrictEqual(next.games(["nfl"]), [final])
        assert.deepStrictEqual(next.everyGame(), [final])
      })
    )

    it.effect("says nothing new when the poll catches up to the final", () =>
      Effect.gen(function* () {
        const lagged = yield* taken(yield* finished, [listing("nfl", [playing])], later(5))
        const { next, events, observations } = yield* took(lagged, [listing("nfl", [final])], later(15))

        assert.deepStrictEqual(events, [])
        assert.deepStrictEqual(tags(observations), ["Took"])
        assert.isFalse(next.live.has(one))
        assert.deepStrictEqual(next.games(["nfl"]), [final])
      })
    )

    it.effect("is forgotten once no league's listing names it", () =>
      Effect.gen(function* () {
        const slate = yield* finished
        const unlisted = yield* taken(slate, [listing("nfl", [])], later(5))

        assert.strictEqual(slate.finished.get(one), final)
        assert.isFalse(unlisted.finished.has(one))
      })
    )

    it.effect("takes a snapshot ahead of its final, a corrected score, and says the change", () =>
      Effect.gen(function* () {
        const corrected = snapshot({ ...final, home: home(27) })
        const { next, events, observations } = yield* took(yield* finished, [polled(corrected)], later(5))

        assert.deepStrictEqual(outcomes(observations), ["taken"])
        assert.deepStrictEqual(
          events.map(({ what }) => what._tag),
          ["ScoreChanged"]
        )
        assert.isFalse(next.live.has(one))
        assert.deepStrictEqual(next.games(["nfl"]), [corrected])
      })
    )
  })

  it.effect("a stale game ticked past its hold is stopped and let go", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)
      const { next, observations } = yield* held.tick(DateTime.add(t0, { minutes: 31 }))
      assert.isFalse(next.live.has(one))
      assert.strictEqual(observations.at(-1)?._tag, "Stopped")
    })
  )

  it.effect("a take that raises a defect is observed, and the game keeps its last good live game", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "9:00"))], t0)
      const { next, observations } = yield* took(held, [polled(broken(one))], t0)
      assert.strictEqual(next.live.get(one), held.live.get(one))
      assert.deepStrictEqual(tags(observations), ["Raised"])
    })
  )

  it.effect("a tick keeps the last seq; a take replaces it", () =>
    Effect.gen(function* () {
      const first = (yield* Slate.empty.take({
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
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)
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
        const { next, observations } = yield* took(
          Slate.empty,
          [listing("fbs", [listedGame]), pushed(pushedGame)],
          t0
        )
        assert.strictEqual(next.live.get(one)?.snapshot, pushedGame)
        assert.deepStrictEqual(
          observations.flatMap((observation) =>
            observation._tag === "Took"
              ? [[observation.snapshot, observation.from, observation.outcome] as const]
              : []
          ),
          [
            [listedGame, "poll", "taken"],
            [pushedGame, "push", "taken"]
          ]
        )
      })
  )

  it.effect("two deliveries in one frame are taken as the same two in two frames at the same instant", () =>
    Effect.gen(function* () {
      const deliveries = [listing("fbs", [live(one, "10:00"), live(two, "5:00")]), pushed(live(one, "9:00"))]
      const together = yield* taken(Slate.empty, deliveries, t0)
      const apart = yield* Effect.reduce(
        deliveries,
        () => Slate.empty,
        (held, delivery) => taken(held, [delivery], t0)
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
        const slate = yield* taken(Slate.empty, [listing("fbs", [listedFbs])], t0).pipe(
          Effect.flatMap((held) => taken(held, [listing("nfl", [listedNfl])], t0)),
          Effect.flatMap((held) => taken(held, [polled(later)], t0)),
          Effect.flatMap((held) => taken(held, [polled(unlisted)], t0))
        )
        assert.deepStrictEqual(slate.games(["fbs"]), [later])
        assert.deepStrictEqual(slate.games(["nfl", "fbs"]), [listedNfl, later])
      })
  )

  it.effect(
    "recent plays are each asked-for game's last ten plays in sequence order, and only games with plays",
    () =>
      Effect.gen(function* () {
        const three = GameId.make("3")
        const listedNfl = live(two, "5:00")
        const slate = yield* taken(
          Slate.empty,
          [listing("fbs", [live(one, "10:00"), live(three, "9:00")]), listing("nfl", [listedNfl])],
          t0
        ).pipe(Effect.flatMap((held) => taken(held, [playsOf(one, 12), playsOf(two, 3)], t0)))
        assert.deepStrictEqual(
          slate.recentPlays(slate.games(["fbs"]))[one]?.map(({ sequence }) => sequence),
          [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
        )
        assert.deepStrictEqual(Object.keys(slate.recentPlays(slate.games(["fbs"]))), [one])
        assert.deepStrictEqual(
          slate.recentPlays(slate.games(["nfl"]))[two]?.map(({ sequence }) => sequence),
          [1, 2, 3]
        )
        assert.deepStrictEqual(Object.keys(slate.recentPlays(slate.games(["nfl"]))), [two])
        assert.deepStrictEqual(Object.keys(slate.recentPlays(slate.games(["fbs", "nfl"]))).toSorted(), [
          one,
          two
        ])
      })
  )

  it.effect("games include a live game no listing holds", () =>
    Effect.gen(function* () {
      const listed = live(one, "10:00")
      const unlisted = live(two, "5:00")
      const slate = yield* taken(Slate.empty, [listing("fbs", [listed])], t0).pipe(
        Effect.flatMap((held) => taken(held, [polled(unlisted)], t0))
      )
      assert.deepStrictEqual(slate.everyGame(), [listed, unlisted])
    })
  )

  it.effect("a take that moves only seq publishes the same", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)
      const moved = yield* taken(held, [], t0)
      assert.notDeepEqual(moved.seq, held.seq)
      assert.isTrue(moved.publishesSameAs(held))
    })
  )

  it.effect("a tick that changed nothing publishes the same; a take that changed a game does not", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)
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

/** `before` taking `deliveries` as one frame received at `at`, the frame after its last. */
function took(before: Slate, deliveries: ReadonlyArray<Delivery>, at: DateTime.Utc) {
  return before.take({ deliveries, at, seq: Option.getOrElse(before.seq, () => 0) + 1 })
}

function taken(before: Slate, deliveries: ReadonlyArray<Delivery>, at: DateTime.Utc) {
  return Effect.map(took(before, deliveries, at), ({ next }) => next)
}

function tags(observations: ReadonlyArray<SlateObservation>): ReadonlyArray<SlateObservation["_tag"]> {
  return observations.map(({ _tag }) => _tag)
}

function outcomes(observations: ReadonlyArray<SlateObservation>): ReadonlyArray<string> {
  return observations.flatMap((report) => (report._tag === "Took" ? [report.outcome] : []))
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
