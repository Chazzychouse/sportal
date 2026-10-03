import { SqliteClient } from "@effect/sql-sqlite-node"
import type { Effect } from "effect"
import { Migrator, type SqlClient } from "effect/sql"

/** The Hub's SQLite database, in `filename` (or `":memory:"`). Each store migrates its own tables. */
export const layer = (filename: string) => SqliteClient.layer({ filename })

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
