import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Option } from "effect"
import type { Classification } from "./Classification.ts"
import { Classifier } from "./Classifier.ts"
import { Game, GameId, type GameSnapshot } from "./Game.ts"
import { BreakReason } from "./Moment.ts"
import { Kickoff, type Play, PlayId, Punt, Stoppage } from "./Play.ts"
import { Slate, SlateChange } from "./Slate.ts"
import {
  completion,
  liveSnapshot,
  odds,
  play,
  playFields,
  sides,
  situation,
  snapshot,
  team,
  timeout
} from "./TestGame.ts"

describe("Classifier#step, moments", () => {
  it("should call a scheduled game upcoming", () => {
    const moment = momentOf(Classifier.empty, snapshot({ id }))

    assert.strictEqual(moment, "Upcoming")
  })

  it("should call a final game final", () => {
    const moment = momentOf(Classifier.empty, snapshot({ id, status: "final", period: 4 }))

    assert.strictEqual(moment, "Final")
  })

  it("should call a drive in the red zone a scoring threat", () => {
    const moment = momentOf(Classifier.empty, liveSnapshot({ id, situation: situation({ yardLine: 15 }) }))

    assert.strictEqual(moment, "ScoringThreat")
  })

  it("should call the last five minutes of a one-score game crunch time", () => {
    const moment = momentOf(
      Classifier.empty,
      liveSnapshot({ id, period: 4, clock: "3:00", ...sides(20, 17) })
    )

    assert.strictEqual(moment, "CrunchTime")
  })

  it("should call a game a big play when a play it did not have is one", () => {
    const big = completion({ yards: 40 })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [big]), [played(big)], at)

    assert.strictEqual(classified.get(id)?.moment._tag, "BigPlay")
  })

  it("should call no big play for a batch of more than three new plays", () => {
    const plays = [1, 2, 3, 4].map((sequence) => completion({ id: playId(sequence), sequence, yards: 40 }))

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), plays), plays.map(played), at)

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should call a game at halftime a break", () => {
    const moment = momentOf(
      Classifier.empty,
      liveSnapshot({ id, status: "halftime", period: 2, clock: "0:00" })
    )

    assert.strictEqual(moment, "Break")
  })

  it("should call a game a break after a timeout", () => {
    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [timeout()]), [], at)

    assert.strictEqual(reasonOf(classified), "timeout")
  })

  it("should call a game a break from a score until the next kickoff", () => {
    const touchdown = play({ yards: 2, touchdown: true, scoring: true })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [touchdown]), [], at)

    assert.strictEqual(reasonOf(classified), "afterScore")
  })

  it("should call a game a break after a kickoff returned for a touchdown", () => {
    const returned = new Kickoff({ ...playFields, yards: 70, returnTouchdown: true, scoring: true })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [returned]), [], at)

    assert.strictEqual(reasonOf(classified), "afterScore")
  })

  it("should call a game at the end of a period a break", () => {
    const [, classified] = Classifier.empty.step(
      slateOf(liveSnapshot({ id, period: 1, clock: "0:00" })),
      [],
      at
    )

    assert.strictEqual(reasonOf(classified), "periodEnd")
  })

  it("should call a game a break after the two-minute warning", () => {
    const warning = new Stoppage({ ...playFields, kind: "twoMinuteWarning" })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [warning]), [], at)

    assert.strictEqual(reasonOf(classified), "twoMinuteWarning")
  })

  it("should call a game a break after a punt", () => {
    const punt = new Punt({ ...playFields, team: home, yards: 40, return: "none" })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [punt]), [], at)

    assert.strictEqual(reasonOf(classified), "possessionChange")
  })

  it("should end a break when the next snap arrives", () => {
    const punt = new Punt({ ...playFields, team: home, yards: 40, return: "none" })
    const snap = play({ id: playId(2), sequence: 2 })
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [punt]), [], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id }), [punt, snap]), [played(snap)], later(5))

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should call a game a break after the kickoff that follows a score", () => {
    const touchdown = play({ yards: 2, touchdown: true, scoring: true })
    const kickoff = new Kickoff({
      ...playFields,
      id: playId(2),
      sequence: 2,
      yards: 40,
      returnTouchdown: false
    })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [touchdown, kickoff]), [], at)

    assert.strictEqual(reasonOf(classified), "afterKickoff")
  })

  it("should call the opening kickoff live play", () => {
    const kickoff = new Kickoff({ ...playFields, yards: 40, returnTouchdown: false })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [kickoff]), [], at)

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should call a game a break after a play a player was hurt on", () => {
    const hurt = play({ text: "Smith rush for 3 yards. Jones was injured during the play." })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [hurt]), [], at)

    assert.strictEqual(reasonOf(classified), "injury")
  })

  it("should call a timeout in the red zone a break during a scoring threat", () => {
    const [, classified] = Classifier.empty.step(
      slateOf(liveSnapshot({ id, situation: situation({ yardLine: 15 }) }), [timeout()]),
      [],
      at
    )

    const moment = classified.get(id)?.moment
    assert.strictEqual(moment?._tag === "Break" ? moment.during?._tag : undefined, "ScoringThreat")
  })

  it("should put a touchdown's big play before the break after the score", () => {
    const touchdown = play({ yards: 2, touchdown: true, scoring: true })

    const [, classified] = Classifier.empty.step(
      slateOf(liveSnapshot({ id }), [touchdown]),
      [played(touchdown)],
      at
    )

    assert.strictEqual(classified.get(id)?.moment._tag, "BigPlay")
  })

  it("should expect a break back after its reason's typical length for the game's league", () => {
    const [, classified] = Classifier.empty.step(
      slateOf(liveSnapshot({ id, league: "nfl" }), [timeout()]),
      [],
      at
    )

    const moment = classified.get(id)?.moment
    const expected = DateTime.addDuration(at, BreakReason.typicalLength("timeout", "nfl"))
    assert.isTrue(moment?._tag === "Break" && DateTime.Equivalence(moment.expectedEnd, expected))
  })

  it("should call a game live with nothing else going on", () => {
    const moment = momentOf(Classifier.empty, liveSnapshot({ id }))

    assert.strictEqual(moment, "Live")
  })
})

