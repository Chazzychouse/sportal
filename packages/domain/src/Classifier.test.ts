import { assert, describe, it } from "@effect/vitest"
import { DateTime, Duration, Option } from "effect"
import { Classifier } from "./Classifier.ts"
import { Game, GameId, type GameSnapshot } from "./Game.ts"
import { Kickoff, type Play, PlayId } from "./Play.ts"
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

    assert.deepStrictEqual(classified.get(id)?.moment, { _tag: "Break", reason: "timeout" })
  })

  it("should call a game a break from a score until the next kickoff", () => {
    const touchdown = play({ yards: 2, touchdown: true, scoring: true })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [touchdown]), [], at)

    assert.deepStrictEqual(classified.get(id)?.moment, { _tag: "Break", reason: "afterScore" })
  })

  it("should call a game a break after a kickoff returned for a touchdown", () => {
    const returned = new Kickoff({ ...playFields, yards: 70, returnTouchdown: true, scoring: true })

    const [, classified] = Classifier.empty.step(slateOf(liveSnapshot({ id }), [returned]), [], at)

    assert.deepStrictEqual(classified.get(id)?.moment, { _tag: "Break", reason: "afterScore" })
  })

  it("should call a game at the end of a period a break", () => {
    const [, classified] = Classifier.empty.step(
      slateOf(liveSnapshot({ id, period: 1, clock: "0:00" })),
      [],
      at
    )

    assert.deepStrictEqual(classified.get(id)?.moment, { _tag: "Break", reason: "periodEnd" })
  })

  it("should call a game live with nothing else going on", () => {
    const moment = momentOf(Classifier.empty, liveSnapshot({ id }))

    assert.strictEqual(moment, "Live")
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
})

describe("Classifier#nextExpiry", () => {
  it("should be none with nothing held", () => {
    const [classifier] = Classifier.empty.step(slateOf(liveSnapshot({ id })), [], at)

    assert.isTrue(Option.isNone(classifier.nextExpiry()))
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
