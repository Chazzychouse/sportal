import { assert, describe, it } from "@effect/vitest"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { GameEvent, GameEventKind } from "@sportal/domain/GameEvent"
import { PlayId } from "@sportal/domain/Play"
import { liveSnapshot, play, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Duration, Effect, Option } from "effect"
import { Delivery, type DeliverySource } from "./Delivery.ts"
import { LiveGame, LiveGameState } from "./LiveGame.ts"
import { Slate } from "./Slate.ts"
import { SlateObservation } from "./SlateObservation.ts"

const t0 = DateTime.makeUnsafe("2026-10-03T16:00:00Z")
const one = GameId.make("1")
const two = GameId.make("2")

describe("Slate.empty", () => {
  it("should hold no listing", () => {
    const games = Slate.empty.games(["fbs", "nfl"])

    assert.strictEqual(Slate.empty.listed.size, 0)
    assert.deepStrictEqual(games, [])
  })

  it("should hold no live game", () => {
    assert.strictEqual(Slate.empty.live.size, 0)
  })

  it("should hold no finished game", () => {
    assert.strictEqual(Slate.empty.finished.size, 0)
  })

  it("should have no reached", () => {
    const due = Slate.empty.earliestDue()

    assert.deepStrictEqual(Slate.empty.reached, Option.none())
    assert.deepStrictEqual(due, Option.none())
  })
})

describe("Slate#take", () => {
  it.effect("should start a live game a listing names", () =>
    Effect.gen(function* () {
      const game = live(one, "10:00")

      const { next, observations } = yield* took(Slate.empty, [listing("fbs", [game])], t0)

      assert.strictEqual(next.live.get(one)?.snapshot, game)
      assert.deepStrictEqual(tags(observations), ["Took", "Started"])
      assert.deepStrictEqual(outcomes(observations), ["taken"])
    })
  )

  it.effect("should keep the listing", () =>
    Effect.gen(function* () {
      const game = live(one, "10:00")

      const { next } = yield* took(Slate.empty, [listing("fbs", [game])], t0)

      assert.deepStrictEqual(next.listed.get("fbs"), [game])
    })
  )

  it.effect("should list an upcoming game far from kickoff without holding it, observing only its take", () =>
    Effect.gen(function* () {
      const later = snapshot({ id: two, kickoff: DateTime.add(t0, { hours: 3 }) })

      const { next, observations } = yield* took(Slate.empty, [listing("fbs", [later])], t0)

      assert.deepStrictEqual(next.listed.get("fbs"), [later])
      assert.isFalse(next.live.has(two))
      assert.deepStrictEqual(tags(observations), ["Took"])
    })
  )

  it.effect(
    "should take a pushed snapshot behind the held one as behind, leaving the live game unchanged",
    () =>
      Effect.gen(function* () {
        const held = yield* taken(Slate.empty, [pushed(snapshot({ id: one, status: "live", period: 2 }))], t0)
        const behind = pushed(snapshot({ id: one, status: "live", period: 1 }))

        const { next, observations } = yield* took(held, [behind], t0)

        assert.strictEqual(next.live.get(one), held.live.get(one))
        assert.deepStrictEqual(tags(observations), ["Took"])
        assert.deepStrictEqual(outcomes(observations), ["behind"])
      })
  )

  it.effect("should take a poll at a pushed snapshot's game time, with fewer points, as behind", () =>
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

  it.effect("should drop plays for a game it does not hold, changing nothing", () =>
    Effect.gen(function* () {
      const plays = Delivery.cases.Plays.make({ game: one, plays: [play()] })

      const { next, observations } = yield* took(Slate.empty, [plays], t0)

      assert.strictEqual(next.live, Slate.empty.live)
      assert.strictEqual(next.listed, Slate.empty.listed)
      assert.deepStrictEqual(observations, [SlateObservation.Dropped({ game: one })])
    })
  )

  it.effect("should say a held game's plays as events stamped with the game and the instant, in order", () =>
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

  it.effect("should stop a game taken as final and let it go at once", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "1:00"))], t0)
      const final = polled(snapshot({ id: one, status: "final", period: 4, clock: "0:00" }))

      const { next, observations } = yield* took(held, [final], t0)

      assert.isFalse(next.live.has(one))
      assert.deepStrictEqual(tags(observations), ["Took", "Changed", "Stopped"])
    })
  )

  it.effect("should keep a game's last good live game when its take raises a defect, observing it", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "9:00"))], t0)

      const { next, observations } = yield* took(held, [polled(broken(one))], t0)

      assert.strictEqual(next.live.get(one), held.live.get(one))
      assert.deepStrictEqual(tags(observations), ["Raised"])
    })
  )

  it.effect("should tick a due game on a frame with no deliveries", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)

      const { next } = yield* held.take({ deliveries: [], at: DateTime.add(t0, { seconds: 100 }), seq: 9 })

      assert.isTrue(LiveGameState.$is("Stale")(next.live.get(one)?.state ?? LiveGameState.Over()))
    })
  )

  it.effect(
    "should apply a frame's deliveries in order, taking a pushed snapshot of a game just listed",
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

  it.effect("should take two deliveries in one frame as the same two in two frames at the same instant", () =>
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
})

