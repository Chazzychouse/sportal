import { assert, describe, it } from "@effect/vitest"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { GameEvent, GameEventKind } from "@sportal/domain/GameEvent"
import { type Play, PlayId } from "@sportal/domain/Play"
import { completion, tags as eventTags, liveSnapshot, play, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Duration, Effect, Option } from "effect"
import { Acknowledgement } from "./Acknowledgement.ts"
import { Delivery, type DeliverySource } from "./Delivery.ts"
import { Slate } from "./Slate.ts"
import { SlateObservation } from "./SlateObservation.ts"

const t0 = DateTime.makeUnsafe("2026-10-03T16:00:00Z")
const one = GameId.make("1")
const two = GameId.make("2")

describe("Slate.empty", () => {
  it("should hold no listing", () => {
    const games = Slate.empty.listedGames(["fbs", "nfl"])

    assert.strictEqual(Slate.empty.listed.size, 0)
    assert.deepStrictEqual(games, [])
  })

  it("should hold no current game", () => {
    assert.strictEqual(Slate.empty.games.size, 0)
    assert.strictEqual(Slate.empty.plays.size, 0)
    assert.strictEqual(Slate.empty.acknowledged.size, 0)
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

      assert.strictEqual(next.games.get(one), game)
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
      assert.isFalse(next.games.has(two))
      assert.deepStrictEqual(tags(observations), ["Took"])
    })
  )

  it.effect("should take a pushed snapshot behind the held one as behind, leaving the game unchanged", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [pushed(snapshot({ id: one, status: "live", period: 2 }))], t0)
      const behind = pushed(snapshot({ id: one, status: "live", period: 1 }))

      const { next, observations } = yield* took(held, [behind], t0)

      assert.strictEqual(next.games.get(one), held.games.get(one))
      assert.strictEqual(next.acknowledged.get(one), held.acknowledged.get(one))
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

      assert.strictEqual(next.games.get(one)?.home.score, 14)
      assert.deepStrictEqual(outcomes(observations), ["behind"])
    })
  )

  it.effect("should drop plays for a game it does not hold, changing nothing", () =>
    Effect.gen(function* () {
      const plays = Delivery.cases.Plays.make({ game: one, plays: [play()] })

      const { next, observations } = yield* took(Slate.empty, [plays], t0)

      assert.strictEqual(next.games, Slate.empty.games)
      assert.strictEqual(next.plays, Slate.empty.plays)
      assert.strictEqual(next.acknowledged, Slate.empty.acknowledged)
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
        events.map(({ game, at, what }) => [
          game,
          at,
          what._tag,
          GameEventKind.$is("Played")(what) ? what.play.id : ""
        ]),
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

      assert.isFalse(next.games.has(one))
      assert.deepStrictEqual(tags(observations), ["Took", "Changed", "Stopped"])
    })
  )

  it.effect("should keep what a game had when its take raises a defect, observing it", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "9:00"))], t0)

      const { next, observations } = yield* took(held, [polled(broken(one))], t0)

      assert.strictEqual(next.games.get(one), held.games.get(one))
      assert.strictEqual(next.acknowledged.get(one), held.acknowledged.get(one))
      assert.deepStrictEqual(tags(observations), ["Raised"])
    })
  )

  it.effect("should tick a due game on a frame with no deliveries", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)

      const { next } = yield* held.take({ deliveries: [], at: DateTime.add(t0, { seconds: 100 }) })

      assert.deepStrictEqual(next.state(one), Option.some("Stale"))
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

        assert.strictEqual(next.games.get(one), pushedGame)
        assert.deepStrictEqual(
          observations.flatMap((observation) =>
            SlateObservation.$is("Took")(observation)
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

      assert.deepStrictEqual(together.games, apart.games)
      assert.deepStrictEqual(together.plays, apart.plays)
      assert.deepStrictEqual(together.acknowledged, apart.acknowledged)
      assert.deepStrictEqual(together.listed, apart.listed)
    })
  )
})