describe("Classifier#step, a stall", () => {
  it("should not call a game stalled while its clock runs, though no play arrives", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [play()]), [played(play())], at)
    const [second] = first.step(slateOf(liveSnapshot({ id, clock: "9:20" }), [play()]), [], later(60))

    const [, classified] = second.step(slateOf(liveSnapshot({ id, clock: "8:40" }), [play()]), [], later(140))

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should not call a game stalled when its score changes, though no play arrives", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [play()]), [played(play())], at)
    const [second] = first.step(slateOf(liveSnapshot({ id, ...sides(7, 0) }), [play()]), [], later(60))

    const [, classified] = second.step(
      slateOf(liveSnapshot({ id, ...sides(7, 0) }), [play()]),
      [],
      later(140)
    )

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should call a game a break when no play has arrived for ninety seconds", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [play()]), [played(play())], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id }), [play()]), [], later(90))

    assert.strictEqual(reasonOf(classified), "stall")
  })

  it("should not call a game stalled at eighty-nine seconds", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [play()]), [played(play())], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id }), [play()]), [], later(89))

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should not call a game stalled when it kicks off", () => {
    const [first] = Classifier.empty.step(slateOf(snapshot({ id })), [], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id })), [], later(600))

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should not call a game stalled when it comes back from halftime", () => {
    const [first] = Classifier.empty.step(
      slateOf(liveSnapshot({ id, status: "halftime", period: 2, clock: "0:00" })),
      [],
      at
    )

    const [, classified] = first.step(
      slateOf(liveSnapshot({ id, period: 3, clock: "15:00" })),
      [],
      later(1200)
    )

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should call a game stalled ninety seconds after it kicks off with no play", () => {
    const [first] = Classifier.empty.step(slateOf(snapshot({ id })), [], at)
    const [second] = first.step(slateOf(liveSnapshot({ id })), [], later(600))

    const [, classified] = second.step(slateOf(liveSnapshot({ id })), [], later(690))

    assert.strictEqual(reasonOf(classified), "stall")
  })
})

