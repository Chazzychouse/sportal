import { LiveMessageJson } from "@sportal/api/LiveMessage"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import type { Game } from "@sportal/domain/Game"
import { Effect, Schema } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import * as LiveStream from "./LiveStream.ts"

/** The EventSource the live stream opened, once a read of the atom has started it. */
export function opened(): Effect.Effect<FakeEventSource, never, AtomRegistry.AtomRegistry> {
  return Atom.get(LiveStream.live).pipe(Effect.andThen(eventSource))
}

function eventSource(): Effect.Effect<FakeEventSource> {
  return Effect.suspend(() => {
    const last = FakeEventSource.opened.at(-1)
    return last === undefined ? Effect.yieldNow.pipe(Effect.flatMap(eventSource)) : Effect.succeed(last)
  })
}

/** An EventSource a test drives by hand: it records each one opened, and the test calls its handlers. */
export class FakeEventSource {
  static opened: Array<FakeEventSource> = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false

  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeEventSource.opened.push(this)
  }

  close() {
    this.closed = true
  }
}

/** A slate message's `data`, as the Hub sends it. */
export function slateMessage(
  games: ReadonlyArray<{ game: Game; availability: ReadonlyArray<ChannelAvailability> }>
) {
  return encodeLiveMessage({ _tag: "SlateChanged", games })
}

const encodeLiveMessage = Schema.encodeSync(LiveMessageJson)