describe("Slate#take and #tick, a covered game and a listing ahead of it", () => {
  const scored = liveSnapshot({ id: one, clock: "4:30", home: { ...live(one, "4:30").home, score: 7 } })
  const at = DateTime.add(t0, { seconds: 5 })
  const until = DateTime.addDuration(at, Acknowledgement.fallbackAfter)
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
      assert.strictEqual(fellBack.next.games.get(one), scored)
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
      assert.isFalse(next.games.has(one))
    })
  )

  it.effect("should show it as its final while a lagging poll lists it", () =>
    Effect.gen(function* () {
      const slate = yield* finished

      const { next } = yield* took(slate, [listing("nfl", [playing])], later(5))

      assert.deepStrictEqual(next.listedGames(["nfl"]), [final])
      assert.deepStrictEqual(next.everyGame(), [final])
    })
  )

  it.effect("should start it again, live, for overtime after a final", () =>
    Effect.gen(function* () {
      const slate = yield* finished
      const overtime = snapshot({ ...playing, period: 5, clock: "15:00" })

      const { next, observations } = yield* took(slate, [listing("nfl", [overtime])], later(5))

      assert.deepStrictEqual(outcomes(observations), ["taken"])
      assert.deepStrictEqual(next.state(one), Option.some("Live"))
      assert.deepStrictEqual(next.acknowledged.get(one)?.heardAt, later(5))
      assert.deepStrictEqual(next.listedGames(["nfl"]), [overtime])
    })
  )

  it.effect("should say nothing new when the poll catches up to the final", () =>
    Effect.gen(function* () {
      const slate = yield* finished
      const lagged = yield* taken(slate, [listing("nfl", [playing])], later(5))

      const { next, events, observations } = yield* took(lagged, [listing("nfl", [final])], later(15))

      assert.deepStrictEqual(events, [])
      assert.deepStrictEqual(tags(observations), [])
      assert.isFalse(next.games.has(one))
      assert.deepStrictEqual(next.listedGames(["nfl"]), [final])
    })
  )

  it.effect("should observe nothing of a poll equal to its final", () =>
    Effect.gen(function* () {
      const slate = yield* finished

      const { next, observations } = yield* took(slate, [listing("nfl", [final]), polled(final)], later(5))

      assert.deepStrictEqual(outcomes(observations), [])
      assert.deepStrictEqual(next.listedGames(["nfl"]), [final])
    })
  )

  it.effect("should observe a lagging poll as behind", () =>
    Effect.gen(function* () {
      const slate = yield* finished

      const { next, observations } = yield* took(slate, [polled(playing)], later(5))

      assert.deepStrictEqual(outcomes(observations), ["behind"])
      assert.deepStrictEqual(next.listedGames(["nfl"]), [final])
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
      assert.isFalse(next.games.has(one))
      assert.deepStrictEqual(next.listedGames(["nfl"]), [corrected])
    })
  )
})

describe("Slate#tick", () => {
  it.effect("should tick a live game past its wake time to stale", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)

      const { next, observations } = yield* held.tick(DateTime.add(t0, { seconds: 100 }))
      const changed = observations.filter(SlateObservation.$is("Changed"))

      assert.deepStrictEqual(next.state(one), Option.some("Stale"))
      assert.isTrue(
        changed.some(
          ({ before, after, since, at }) =>
            before.acknowledgement.state(before.snapshot, since) === "Live" &&
            after.acknowledgement.state(after.snapshot, at) === "Stale"
        )
      )
    })
  )

  it.effect("should stop a stale game ticked past its hold and let it go", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)

      const { next, observations } = yield* held.tick(DateTime.add(t0, { minutes: 31 }))

      assert.isFalse(next.games.has(one))
      assert.strictEqual(observations.at(-1)?._tag, "Stopped")
    })
  )
})

