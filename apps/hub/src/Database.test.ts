import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "./Database.ts"
import { withEnv } from "./TestHubConfig.ts"

describe("Database.migrate", () => {
  it.effect("keeps each store's migrations in its own table, so stores number them independently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const first = yield* Database.migrate("first", { "1_create": createTable("first_thing") })
      const second = yield* Database.migrate("second", { "1_create": createTable("second_thing") })
      assert.deepStrictEqual(first, [[1, "create"]])
      assert.deepStrictEqual(second, [[1, "create"]])

      const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`
      assert.includeMembers(
        tables.map((table) => table.name),
        ["first_migrations", "second_migrations", "first_thing", "second_thing"]
      )
    }).pipe(Effect.provide(Database.layer(":memory:")))
  )

  it.effect("runs a migration once", () =>
    Effect.gen(function* () {
      const migrations = { "1_create": createTable("thing") }
      yield* Database.migrate("store", migrations)
      assert.deepStrictEqual(yield* Database.migrate("store", migrations), [])
    }).pipe(Effect.provide(Database.layer(":memory:")))
  )
})

describe("Database.inDataDir", () => {
  it.effect("keeps the database in the Hub's data directory, creating the directory if it is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dataDir = path.join(yield* fs.makeTempDirectoryScoped(), "nested", "sportal")
      const config = withEnv({ SPORTAL_DATA_DIR: dataDir })

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`SELECT 1`
      }).pipe(Effect.provide(Database.inDataDir.pipe(Layer.provide(config))))

      assert.isTrue(yield* fs.exists(path.join(dataDir, "sportal.sqlite")))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("Database.layer", () => {
  it.effect("closing the database checkpoints it, so only the database file remains", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "x.sqlite")

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE thing (id INTEGER)`
        yield* sql`INSERT INTO thing (id) VALUES (1)`
        assert.isTrue(yield* fs.exists(`${file}-wal`))
      }).pipe(Effect.provide(Database.layer(file)))

      assert.isFalse(yield* fs.exists(`${file}-wal`))
      assert.isFalse(yield* fs.exists(`${file}-shm`))
      assert.isTrue(yield* fs.exists(file))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

function createTable(name: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE ${sql(name)} (id INTEGER)`
  })
}