describe("Classifier#step, holding a moment", () => {
  it("should keep a moment for twenty seconds before a lower one replaces it", () => {
    const [first] = Classifier.empty.step(
      slateOf(liveSnapshot({ id, situation: situation({ yardLine: 15 }) })),
      [],
      at
    )

    const [, classified] = first.step(slateOf(liveSnapshot({ id })), [], later(19))

    assert.strictEqual(classified.get(id)?.moment._tag, "ScoringThreat")
  })

  it("should let a lower moment replace one held twenty seconds", () => {
    const [first] = Classifier.empty.step(
      slateOf(liveSnapshot({ id, situation: situation({ yardLine: 15 }) })),
      [],
      at
    )

    const [, classified] = first.step(slateOf(liveSnapshot({ id })), [], later(20))

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should let a higher moment replace one at once", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id })), [], at)

    const [, classified] = first.step(
      slateOf(liveSnapshot({ id, situation: situation({ yardLine: 15 }) })),
      [],
      later(1)
    )

    assert.strictEqual(classified.get(id)?.moment._tag, "ScoringThreat")
    assert.isTrue(DateTime.Equivalence(classified.get(id)?.since ?? at, later(1)))
  })

  it("should keep when a moment began while it holds", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id })), [], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id, clock: "9:00" })), [], later(30))

    assert.isTrue(DateTime.Equivalence(classified.get(id)?.since ?? later(30), at))
  })

  it("should end a big play a minute after it", () => {
    const big = completion({ yards: 40 })
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [big]), [played(big)], at)

    const [, classified] = first.step(slateOf(liveSnapshot({ id }), [big]), [], later(60))

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should leave a break at once when play resumes", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [timeout()]), [], at)
    const snap = play({ id: playId(2), sequence: 2 })

    const [, classified] = first.step(
      slateOf(liveSnapshot({ id }), [timeout(), snap]),
      [played(snap)],
      later(1)
    )

    assert.strictEqual(classified.get(id)?.moment._tag, "Live")
  })

  it("should keep a break's expected end while it holds", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [timeout()]), [], at)
    const expected = DateTime.addDuration(at, BreakReason.typicalLength("timeout", "fbs"))

    const [, classified] = first.step(slateOf(liveSnapshot({ id }), [timeout()]), [], later(30))

    const moment = classified.get(id)?.moment
    assert.isTrue(moment?._tag === "Break" && DateTime.Equivalence(moment.expectedEnd, expected))
  })
})

describe("Classifier#nextExpiry", () => {
  it("should be none for a game not yet live", () => {
    const [classifier] = Classifier.empty.step(slateOf(snapshot({ id })), [], at)

    assert.isTrue(Option.isNone(classifier.nextExpiry()))
  })

  it("should be when a live game with no new play would stall", () => {
    const [classifier] = Classifier.empty.step(slateOf(liveSnapshot({ id })), [], at)

    assert.deepStrictEqual(classifier.nextExpiry(), Option.some(later(90)))
  })

  it("should be when a big play ends", () => {
    const big = completion({ yards: 40 })

    const [classifier] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [big]), [played(big)], at)

    assert.deepStrictEqual(classifier.nextExpiry(), Option.some(later(60)))
  })

  it("should be when a moment held back from a lower one may give way", () => {
    const [first] = Classifier.empty.step(
      slateOf(liveSnapshot({ id, situation: situation({ yardLine: 15 }) })),
      [],
      at
    )

    const [classifier] = first.step(slateOf(liveSnapshot({ id })), [], later(5))

    assert.deepStrictEqual(classifier.nextExpiry(), Option.some(later(20)))
  })
})

describe("Classifier#step, what it keeps", () => {
  it("should keep a game's line after the scoreboard stops sending it", () => {
    const [first] = Classifier.empty.step(slateOf(snapshot({ id, odds: odds({ spread: 0 }) })), [], at)
    const kickedOff = liveSnapshot({ id })

    const [, kept] = first.step(slateOf(kickedOff), [], later(1))
    const [, fresh] = Classifier.empty.step(slateOf(kickedOff), [], later(1))

    assert.isAbove(kept.get(id)?.breakdown.prior ?? 0, fresh.get(id)?.breakdown.prior ?? 0)
  })

  it("should forget a game no listing names", () => {
    const [first] = Classifier.empty.step(slateOf(liveSnapshot({ id })), [], at)

    const [, classified] = first.step(Slate.empty, [], later(1))

    assert.isFalse(classified.has(id))
  })
})

const id = GameId.make("1")

const at = DateTime.makeUnsafe("2026-10-10T20:00:00Z")

function later(seconds: number): DateTime.Utc {
  return DateTime.addDuration(at, Duration.seconds(seconds))
}

function playId(sequence: number) {
  return PlayId.make(String(sequence))
}

function slateOf(game: GameSnapshot, plays: ReadonlyArray<Play> = []): Slate {
  return new Slate({ games: [new Game({ snapshot: game, plays })] })
}

function played(play: Play): SlateChange {
  return SlateChange.Played({ game: Game.of(liveSnapshot({ id })), play })
}

/** `game`'s moment's tag, stepped with no changes. */
function momentOf(classifier: Classifier, game: GameSnapshot) {
  const [, classified] = classifier.step(slateOf(game), [], at)
  return classified.get(id)?.moment._tag
}

const home = team("HOME").id

/** Game `id`'s break reason, if it is in a break. */
function reasonOf(classified: ReadonlyMap<GameId, Classification>) {
  const moment = classified.get(id)?.moment
  return moment?._tag === "Break" ? moment.reason : undefined
}