describe("Slate#tick, a live game's stale instant", () => {
  const staleAt = DateTime.addDuration(t0, Acknowledgement.staleAfter)
  const held = taken(Slate.empty, [polled(live(one, "10:00"))], t0)

  it.effect("should not change the slate when a live game's stale instant passes", () =>
    Effect.gen(function* () {
      const slate = yield* held

      const { next } = yield* slate.tick(staleAt)

      assert.strictEqual(next.games, slate.games)
      assert.strictEqual(next.plays, slate.plays)
      assert.strictEqual(next.acknowledged, slate.acknowledged)
    })
  )

  it.effect("should report the game Stale from that instant", () =>
    Effect.gen(function* () {
      const slate = yield* held

      const before = yield* slate.tick(DateTime.subtractDuration(staleAt, Duration.millis(1)))
      const from = yield* before.next.tick(staleAt)

      assert.deepStrictEqual(before.next.state(one), Option.some("Live"))
      assert.deepStrictEqual(from.next.state(one), Option.some("Stale"))
    })
  )

  it.effect("should wake at the stale instant and then at the end of the current window", () =>
    Effect.gen(function* () {
      const slate = yield* held

      const { next } = yield* slate.tick(staleAt)

      assert.deepStrictEqual(slate.earliestDue(), Option.some(staleAt))
      assert.deepStrictEqual(
        next.earliestDue(),
        Option.some(DateTime.addDuration(t0, Acknowledgement.staleCurrentFor))
      )
    })
  )
})

describe("Slate#take, plays", () => {
  const first = play()
  const second = completion({
    id: PlayId.make("2"),
    sequence: 2,
    scoring: true,
    homeScore: 7,
    touchdown: true
  })
  const later = DateTime.add(t0, { seconds: 30 })
  const withFirst = taken(Slate.empty, [polled(live(one, "10:00"))], t0).pipe(
    Effect.flatMap((held) => taken(held, [Delivery.cases.Plays.make({ game: one, plays: [first] })], later))
  )

  it.effect("should start a game with no plays", () =>
    Effect.gen(function* () {
      const { next } = yield* took(Slate.empty, [polled(live(one, "10:00"))], t0)

      assert.deepStrictEqual(next.plays.get(one), [])
    })
  )

  it.effect("should replace the list, in Play.order, and give the new plays' events", () =>
    Effect.gen(function* () {
      const slate = yield* withFirst

      const { next, events } = yield* took(slate, [playsFor(one, [second, first])], later)

      assert.deepStrictEqual(next.plays.get(one), [first, second])
      assert.deepStrictEqual(whats(events), [GameEventKind.Played({ play: second })])
    })
  )

  it.effect("should keep the snapshot, its source, and its state when plays are taken", () =>
    Effect.gen(function* () {
      const slate = yield* withFirst

      const { next } = yield* took(slate, [playsFor(one, [first, second])], later)

      assert.deepStrictEqual(next.games.get(one), live(one, "10:00"))
      assert.strictEqual(next.acknowledged.get(one)?.from, "poll")
      assert.deepStrictEqual(next.state(one), Option.some("Live"))
      assert.deepStrictEqual(next.acknowledged.get(one)?.heardAt, t0)
    })
  )

  it.effect("should take nothing for an identical list", () =>
    Effect.gen(function* () {
      const slate = yield* withFirst

      const { next, events } = yield* took(slate, [playsFor(one, [first])], later)

      assert.strictEqual(next.plays, slate.plays)
      assert.strictEqual(next.games, slate.games)
      assert.strictEqual(next.acknowledged, slate.acknowledged)
      assert.deepStrictEqual(events, [])
    })
  )

  it.effect("should take nothing for an equal list of equal plays", () =>
    Effect.gen(function* () {
      const slate = yield* withFirst

      const { next, events } = yield* took(slate, [playsFor(one, [play()])], later)

      assert.strictEqual(next.plays, slate.plays)
      assert.strictEqual(next.games, slate.games)
      assert.strictEqual(next.acknowledged, slate.acknowledged)
      assert.deepStrictEqual(events, [])
    })
  )

  it.effect("should drop a play removed from the list, giving no events", () =>
    Effect.gen(function* () {
      const both = yield* withFirst.pipe(
        Effect.flatMap((slate) => taken(slate, [playsFor(one, [first, second])], later))
      )

      const { next, events } = yield* took(both, [playsFor(one, [first])], later)

      assert.deepStrictEqual(next.plays.get(one), [first])
      assert.deepStrictEqual(events, [])
    })
  )
})

