import { SqliteClient } from "@effect/sql-sqlite-node"

/** A SQLite database in `filename`, or in memory as `":memory:"`. */
export const layer = (filename: string) => SqliteClient.layer({ filename })
