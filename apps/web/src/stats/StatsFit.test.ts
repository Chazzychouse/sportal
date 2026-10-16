import { assert, describe, it } from "@effect/vitest"
import * as StatsFit from "./StatsFit.ts"

describe("StatsFit.sectionsThatFit", () => {
  it("should show every section when all of them fit", () => {
    const shown = StatsFit.sectionsThatFit(100, [
      { section: "header", height: 30 },
      { section: "linescore", height: 30 },
      { section: "leaders", height: 30 }
    ])

    assert.deepStrictEqual(shown, ["header", "linescore", "leaders"])
  })

  it("should show a section that fits exactly", () => {
    const shown = StatsFit.sectionsThatFit(60, [
      { section: "header", height: 30 },
      { section: "linescore", height: 30 }
    ])

    assert.deepStrictEqual(shown, ["header", "linescore"])
  })

  it("should stop at the first section that does not fit, though a later one would", () => {
    const shown = StatsFit.sectionsThatFit(100, [
      { section: "header", height: 30 },
      { section: "teamStats", height: 80 },
      { section: "leaders", height: 10 }
    ])

    assert.deepStrictEqual(shown, ["header"])
  })

  it("should always show the first section", () => {
    const shown = StatsFit.sectionsThatFit(20, [{ section: "header", height: 30 }])

    assert.deepStrictEqual(shown, ["header"])
  })

  it("should show nothing when there are no sections", () => {
    const shown = StatsFit.sectionsThatFit(100, [])

    assert.deepStrictEqual(shown, [])
  })
})