describe("Slate#take, a snapshot's events beside its plays", () => {
  const playing = snapshot({ id: one, status: "live", period: 2, clock: "10:00" })
  const scoredFinal = snapshot({
    id: one,
    status: "final",
    period: 4,
    clock: "0:00",
    home: { ...playing.home, score: 3 }
  })
  const scored = snapshot({
    id: one,
    status: "live",
    period: 2,
    clock: "9:00",
    home: { ...playing.home, score: 7 }
  })
  const touchdown = completion({
    id: PlayId.make("2"),
    sequence: 2,
    scoring: true,
    homeScore: 7,
    touchdown: true
  })
  const later = DateTime.add(t0, { seconds: 30 })
  const withPlay = taken(Slate.empty, [polled(playing)], t0).pipe(
    Effect.flatMap((held) => taken(held, [playsFor(one, [play()])], later))
  )

  it.effect("should say ScoreChanged and WentFinal for a final with a score change once plays exist", () =>
    Effect.gen(function* () {
      const slate = yield* withPlay

      const { events } = yield* took(slate, [polled(scoredFinal)], later)

      assert.include(eventTags(whats(events)), "ScoreChanged")
      assert.include(eventTags(whats(events)), "WentFinal")
    })
  )

  it.effect(
    "should say ScoreChanged for a snapshot's score change that comes before the touchdown pass",
    () =>
      Effect.gen(function* () {
        const slate = yield* withPlay

        const byScore = yield* took(slate, [polled(scored)], later)

        assert.deepStrictEqual(whats(byScore.events), [
          GameEventKind.ScoreChanged({ team: playing.home.team.id, points: 7 })
        ])
      })
  )

  it.effect("should say only Played for the touchdown pass after the snapshot's score change", () =>
    Effect.gen(function* () {
      const slate = yield* withPlay
      const byScore = yield* taken(slate, [polled(scored)], later)

      const byPlay = yield* took(byScore, [playsFor(one, [play(), touchdown])], later)

      assert.deepStrictEqual(whats(byPlay.events), [GameEventKind.Played({ play: touchdown })])
    })
  )

  it.effect(
    "should say only Played for the touchdown pass that comes before the snapshot's score change",
    () =>
      Effect.gen(function* () {
        const slate = yield* withPlay

        const byPlay = yield* took(slate, [playsFor(one, [play(), touchdown])], later)

        assert.deepStrictEqual(whats(byPlay.events), [GameEventKind.Played({ play: touchdown })])
      })
  )

  it.effect("should say ScoreChanged once for the snapshot's score change after the touchdown pass", () =>
    Effect.gen(function* () {
      const slate = yield* withPlay
      const byPlay = yield* taken(slate, [playsFor(one, [play(), touchdown])], later)

      const bySnapshot = yield* took(byPlay, [polled(scored)], later)

      assert.deepStrictEqual(whats(bySnapshot.events), [
        GameEventKind.ScoreChanged({ team: playing.home.team.id, points: 7 })
      ])
    })
  )

  it.effect("should keep the plays when it takes a snapshot", () =>
    Effect.gen(function* () {
      const slate = yield* withPlay

      const { next } = yield* took(slate, [polled(scored)], later)

      assert.deepStrictEqual(next.plays.get(one), [play()])
    })
  )
})

