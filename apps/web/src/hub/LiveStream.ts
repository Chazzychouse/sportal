import { Data, DateTime, Effect, Schema, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import * as ServerEvents from "./ServerEvents.ts"
import { ServerEvent } from "./ServerEvents.ts"

/**
 * The live stream at `url`, its messages folded by `fold` from `initial`, and whether it is up. The EventSource opens
 * when the atom is first read and closes when nothing reads it; it reconnects after an error, and the Hub sends the
 * current answer on every connection. A message that does not decode is logged and skipped.
 */
export function of<M, S>(
  url: string,
  message: Schema.Codec<M, string>,
  initial: S,
  fold: (state: S, message: M) => S
): Atom.Atom<Live<S>> {
  const decode = Schema.decodeUnknownEffect(message)
  const start: Live<S> = { connection: Connection.Connecting(), value: initial }
  const step = (current: Live<S>, event: ServerEvent): Effect.Effect<Live<S>> =>
    ServerEvent.$match(event, {
      Opened: () => Effect.succeed({ ...current, connection: Connection.Connected() }),
      // Only a stream that was up is lost; one that never connected is still connecting, and one already lost
      // keeps the instant it was lost.
      Errored: () =>
        Connection.$is("Connected")(current.connection)
          ? Effect.map(DateTime.now, (since) => ({ ...current, connection: Connection.Lost({ since }) }))
          : Effect.succeed(current),
      Received: ({ data }) =>
        decode(data).pipe(
          Effect.map((each) => ({ ...current, value: fold(current.value, each) })),
          Effect.catchTag("SchemaError", (error) =>
            Effect.logWarning(`Skipped a message on ${url} that did not decode`, error).pipe(
              Effect.as(current)
            )
          )
        )
    })
  return Atom.make(ServerEvents.from(url).pipe(Stream.scanEffect(() => start, step))).pipe(
    Atom.map(AsyncResult.getOrElse(() => start))
  )
}

/** A live stream's folded messages, and whether it is up. */
export interface Live<S> {
  readonly connection: Connection
  readonly value: S
}

/** Whether this client's live stream is up: not connected yet, connected, or lost at an instant and retrying. */
export type Connection = Data.TaggedEnum<{
  Connecting: object
  Connected: object
  Lost: { readonly since: DateTime.Utc }
}>
export const Connection = Data.taggedEnum<Connection>()