describe("Slate#take and #tick, a covered game and a listing ahead of it", () => {
  const scored = liveSnapshot({ id: one, clock: "4:30", home: { ...live(one, "4:30").home, score: 7 } })
  const at = DateTime.add(t0, { seconds: 5 })
  const until = DateTime.addDuration(at, LiveGame.fallbackAfter)
  const covered = taken(Slate.empty, [pushed(liveSnapshot({ id: one, clock: "5:00" }))], t0)

  it.effect("should hold a listing ahead of a covered game", () =>
    Effect.gen(function* () {
      const slate = yield* covered

      const holding = yield* took(slate, [listing("fbs", [scored])], at)

      assert.deepStrictEqual(outcomes(holding.observations), ["held"])
      assert.deepStrictEqual(holding.events, [])
      assert.deepStrictEqual(holding.next.earliestDue(), Option.some(until))
    })
  )

  it.effect("should fall back at until and say its events then", () =>
    Effect.gen(function* () {
      const slate = yield* covered
      const holding = yield* taken(slate, [listing("fbs", [scored])], at)

      const fellBack = yield* holding.tick(DateTime.add(until, { seconds: 1 }))

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
})

describe("Slate#take, a game the slate saw finish", () => {
  const later = (seconds: number) => DateTime.addDuration(t0, Duration.seconds(seconds))
  const home = (score: number) => ({ team: team("HOME"), score })
  const playing = snapshot({ id: one, status: "live", period: 4, clock: "0:39", home: home(26) })
  const final = snapshot({ id: one, status: "final", period: 4, clock: "0:00", home: home(26) })
  // The push says the final; the poll, behind it, still lists the game live.
  const finished = Effect.gen(function* () {
    const held = yield* taken(Slate.empty, [listing("nfl", [playing]), pushed(playing)], t0)
    return yield* taken(held, [pushed(final)], later(1))
  })

  it.effect("should not start it again for a lagging poll", () =>
    Effect.gen(function* () {
      const slate = yield* finished

      const { next, events, observations } = yield* took(slate, [listing("nfl", [playing])], later(5))

      assert.deepStrictEqual(events, [])
      assert.deepStrictEqual(tags(observations), ["Took"])
      assert.deepStrictEqual(outcomes(observations), ["behind"])
      assert.isFalse(next.live.has(one))
    })
  )

  it.effect("should show it as its final while a lagging poll lists it", () =>
    Effect.gen(function* () {
      const slate = yield* finished

      const { next } = yield* took(slate, [listing("nfl", [playing])], later(5))

      assert.deepStrictEqual(next.games(["nfl"]), [final])
      assert.deepStrictEqual(next.everyGame(), [final])
    })
  )

  it.effect("should start it again, live, for overtime after a final", () =>
    Effect.gen(function* () {
      const slate = yield* finished
      const overtime = snapshot({ ...playing, period: 5, clock: "15:00" })

      const { next, observations } = yield* took(slate, [listing("nfl", [overtime])], later(5))

      assert.deepStrictEqual(outcomes(observations), ["taken"])
      assert.deepStrictEqual(next.live.get(one)?.state, LiveGameState.Live({ updatedAt: later(5) }))
      assert.deepStrictEqual(next.games(["nfl"]), [overtime])
    })
  )

  it.effect("should say nothing new when the poll catches up to the final", () =>
    Effect.gen(function* () {
      const slate = yield* finished
      const lagged = yield* taken(slate, [listing("nfl", [playing])], later(5))

      const { next, events, observations } = yield* took(lagged, [listing("nfl", [final])], later(15))

      assert.deepStrictEqual(events, [])
      assert.deepStrictEqual(tags(observations), [])
      assert.isFalse(next.live.has(one))
      assert.deepStrictEqual(next.games(["nfl"]), [final])
    })
  )

  it.effect("should observe nothing of a poll equal to its final", () =>
    Effect.gen(function* () {
      const slate = yield* finished

      const { next, observations } = yield* took(slate, [listing("nfl", [final]), polled(final)], later(5))

      assert.deepStrictEqual(outcomes(observations), [])
      assert.deepStrictEqual(next.games(["nfl"]), [final])
    })
  )

  it.effect("should observe a lagging poll as behind", () =>
    Effect.gen(function* () {
      const slate = yield* finished

      const { next, observations } = yield* took(slate, [polled(playing)], later(5))

      assert.deepStrictEqual(outcomes(observations), ["behind"])
      assert.deepStrictEqual(next.games(["nfl"]), [final])
    })
  )

  it.effect("should forget it once no league's listing names it", () =>
    Effect.gen(function* () {
      const slate = yield* finished

      const unlisted = yield* taken(slate, [listing("nfl", [])], later(5))

      assert.strictEqual(slate.finished.get(one), final)
      assert.isFalse(unlisted.finished.has(one))
    })
  )

  it.effect("should take a snapshot ahead of its final, a corrected score, and say the change", () =>
    Effect.gen(function* () {
      const slate = yield* finished
      const corrected = snapshot({ ...final, home: home(27) })

      const { next, events, observations } = yield* took(slate, [polled(corrected)], later(5))

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

describe("Slate#tick", () => {
  it.effect("should tick a live game past its wake time to stale", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)

      const { next, observations } = yield* held.tick(DateTime.add(t0, { seconds: 100 }))
      const changed = observations.filter((observation) => observation._tag === "Changed")

      assert.isTrue(LiveGameState.$is("Stale")(next.live.get(one)?.state ?? LiveGameState.Over()))
      assert.isTrue(
        changed.some(
          ({ before, after }) =>
            LiveGameState.$is("Live")(before.state) && LiveGameState.$is("Stale")(after.state)
        )
      )
    })
  )

  it.effect("should stop a stale game ticked past its hold and let it go", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)

      const { next, observations } = yield* held.tick(DateTime.add(t0, { minutes: 31 }))

      assert.isFalse(next.live.has(one))
      assert.strictEqual(observations.at(-1)?._tag, "Stopped")
    })
  )
})

describe("Slate#take and #tick, seq", () => {
  it.effect("should replace seq with the frame's on a take", () =>
    Effect.gen(function* () {
      const first = yield* Slate.empty.take({ deliveries: [polled(live(one, "10:00"))], at: t0, seq: 7 })
      const kept = yield* first.next.tick(DateTime.add(t0, { minutes: 31 }))

      const { next } = yield* kept.next.take({
        deliveries: [],
        at: DateTime.add(t0, { minutes: 32 }),
        seq: 8
      })

      assert.deepStrictEqual(first.next.seq, Option.some(7))
      assert.deepStrictEqual(next.seq, Option.some(8))
    })
  )

  it.effect("should set seq from a frame with no deliveries", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)

      const { next } = yield* held.take({ deliveries: [], at: DateTime.add(t0, { seconds: 100 }), seq: 9 })

      assert.deepStrictEqual(next.seq, Option.some(9))
    })
  )

  it.effect("should keep the last seq on a tick", () =>
    Effect.gen(function* () {
      const first = yield* Slate.empty.take({ deliveries: [polled(live(one, "10:00"))], at: t0, seq: 7 })

      const { next } = yield* first.next.tick(DateTime.add(t0, { minutes: 31 }))

      assert.deepStrictEqual(next.seq, Option.some(7))
    })
  )
})

