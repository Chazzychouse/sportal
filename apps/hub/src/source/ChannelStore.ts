import { ChannelCarriage, SourceName } from "@sportal/domain/Channel"
import { Network } from "@sportal/domain/Game"
import { Context, DateTime, Effect, Layer, Schema, SchemaTransformation } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import * as Database from "../Database.ts"

/** Where the Hub keeps the channel carriages it learned from the user: they cannot be fetched again. */
export class ChannelStore extends Context.Service<
  ChannelStore,
  {
    readonly carriages: Effect.Effect<ReadonlyArray<ChannelCarriage>, ChannelStoreError>
    /** Records a carriage, replacing any earlier one for the same network and source. */
    record(carriage: ChannelCarriage): Effect.Effect<void, ChannelStoreError>
    forget(network: Network, source: SourceName): Effect.Effect<void, ChannelStoreError>
  }
>()("sportal/hub/ChannelStore") {
  /** In the Hub's database, in a table this store creates and migrates itself. */
  static readonly layer = Layer.effect(
    ChannelStore,
    Effect.gen(function* () {
      yield* Database.migrate("channel", migrations)
      const sql = yield* SqlClient.SqlClient

      const carriages = SqlSchema.findAll({
        Request: Schema.Void,
        Result: CarriageRow,
        execute: () => sql`SELECT network, source, carried, url FROM channel_carriage`
      })().pipe(Effect.mapError(storeError))

      const record = Effect.fn("ChannelStore.record")(function* (carriage: ChannelCarriage) {
        const row = yield* Schema.encodeEffect(CarriageRow)(carriage)
        const recordedAt = DateTime.formatIso(yield* DateTime.now)
        yield* sql`
          INSERT INTO channel_carriage ${sql.insert({ ...row, recorded_at: recordedAt })}
          ON CONFLICT (network, source) DO UPDATE SET
            carried = excluded.carried, url = excluded.url, recorded_at = excluded.recorded_at
        `
      }, Effect.mapError(storeError))

      const forget = Effect.fn("ChannelStore.forget")(
        (network: Network, source: SourceName) =>
          sql`DELETE FROM channel_carriage WHERE network = ${network} AND source = ${source}`.pipe(
            Effect.asVoid
          ),
        Effect.mapError(storeError)
      )

      return ChannelStore.of({ carriages, record, forget })
    })
  )
}

export class ChannelStoreError extends Schema.TaggedError<ChannelStoreError>()("ChannelStoreError", {
  cause: Schema.Defect()
}) {}

function storeError(cause: unknown) {
  return new ChannelStoreError({ cause })
}

/** A row of `channel_carriage` as the carriage it holds: carried only when it has an address. */
const CarriageRow = Schema.Struct({
  network: Network,
  source: SourceName,
  carried: Schema.Literals([0, 1]),
  url: Schema.NullOr(Schema.String)
}).pipe(
  Schema.decodeTo(
    Schema.toType(ChannelCarriage),
    SchemaTransformation.transform({
      decode: ({ network, source, carried, url }): ChannelCarriage =>
        carried === 1 && url !== null
          ? {
              _tag: "Carried",
              network,
              // A hand-learned channel has no name of its own; it is known by the network it was picked for.
              channel: { name: network, source, locator: { _tag: "WebView", url } }
            }
          : { _tag: "NotCarried", network, source },
      encode: (carriage) =>
        carriage._tag === "Carried"
          ? {
              network: carriage.network,
              source: carriage.channel.source,
              carried: 1 as const,
              url: carriage.channel.locator.url
            }
          : { network: carriage.network, source: carriage.source, carried: 0 as const, url: null }
    })
  )
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
