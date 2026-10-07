import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, FileSystem, Layer, Path, type PlatformError } from "effect"
import { Migrator, type SqlClient, type SqlError } from "effect/sql"
import { HubConfig } from "./HubConfig.ts"

/** A SQLite database as `name` in the Hub's data directory, which is created if it is missing. */
export function layerFile(
  name: string
): Layer.Layer<
  SqlClient.SqlClient,
  SqlError.SqlError | PlatformError.PlatformError,
  HubConfig | FileSystem.FileSystem | Path.Path
> {
  return Layer.unwrap(
    Effect.gen(function* () {
      const { dataDir } = yield* HubConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      yield* fs.makeDirectory(dataDir, { recursive: true })

      return SqliteClient.layer({ filename: path.join(dataDir, name) })
    })
  )
}

/** A SQLite database in memory. */
export const layerMemory: Layer.Layer<SqlClient.SqlClient, SqlError.SqlError> = SqliteClient.layer({
  filename: ":memory:"
})

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
