import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { vi } from "vitest"
import * as TestWeb from "../TestWeb.ts"
import { CustomStream } from "./CustomStream.ts"
import * as CustomStreams from "./CustomStreams.ts"
import { CustomStreamsChange } from "./CustomStreams.ts"

describe("CustomStreams.customStreams", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new TestWeb.MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should list nothing before a stream is added", () =>
    Effect.gen(function* () {
      const streams = yield* Atom.get(CustomStreams.customStreams).pipe(Effect.provide(AtomRegistry.layer))

      assert.deepStrictEqual(streams, [])
    })
  )

  it.effect("should list streams in the order they were added", () =>
    Effect.gen(function* () {
      const streams = yield* edits([
        CustomStreamsChange.Added({ stream: TestWeb.video }),
        CustomStreamsChange.Added({ stream: TestWeb.playlist })
      ])

      assert.deepStrictEqual(
        streams.map(({ id }) => id),
        [TestWeb.video.id, TestWeb.playlist.id]
      )
    })
  )

  it.effect(
    "should move a stream added again to the end, under its new name, rather than list it twice",
    () =>
      Effect.gen(function* () {
        const again = new CustomStream({ ...TestWeb.video, name: "Again" })

        const streams = yield* edits([
          CustomStreamsChange.Added({ stream: TestWeb.video }),
          CustomStreamsChange.Added({ stream: TestWeb.playlist }),
          CustomStreamsChange.Added({ stream: again })
        ])

        assert.deepStrictEqual(
          streams.map(({ name }) => name),
          ["Week 6", "Again"]
        )
      })
  )

  it.effect("should rename a saved stream", () =>
    Effect.gen(function* () {
      const streams = yield* edits([
        CustomStreamsChange.Added({ stream: TestWeb.video }),
        CustomStreamsChange.Renamed({ id: TestWeb.video.id, name: "Recap" })
      ])

      assert.deepStrictEqual(
        streams.map(({ name }) => name),
        ["Recap"]
      )
    })
  )

  it.effect("should remove a saved stream", () =>
    Effect.gen(function* () {
      const streams = yield* edits([
        CustomStreamsChange.Added({ stream: TestWeb.video }),
        CustomStreamsChange.Added({ stream: TestWeb.playlist }),
        CustomStreamsChange.Removed({ id: TestWeb.video.id })
      ])

      assert.deepStrictEqual(
        streams.map(({ id }) => id),
        [TestWeb.playlist.id]
      )
    })
  )

  it.effect("should keep the list in this browser", () =>
    Effect.gen(function* () {
      yield* edits([CustomStreamsChange.Added({ stream: TestWeb.video })])

      const kept = localStorage.getItem("sportal.custom") ?? ""

      assert.include(kept, '"videoId":"dQw4w9WgXcQ"')
    })
  )

  it.effect("should read a kept list that does not decode as empty", () =>
    Effect.gen(function* () {
      localStorage.setItem("sportal.custom", '[{"id":7}]')

      const streams = yield* Atom.get(CustomStreams.customStreams).pipe(Effect.provide(AtomRegistry.layer))

      assert.deepStrictEqual(streams, [])
    })
  )
})

/** The saved list after `changes`, written in order to a fresh registry. */
function edits(changes: ReadonlyArray<CustomStreamsChange>) {
  return Effect.gen(function* () {
    for (const change of changes) yield* Atom.set(CustomStreams.customStreams, change)
    return yield* Atom.get(CustomStreams.customStreams)
  }).pipe(Effect.provide(AtomRegistry.layer))
}
