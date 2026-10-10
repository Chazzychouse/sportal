import { LiveMessage, LiveMessageJson, type SlateChanged } from "@sportal/api/LiveMessage"
import { Slate } from "@sportal/domain/Slate"
import { Data, DateTime, Effect, Schema, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import * as ServerEvents from "./ServerEvents.ts"
import { ServerEvent } from "./ServerEvents.ts"

/**
 * Everything the Hub has told this client over the live stream at /api/live, and whether the stream is up. The
 * EventSource opens when the atom is first read and stays open while its registry lives; it reconnects after an error,
 * and the Hub replays the current slate on every connection.
 */
export const live: Atom.Atom<Live> = Atom.make(
  ServerEvents.from("/api/live").pipe(Stream.scanEffect(initial, step))
).pipe(Atom.map(AsyncResult.getOrElse(initial)), Atom.keepAlive)

/** Whether this client's live stream is up: not connected yet, connected, or lost at an instant and retrying. */
export type Connection = Data.TaggedEnum<{
  Connecting: object
  Connected: object
  Lost: { readonly since: DateTime.Utc }
}>
export const Connection = Data.taggedEnum<Connection>()

interface Live {
  readonly connection: Connection
  readonly slate: Slate
  /** Each listed game's availability from every source, by its id. */
  readonly availability: SlateChanged["availability"]
  /** Each listed game's classification, by its id. */
  readonly classifications: SlateChanged["classifications"]
}

function initial(): Live {
  return { connection: Connection.Connecting(), slate: Slate.empty, availability: {}, classifications: {} }
}

/** What `current` becomes on `event`; `current` itself when nothing changed, so nothing is published. */
function step(current: Live, event: ServerEvent): Effect.Effect<Live> {
  return ServerEvent.$match(event, {
    Opened: () => Effect.succeed({ ...current, connection: Connection.Connected() }),
    // Only a stream that was up is lost; one that never connected is still connecting, and one already lost
    // keeps the instant it was lost.
    Errored: () =>
      Connection.$is("Connected")(current.connection)
        ? Effect.map(DateTime.now, (since) => ({ ...current, connection: Connection.Lost({ since }) }))
        : Effect.succeed(current),
    Received: ({ data }) =>
      decodeLiveMessage(data).pipe(
        Effect.map((message) => received(current, message)),
        Effect.catchTag("SchemaError", (error) =>
          Effect.logWarning("Skipped a live message that did not decode", error).pipe(Effect.as(current))
        )
      )
  })
}

function received(live: Live, message: LiveMessage): Live {
  return LiveMessage.match(message, {
    SlateChanged: ({ slate, availability, classifications }): Live => ({
      ...live,
      slate,
      availability,
      classifications
    })
  })
}

const decodeLiveMessage = Schema.decodeUnknownEffect(LiveMessageJson)