describe("Slate#games", () => {
  const listedFbs = snapshot({ id: one, status: "live", period: 1, clock: "10:00" })
  const listedNfl = snapshot({ id: two, league: "nfl", kickoff: DateTime.add(t0, { hours: 3 }) })
  const later = live(one, "9:00")
  const unlisted = live(GameId.make("3"), "5:00")
  const held = taken(Slate.empty, [listing("fbs", [listedFbs])], t0).pipe(
    Effect.flatMap((slate) => taken(slate, [listing("nfl", [listedNfl])], t0)),
    Effect.flatMap((slate) => taken(slate, [polled(later)], t0)),
    Effect.flatMap((slate) => taken(slate, [polled(unlisted)], t0))
  )

  it.effect("should show each held game's live snapshot in place of the listed one", () =>
    Effect.gen(function* () {
      const slate = yield* held

      const games = slate.games(["fbs"])

      assert.deepStrictEqual(games, [later])
    })
  )

  it.effect("should keep the leagues' order", () =>
    Effect.gen(function* () {
      const slate = yield* held

      const games = slate.games(["nfl", "fbs"])

      assert.deepStrictEqual(games, [listedNfl, later])
    })
  )
})

describe("Slate#recentPlays", () => {
  const three = GameId.make("3")
  const withPlays = taken(
    Slate.empty,
    [listing("fbs", [live(one, "10:00"), live(three, "9:00")]), listing("nfl", [live(two, "5:00")])],
    t0
  ).pipe(Effect.flatMap((held) => taken(held, [playsOf(one, 12), playsOf(two, 3)], t0)))

  it.effect("should keep the last ten plays", () =>
    Effect.gen(function* () {
      const slate = yield* withPlays

      const recent = slate.recentPlays(slate.games(["fbs"]))

      assert.deepStrictEqual(
        recent[one]?.map(({ sequence }) => sequence),
        [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
      )
    })
  )

  it.effect("should keep sequence order", () =>
    Effect.gen(function* () {
      const slate = yield* withPlays

      const recent = slate.recentPlays(slate.games(["nfl"]))

      assert.deepStrictEqual(
        recent[two]?.map(({ sequence }) => sequence),
        [1, 2, 3]
      )
    })
  )

  it.effect("should leave out a game with no plays", () =>
    Effect.gen(function* () {
      const slate = yield* withPlays

      const recent = slate.recentPlays(slate.games(["fbs"]))

      assert.deepStrictEqual(Object.keys(recent), [one])
    })
  )

  it.effect("should answer only for the games asked for", () =>
    Effect.gen(function* () {
      const slate = yield* withPlays

      const nfl = slate.recentPlays(slate.games(["nfl"]))
      const both = slate.recentPlays(slate.games(["fbs", "nfl"]))

      assert.deepStrictEqual(Object.keys(nfl), [two])
      assert.deepStrictEqual(Object.keys(both).toSorted(), [one, two])
    })
  )
})

describe("Slate#everyGame", () => {
  it.effect("should include a live game no listing holds", () =>
    Effect.gen(function* () {
      const listed = live(one, "10:00")
      const unlisted = live(two, "5:00")
      const slate = yield* taken(Slate.empty, [listing("fbs", [listed])], t0).pipe(
        Effect.flatMap((held) => taken(held, [polled(unlisted)], t0))
      )

      const games = slate.everyGame()

      assert.deepStrictEqual(games, [listed, unlisted])
    })
  )
})

describe("Slate#publishesSameAs", () => {
  it.effect("should be the same after a take that moves only seq", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)

      const moved = yield* taken(held, [], t0)

      assert.notDeepEqual(moved.seq, held.seq)
      assert.isTrue(moved.publishesSameAs(held))
    })
  )

  it.effect("should be the same after a tick that changed nothing", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)

      const { next } = yield* held.tick(DateTime.addDuration(t0, Duration.seconds(1)))

      assert.isTrue(next.publishesSameAs(held))
    })
  )

  it.effect("should differ after a take that changed a game", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)
      const still = yield* held.tick(DateTime.addDuration(t0, Duration.seconds(1)))
      const at = DateTime.addDuration(t0, Duration.seconds(2))

      const changed = yield* taken(still.next, [polled(live(one, "9:00"))], at)

      assert.isFalse(changed.publishesSameAs(still.next))
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
