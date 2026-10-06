import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Network } from "@sportal/domain/Game"
import { Effect, FileSystem, Layer } from "effect"
import * as TestDatabase from "../TestDatabase.ts"
import { ChannelStore } from "./ChannelStore.ts"

const espn = Network.make("ESPN")
const espnPlus = Network.make("ESPN+")
const carried = (url: string) => ({
  _tag: "Carried" as const,
  network: espn,
  channel: { name: espn, source: "YouTube TV" as const, locator: { _tag: "WebView" as const, url } }
})
const notCarried = { _tag: "NotCarried" as const, network: espnPlus, source: "YouTube TV" as const }

describe("ChannelStore", () => {
  it.effect("starts empty and returns each carriage recorded", () =>
    Effect.gen(function* () {
      const filename = yield* tempDatabase()
      const carriages = yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* store.carriages, [])
          yield* store.record(carried("https://tv.youtube.com/watch/espn"))
          yield* store.record(notCarried)
          return yield* store.carriages
        })
      )
      assert.sameDeepMembers([...carriages], [carried("https://tv.youtube.com/watch/espn"), notCarried])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("replaces an earlier carriage for the same network", () =>
    Effect.gen(function* () {
      const filename = yield* tempDatabase()
      const carriages = yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          yield* store.record(carried("https://tv.youtube.com/watch/first"))
          yield* store.record(carried("https://tv.youtube.com/watch/second"))
          return yield* store.carriages
        })
      )
      assert.deepStrictEqual(carriages, [carried("https://tv.youtube.com/watch/second")])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("forgets a carriage", () =>
    Effect.gen(function* () {
      const filename = yield* tempDatabase()
      const carriages = yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          yield* store.record(carried("https://tv.youtube.com/watch/espn"))
          yield* store.forget(espn, "YouTube TV")
          return yield* store.carriages
        })
      )
      assert.deepStrictEqual(carriages, [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps carriages when the database is opened again", () =>
    Effect.gen(function* () {
      const filename = yield* tempDatabase()
      yield* withStore(filename, (store) => store.record(notCarried))
      const carriages = yield* withStore(filename, (store) => store.carriages)
      assert.deepStrictEqual(carriages, [notCarried])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** A database file in a temporary directory that is removed when the test's scope closes. */
function tempDatabase() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return join(yield* fs.makeTempDirectoryScoped(), "sportal.sqlite")
  })
}

/** Runs `use` against the channel store over the given database file, opened fresh. */
function withStore<A, E>(filename: string, use: (store: typeof ChannelStore.Service) => Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    return yield* use(yield* ChannelStore)
  }).pipe(Effect.provide(ChannelStore.layer.pipe(Layer.provide(TestDatabase.layer(filename)))))
}
