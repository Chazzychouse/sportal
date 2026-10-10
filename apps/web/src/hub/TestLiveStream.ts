import { LiveMessageJson } from "@sportal/api/LiveMessage"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import type { Game } from "@sportal/domain/Game"
import { Slate } from "@sportal/domain/Slate"
import { Effect, Record, Schema } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import * as LiveStream from "./LiveStream.ts"

/** The EventSource the live stream opened, once a read of the atom has started it. */
export const opened: Effect.Effect<FakeEventSource, never, AtomRegistry.AtomRegistry> = Atom.get(
  LiveStream.live
).pipe(Effect.andThen(eventSource))

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

/** A slate message's `data`, as the Hub sends it: the slate of `entries`' games, and each one's availability. */
export function slateMessage(
  entries: ReadonlyArray<{ game: Game; availability: ReadonlyArray<ChannelAvailability> }>
) {
  const slate = new Slate({ games: entries.map(({ game }) => game) })
  const availability = Record.fromEntries(
    entries.map(({ game, availability }) => [game.snapshot.id, availability] as const)
  )
  return encodeLiveMessage({ _tag: "SlateChanged", slate, availability })
}

const encodeLiveMessage = Schema.encodeSync(LiveMessageJson)
