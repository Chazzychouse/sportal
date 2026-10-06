import { type ChannelCarriage, SourceName } from "@sportal/domain/Channel"
import { Network } from "@sportal/domain/Game"
import { DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import * as Database from "../Database.ts"
import { ChannelStore, ChannelStoreError } from "./ChannelStore.ts"

/** Channel carriages in the Hub's database, in a table this store creates and migrates itself. */
export const layer = Layer.effect(
  ChannelStore,
  Effect.gen(function* () {
    yield* Database.migrate("channel", migrations)
    const sql = yield* SqlClient.SqlClient

    const rows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        network: Network,
        source: SourceName,
        carried: Schema.Literals([0, 1]),
        url: Schema.NullOr(Schema.String)
      }),
      execute: () => sql`SELECT network, source, carried, url FROM channel_carriage`
    })

    const carriages = rows().pipe(
      Effect.map((found) =>
        found.map(
          ({ network, source, carried, url }): ChannelCarriage =>
            carried === 1 && url !== null
              ? {
                  _tag: "Carried",
                  network,
                  // A hand-learned channel has no name of its own; it is known by the network it was picked for.
                  channel: { name: network, source, locator: { _tag: "WebView", url } }
                }
              : { _tag: "NotCarried", network, source }
        )
      ),
      Effect.mapError((cause) => new ChannelStoreError({ cause }))
    )

    const record = Effect.fn("SqlChannelStore.record")(function* (carriage: ChannelCarriage) {
      const row =
        carriage._tag === "Carried"
          ? {
              network: carriage.network,
              source: carriage.channel.source,
              carried: 1,
              url: carriage.channel.locator.url
            }
          : { network: carriage.network, source: carriage.source, carried: 0, url: null }
      const recordedAt = DateTime.formatIso(yield* DateTime.now)
      yield* sql`
        INSERT INTO channel_carriage ${sql.insert({ ...row, recorded_at: recordedAt })}
        ON CONFLICT (network, source) DO UPDATE SET
          carried = excluded.carried, url = excluded.url, recorded_at = excluded.recorded_at
      `.pipe(Effect.mapError((cause) => new ChannelStoreError({ cause })))
    })

    const forget = Effect.fn("SqlChannelStore.forget")((network: Network, source: SourceName) =>
      sql`DELETE FROM channel_carriage WHERE network = ${network} AND source = ${source}`.pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new ChannelStoreError({ cause }))
      )
    )

    return ChannelStore.of({ carriages, record, forget })
  })
)

/** This store's migrations, recorded in `channel_migrations`. */
const migrations = {
  "1_create_channel_carriage": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE channel_carriage (
        network TEXT NOT NULL,
        source TEXT NOT NULL,
        carried INTEGER NOT NULL,
        url TEXT,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (network, source)
      )
    `
  })
}
