import { type LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { RecentPlays } from "@sportal/domain/RecentPlays"
import { Stage } from "@sportal/domain/Stage"
import {
  Context,
  Data,
  DateTime,
  Effect,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
  SubscriptionRef
} from "effect"

/**
 * Everything the Hub has told this client over the live stream at /api/live, and whether the stream is up. The
 * EventSource reconnects by itself, and the Hub replays the current slate and stage on every connection.
 */
export class LiveStream extends Context.Service<LiveStream, SubscriptionRef.SubscriptionRef<Live>>()(
  "sportal/web/LiveStream"
) {
  static readonly layer = Layer.effect(
    LiveStream,
    Effect.gen(function* () {
      const live = yield* SubscriptionRef.make<Live>({
        connection: Connection.Connecting(),
        slate: [],
        recentPlays: {},
        stage: Stage.initial
      })

      yield* sourceEvents().pipe(
        Stream.runForEach((event) => step(live, event)),
        Effect.forkScoped
      )

      return live
    })
  )
}

/** Whether this client's live stream is up: not connected yet, connected, or lost at an instant and retrying. */
export type Connection = Data.TaggedEnum<{
  Connecting: object
  Connected: object
  Lost: { readonly since: DateTime.Utc }
}>
export const Connection = Data.taggedEnum<Connection>()

type Live = {
  readonly connection: Connection
  readonly slate: ReadonlyArray<GameSnapshot>
  readonly recentPlays: RecentPlays
  readonly stage: Stage
}

type SourceEvent = { _tag: "Opened" } | { _tag: "Errored" } | { _tag: "Received"; data: unknown }

function sourceEvents() {
  return Stream.callback<SourceEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const source = new EventSource("/api/live")
        source.onopen = () => Queue.offerUnsafe(queue, { _tag: "Opened" })
        source.onerror = () => Queue.offerUnsafe(queue, { _tag: "Errored" })
        source.onmessage = (event) => Queue.offerUnsafe(queue, { _tag: "Received", data: event.data })
        return source
      }),
      (source) => Effect.sync(() => source.close())
    )
  )
}

function step(live: SubscriptionRef.SubscriptionRef<Live>, event: SourceEvent) {
  switch (event._tag) {
    case "Opened":
      return SubscriptionRef.update(live, (current) => ({ ...current, connection: Connection.Connected() }))
    case "Errored":
      // Only a stream that was up is lost; one that never connected is still connecting, and one already lost
      // keeps the instant it was lost. Either way, nothing changed, so nothing is published.
      return DateTime.now.pipe(
        Effect.flatMap((now) =>
          SubscriptionRef.updateSome(live, (current) =>
            current.connection._tag === "Connected"
              ? Option.some({ ...current, connection: Connection.Lost({ since: now }) })
              : Option.none()
          )
        )
      )
    case "Received":
      return decodeLiveMessage(event.data).pipe(
        Effect.flatMap((message) => SubscriptionRef.update(live, (current) => received(current, message))),
        Effect.catchTag("SchemaError", (error) =>
          Effect.logWarning("Skipped a live message that did not decode", error)
        )
      )
  }
}

function received(live: Live, message: LiveMessage): Live {
  switch (message._tag) {
    case "SlateChanged":
      return { ...live, slate: message.games, recentPlays: message.recentPlays }
    case "StageChanged":
      return { ...live, stage: message.stage }
  }
}

const decodeLiveMessage = Schema.decodeUnknownEffect(LiveMessageJson)
