import { Data, Effect, Queue, Stream } from "effect"

/** What a server-sent event stream reported: it opened, it errored (the browser retries by itself), or a message. */
export type ServerEvent = Data.TaggedEnum<{
  Opened: object
  Errored: object
  Received: { readonly data: unknown }
}>
export const ServerEvent = Data.taggedEnum<ServerEvent>()

/**
 * The server-sent events at `url`, through an `EventSource` opened when the stream starts and closed when it ends. The
 * browser reconnects it by itself after an error, so the stream does not end.
 */
export function from(url: string): Stream.Stream<ServerEvent> {
  return Stream.callback<ServerEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const source = new EventSource(url)
        source.onopen = () => Queue.offerUnsafe(queue, ServerEvent.Opened())
        source.onerror = () => Queue.offerUnsafe(queue, ServerEvent.Errored())
        source.onmessage = (event) => Queue.offerUnsafe(queue, ServerEvent.Received({ data: event.data }))
        return source
      }),
      (source) => Effect.sync(() => source.close())
    )
  )
}
