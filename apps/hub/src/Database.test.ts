import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "./Database.ts"
import { withEnv } from "./TestHubConfig.ts"

describe("Database.migrate", () => {
  it.effect("should keep each store's migrations in its own table, so stores number them independently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const first = yield* Database.migrate("first", { "1_create": createTable("first_thing") })
      const second = yield* Database.migrate("second", { "1_create": createTable("second_thing") })

      const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`
      assert.deepStrictEqual(first, [[1, "create"]])
      assert.deepStrictEqual(second, [[1, "create"]])
      assert.includeMembers(
        tables.map((table) => table.name),
        ["first_migrations", "second_migrations", "first_thing", "second_thing"]
      )
    }).pipe(Effect.provide(Database.at(":memory:")))
  )

  it.effect("should run a migration once", () =>
    Effect.gen(function* () {
      const migrations = { "1_create": createTable("thing") }
      yield* Database.migrate("store", migrations)

      const again = yield* Database.migrate("store", migrations)

      assert.deepStrictEqual(again, [])
    }).pipe(Effect.provide(Database.at(":memory:")))
  )
})

describe("Database.inDataDir", () => {
  it.effect(
    "should keep the database in the Hub's data directory, creating the directory if it is missing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const temp = yield* fs.makeTempDirectoryScoped()
        const dataDir = path.join(temp, "nested", "sportal")
        const database = Database.inDataDir.pipe(Layer.provide(withEnv({ SPORTAL_DATA_DIR: dataDir })))

        yield* selectOne().pipe(Effect.provide(database))

        const written = yield* fs.exists(path.join(dataDir, "sportal.sqlite"))
        assert.isTrue(written)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("Database.at", () => {
  it.effect("should checkpoint the database on closing, so only the database file remains", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const temp = yield* fs.makeTempDirectoryScoped()
      const file = path.join(temp, "x.sqlite")

      const walWhileOpen = yield* writtenThenWal(file).pipe(Effect.provide(Database.at(file)))

      const walAfter = yield* fs.exists(`${file}-wal`)
      const shmAfter = yield* fs.exists(`${file}-shm`)
      const fileAfter = yield* fs.exists(file)
      assert.isTrue(walWhileOpen)
      assert.isFalse(walAfter)
      assert.isFalse(shmAfter)
      assert.isTrue(fileAfter)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

function createTable(name: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE ${sql(name)} (id INTEGER)`
  })
}

function selectOne() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`SELECT 1`
  })
}

/** Writes a row to the open database at `file`, then whether its write-ahead log is on disk. */
function writtenThenWal(file: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const fs = yield* FileSystem.FileSystem

    yield* sql`CREATE TABLE thing (id INTEGER)`
    yield* sql`INSERT INTO thing (id) VALUES (1)`

    return yield* fs.exists(`${file}-wal`)
  })
}
