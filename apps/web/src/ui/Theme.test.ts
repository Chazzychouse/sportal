import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { vi } from "vitest"
import * as TestWeb from "../TestWeb.ts"
import * as Theme from "./Theme.ts"

describe("Theme.theme", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should read Glass when no theme is kept", () =>
    Effect.gen(function* () {
      const theme = yield* Atom.get(Theme.theme).pipe(Effect.provide(AtomRegistry.layer))

      assert.strictEqual(theme, "glass")
    })
  )

  it.effect("should read Glass when what is kept is not a theme", () =>
    Effect.gen(function* () {
      localStorage.setItem("sportal.theme", JSON.stringify("neon"))

      const theme = yield* Atom.get(Theme.theme).pipe(Effect.provide(AtomRegistry.layer))

      assert.strictEqual(theme, "glass")
    })
  )

  it.effect("should read the theme kept in this browser", () =>
    Effect.gen(function* () {
      localStorage.setItem("sportal.theme", JSON.stringify("team"))

      const theme = yield* Atom.get(Theme.theme).pipe(Effect.provide(AtomRegistry.layer))

      assert.strictEqual(theme, "team")
    })
  )

  it.effect("should keep a chosen theme in this browser", () =>
    Effect.gen(function* () {
      yield* Atom.set(Theme.theme, "team").pipe(Effect.provide(AtomRegistry.layer))

      const kept = localStorage.getItem("sportal.theme") ?? ""

      assert.include(kept, "team")
    })
  )
})
