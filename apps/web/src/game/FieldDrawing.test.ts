import { assert, describe, it } from "@effect/vitest"
import { PlayId } from "@sportal/domain/Play"
import { footballDetail, liveSnapshot, play, team } from "@sportal/domain/TestGame"
import { FieldDrawing, FieldEvent } from "./FieldDrawing.ts"

describe("FieldDrawing.initial", () => {
  it("should take the plays on hand as drawn", () => {
    const drawing = FieldDrawing.initial([playAt(1), playAt(2)])

    assert.deepStrictEqual(drawing, FieldDrawing.Settled({ last: 2 }))
  })
})

describe("FieldDrawing.step", () => {
  it("should draw a play newer than the last", () => {
    const next = FieldDrawing.step(FieldDrawing.Settled({ last: 1 }), arrived([playAt(1), playAt(2)]))

    assert.deepStrictEqual(next, FieldDrawing.Animating({ play: playAt(2), queued: [], last: 2 }))
  })

  it("should queue only the newest three plays that arrive while one draws", () => {
    const drawing = FieldDrawing.Animating({ play: playAt(2), queued: [], last: 2 })

    const next = FieldDrawing.step(drawing, arrived([3, 4, 5, 6].map(playAt)))

    assert.deepStrictEqual(
      next,
      FieldDrawing.Animating({ play: playAt(2), queued: [4, 5, 6].map(playAt), last: 6 })
    )
  })

  it("should skip a play with no spot on the field", () => {
    const offField = play({
      id: PlayId.make("2"),
      sequence: 2,
      detail: footballDetail({ end: { team: team("HOME").id } })
    })

    const next = FieldDrawing.step(FieldDrawing.Settled({ last: 1 }), arrived([offField, playAt(3)]))

    assert.deepStrictEqual(next, FieldDrawing.Animating({ play: playAt(3), queued: [], last: 3 }))
  })

  it("should settle on the newest play sent when the plays go back to an earlier sequence", () => {
    const next = FieldDrawing.step(FieldDrawing.Settled({ last: 9 }), arrived([playAt(1), playAt(2)]))

    assert.deepStrictEqual(next, FieldDrawing.Settled({ last: 2 }))
  })

  it("should draw the next queued play once the drawing one is drawn", () => {
    const drawing = FieldDrawing.Animating({ play: playAt(2), queued: [playAt(3)], last: 3 })

    const next = FieldDrawing.step(drawing, FieldEvent.Drawn({ play: PlayId.make("2"), game }))

    assert.deepStrictEqual(next, FieldDrawing.Animating({ play: playAt(3), queued: [], last: 3 }))
  })

  it("should ignore a drawn play that is not the one drawing", () => {
    const drawing = FieldDrawing.Animating({ play: playAt(2), queued: [playAt(3)], last: 3 })

    const next = FieldDrawing.step(drawing, FieldEvent.Drawn({ play: PlayId.make("9"), game }))

    assert.strictEqual(next, drawing)
  })
})

const game = liveSnapshot()

/** The home team's one-yard rush with sequence `sequence`, its id the same number. */
function playAt(sequence: number) {
  return play({ id: PlayId.make(String(sequence)), sequence })
}

function arrived(plays: ReturnType<typeof playAt>[]) {
  return FieldEvent.Arrived({ plays, game })
}
