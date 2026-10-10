import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Duration, Option } from "effect"
import {
  Decision,
  details,
  explain,
  LayoutDecision,
  MainDecision,
  SoundDecision,
  StayReason
} from "./Decision.ts"

const dal = GameId.make("dal")
const buf = GameId.make("buf")
const nameOf = (game: GameId) => (game === dal ? "PHI @ DAL" : "NE @ BUF")

function stayed(why: StayReason) {
  return Decision.Stepped({
    ranked: [
      { game: buf, rank: "redZone", score: 70 },
      { game: dal, rank: "live", score: 50 }
    ],
    layout: LayoutDecision.Kept({ layout: "Quad" }),
    main: MainDecision.Stayed({ game: Option.some(dal), why }),
    sound: SoundDecision.OnMain({ game: Option.some(dal) })
  })
}

describe("explain", () => {
  it("should say which game it promoted over which, and why", () => {
    const decision = Decision.Stepped({
      ranked: [],
      layout: LayoutDecision.Fitted({ from: "Quad", to: "Pair" }),
      main: MainDecision.Promoted({ game: buf, over: Option.some(dal), why: "outranks" }),
      sound: SoundDecision.OnMain({ game: Option.some(buf) })
    })

    const words = explain(decision, nameOf)

    assert.strictEqual(
      words,
      "promoted NE @ BUF over PHI @ DAL: it ranks higher; layout Quad to Pair; sound on the main tile"
    )
  })

  it("should say the same words while a dwell counts down", () => {
    const early = stayed(StayReason.Dwell({ left: Duration.seconds(20) }))
    const later = stayed(StayReason.Dwell({ left: Duration.seconds(5) }))

    const [a, b] = [explain(early, nameOf), explain(later, nameOf)]

    assert.strictEqual(a, b)
  })

  it("should say it is off", () => {
    assert.strictEqual(explain(Decision.Off(), nameOf), "off")
  })
})

describe("details", () => {
  it("should give the Rank it saw", () => {
    const given = details(stayed(StayReason.Best()))

    assert.strictEqual(given["autopilot.ranked"], "buf redZone 70, dal live 50")
  })

  it("should give how long a dwell has left", () => {
    const given = details(stayed(StayReason.Dwell({ left: Duration.seconds(20) })))

    assert.strictEqual(given["autopilot.dwellLeftSeconds"], 20)
  })

  it("should give nothing for an autopilot that is off", () => {
    assert.deepStrictEqual(details(Decision.Off()), {})
  })
})
