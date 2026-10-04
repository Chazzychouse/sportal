import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, FileSystem, Layer, Path } from "effect"
import { Migrator, type SqlClient } from "effect/sql"
import { HubConfig } from "../HubConfig.ts"

/** The Hub's SQLite database, in `filename` (or `":memory:"`). Each store migrates its own tables. */
export const layer = (filename: string) => SqliteClient.layer({ filename })

/** The Hub's database as `sportal.sqlite` in its data directory, which is created if it is missing. */
export const inDataDir = Layer.unwrap(
  Effect.gen(function* () {
    const { dataDir } = yield* HubConfig
    yield* (yield* FileSystem.FileSystem).makeDirectory(dataDir, { recursive: true })
    return layer((yield* Path.Path).join(dataDir, "sportal.sqlite"))
  })
)

/**
 * Runs one store's pending migrations, keyed `<id>_<name>`, and records them in that store's own table,
 * `<store>_migrations`, so two stores never share a numbering. Returns the migrations it ran.
 */
export function migrate(
  store: string,
  migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>
) {
  return run({ loader: Migrator.fromRecord(migrations), table: `${store}_migrations` })
}

const run = Migrator.make({})