describe("Slate#listedGames", () => {
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

      const games = slate.listedGames(["fbs"])

      assert.deepStrictEqual(games, [later])
    })
  )

  it.effect("should keep the leagues' order", () =>
    Effect.gen(function* () {
      const slate = yield* held

      const games = slate.listedGames(["nfl", "fbs"])

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

      const recent = slate.recentPlays(slate.listedGames(["fbs"]))

      assert.deepStrictEqual(
        recent[one]?.map(({ sequence }) => sequence),
        [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
      )
    })
  )

  it.effect("should keep sequence order", () =>
    Effect.gen(function* () {
      const slate = yield* withPlays

      const recent = slate.recentPlays(slate.listedGames(["nfl"]))

      assert.deepStrictEqual(
        recent[two]?.map(({ sequence }) => sequence),
        [1, 2, 3]
      )
    })
  )

  it.effect("should leave out a game with no plays", () =>
    Effect.gen(function* () {
      const slate = yield* withPlays

      const recent = slate.recentPlays(slate.listedGames(["fbs"]))

      assert.deepStrictEqual(Object.keys(recent), [one])
    })
  )

  it.effect("should answer only for the games asked for", () =>
    Effect.gen(function* () {
      const slate = yield* withPlays

      const nfl = slate.recentPlays(slate.listedGames(["nfl"]))
      const both = slate.recentPlays(slate.listedGames(["fbs", "nfl"]))

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

describe("Slate#published", () => {
  const three = GameId.make("3")

  it.effect("should keep the listing's order, leagues in their order", () =>
    Effect.gen(function* () {
      const slate = yield* taken(
        Slate.empty,
        [
          listing("fbs", [live(three, "10:00"), live(one, "10:00"), live(two, "10:00")]),
          listing("nfl", [snapshot({ id: GameId.make("9"), league: "nfl", status: "live" })])
        ],
        t0
      )

      const ids = slate.published().games.map((listed) => listed.id)

      assert.deepStrictEqual(ids, ["9", "3", "1", "2"])
    })
  )

  it.effect("should publish a live game's snapshot over its listing's", () =>
    Effect.gen(function* () {
      const slate = yield* taken(
        Slate.empty,
        [listing("fbs", [live(one, "10:00")]), pushed(snapshot({ id: one, status: "live", period: 2 }))],
        t0
      )

      const { games } = slate.published()

      assert.strictEqual(games[0]?.period, 2)
    })
  )

  it.effect("should carry each listed game's plays beside it", () =>
    Effect.gen(function* () {
      const recordedPlay = play({ id: PlayId.make("p1"), sequence: 1 })
      const slate = yield* taken(
        Slate.empty,
        [listing("fbs", [live(one, "10:00")]), playsFor(one, [recordedPlay])],
        t0
      )

      const { games, recentPlays } = slate.published()
      const ids = games.map((listed) => listed.id)

      assert.deepStrictEqual(ids, [one])
      assert.deepStrictEqual(recentPlays, { [one]: [recordedPlay] })
    })
  )

  it.effect("should list a game the slate does not hold as listed", () =>
    Effect.gen(function* () {
      const final = snapshot({ id: one, status: "final" })
      const slate = yield* taken(Slate.empty, [listing("fbs", [final])], t0)

      const { games } = slate.published()

      assert.isFalse(slate.games.has(one))
      assert.deepStrictEqual(games, [final])
    })
  )

  it.effect("should leave off a game no listing has", () =>
    Effect.gen(function* () {
      const slate = yield* taken(
        Slate.empty,
        [listing("fbs", [live(one, "10:00")]), pushed(live(GameId.make("9"), "10:00"))],
        t0
      )

      const ids = slate.published().games.map((listed) => listed.id)

      assert.deepStrictEqual(ids, ["1"])
    })
  )
})

describe("Slate#publishesSameAs", () => {
  it.effect("should be the same after a take that changed nothing", () =>
    Effect.gen(function* () {
      const held = yield* taken(Slate.empty, [polled(live(one, "10:00"))], t0)

      const moved = yield* taken(held, [], t0)

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

/** `before` taking `deliveries` as one frame received at `at`. */
function took(before: Slate, deliveries: ReadonlyArray<Delivery>, at: DateTime.Utc) {
  return before.take({ deliveries, at })
}

function taken(before: Slate, deliveries: ReadonlyArray<Delivery>, at: DateTime.Utc) {
  return Effect.map(took(before, deliveries, at), ({ next }) => next)
}

function tags(observations: ReadonlyArray<SlateObservation>): ReadonlyArray<SlateObservation["_tag"]> {
  return observations.map(({ _tag }) => _tag)
}

function outcomes(observations: ReadonlyArray<SlateObservation>): ReadonlyArray<string> {
  return observations.flatMap((report) => (SlateObservation.$is("Took")(report) ? [report.outcome] : []))
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

/** A `Plays` delivery of game `id`'s whole list of plays, `plays`. */
function playsFor(id: GameId, plays: ReadonlyArray<Play>) {
  return Delivery.cases.Plays.make({ game: id, plays })
}

function whats(events: ReadonlyArray<GameEvent>): ReadonlyArray<GameEventKind> {
  return events.map(({ what }) => what)
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
