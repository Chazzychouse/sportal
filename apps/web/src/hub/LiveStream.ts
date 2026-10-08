import { LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
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
  "sportal/web/hub/LiveStream"
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

interface Live {
  readonly connection: Connection
  readonly slate: ReadonlyArray<GameSnapshot>
  readonly recentPlays: RecentPlays
  readonly stage: Stage
}

type SourceEvent = Data.TaggedEnum<{
  Opened: object
  Errored: object
  Received: { readonly data: unknown }
}>
const SourceEvent = Data.taggedEnum<SourceEvent>()

function sourceEvents() {
  return Stream.callback<SourceEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const source = new EventSource("/api/live")
        source.onopen = () => Queue.offerUnsafe(queue, SourceEvent.Opened())
        source.onerror = () => Queue.offerUnsafe(queue, SourceEvent.Errored())
        source.onmessage = (event) => Queue.offerUnsafe(queue, SourceEvent.Received({ data: event.data }))
        return source
      }),
      (source) => Effect.sync(() => source.close())
    )
  )
}

function step(live: SubscriptionRef.SubscriptionRef<Live>, event: SourceEvent) {
  return SourceEvent.$match(event, {
    Opened: () =>
      SubscriptionRef.update(live, (current) => ({ ...current, connection: Connection.Connected() })),
    // Only a stream that was up is lost; one that never connected is still connecting, and one already lost
    // keeps the instant it was lost. Either way, nothing changed, so nothing is published.
    Errored: () =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          SubscriptionRef.updateSome(live, (current) =>
            Connection.$is("Connected")(current.connection)
              ? Option.some({ ...current, connection: Connection.Lost({ since: now }) })
              : Option.none()
          )
        )
      ),
    Received: ({ data }) =>
      decodeLiveMessage(data).pipe(
        Effect.flatMap((message) => SubscriptionRef.update(live, (current) => received(current, message))),
        Effect.catchTag("SchemaError", (error) =>
          Effect.logWarning("Skipped a live message that did not decode", error)
        )
      )
  })
}

function received(live: Live, message: LiveMessage): Live {
  return LiveMessage.match(message, {
    SlateChanged: ({ games, recentPlays }): Live => ({ ...live, slate: games, recentPlays }),
    StageChanged: ({ stage }): Live => ({ ...live, stage })
  })
}

const decodeLiveMessage = Schema.decodeUnknownEffect(LiveMessageJson)
