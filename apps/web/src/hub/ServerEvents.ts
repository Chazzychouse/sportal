import { Cause, Data, Effect, Queue, Schedule, Schema, Stream } from "effect"

/** What a server-sent event stream reported: it opened, it errored (it will open again), or a message. */
export type ServerEvent = Data.TaggedEnum<{
  Opened: object
  Errored: object
  Received: { readonly data: unknown }
}>
export const ServerEvent = Data.taggedEnum<ServerEvent>()

/**
 * The server-sent events at `url`, through an `EventSource` opened when the stream starts and closed when it ends, so
 * the stream does not end. The browser retries a dropped connection by itself; one it fails for good, as it does a 502
 * from the dev proxy while the Hub restarts, is closed and opened again after half a second, then twice as long each
 * time, up to 5 seconds, until it opens.
 */
export function from(url: string): Stream.Stream<ServerEvent> {
  return connection(url).pipe(Stream.retry(reopening), Stream.orDie)
}

/**
 * One `EventSource` at `url`, ending in `SourceClosed` when the browser fails it for good. A source that never opened
 * reports no `Errored` for that: nothing was up, and the backoff resets on the first event after a reopening.
 */
function connection(url: string): Stream.Stream<ServerEvent, SourceClosed> {
  return Stream.callback<ServerEvent, SourceClosed>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const source = new EventSource(url)
        let opened = false
        source.onopen = () => {
          opened = true
          Queue.offerUnsafe(queue, ServerEvent.Opened())
        }
        source.onerror = () => {
          const closed = source.readyState === EventSource.CLOSED
          if (opened || !closed) Queue.offerUnsafe(queue, ServerEvent.Errored())
          if (closed) Queue.failCauseUnsafe(queue, Cause.fail(new SourceClosed()))
        }
        source.onmessage = (event) => Queue.offerUnsafe(queue, ServerEvent.Received({ data: event.data }))
        return source
      }),
      (source) => Effect.sync(() => source.close())
    )
  )
}

const reopening = Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("5 seconds")])

class SourceClosed extends Schema.TaggedError<SourceClosed>()("SourceClosed", {}) {}
