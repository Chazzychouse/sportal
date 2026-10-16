import { assert, describe, it } from "@effect/vitest"
import { highlight } from "./TestGame.ts"

describe("Highlight#durationText", () => {
  it("should show minutes and two-digit seconds", () => {
    const clip = highlight({ duration: 69 })

    const text = clip.durationText()

    assert.strictEqual(text, "1:09")
  })

  it("should show a clip under a minute with no minutes as 0", () => {
    const clip = highlight({ duration: 8 })

    const text = clip.durationText()

    assert.strictEqual(text, "0:08")
  })
})
