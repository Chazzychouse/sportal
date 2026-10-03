import { type LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import type { GameSnapshot } from "@sportal/domain/Game"
import * as Stage from "@sportal/domain/Stage"
import { Schema } from "effect"
import { useSyncExternalStore } from "react"

/** Everything the Hub has told this client, kept current by the live stream at /api/live. */
export function useLive() {
  return useSyncExternalStore(subscribe, () => state)
}

export const disconnected = {
  slate: [] as ReadonlyArray<GameSnapshot>,
  stage: Stage.initial,
  connected: false
}

export function reduce(live: typeof disconnected, message: LiveMessage): typeof disconnected {
  switch (message._tag) {
    case "SlateChanged":
      return { ...live, slate: message.slate }
    case "StageChanged":
      return { ...live, stage: message.stage }
  }
}

let state = disconnected
let events: EventSource | undefined
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (events === undefined) events = connect()
  return () => {
    listeners.delete(listener)
  }
}

// EventSource reconnects by itself, and the Hub replays the current slate and stage on every connection.
function connect() {
  const source = new EventSource("/api/live")
  source.onopen = () => publish({ ...state, connected: true })
  source.onerror = () => publish({ ...state, connected: false })
  source.onmessage = (event) => publish(reduce(state, decodeLiveMessage(event.data)))
  return source
}

function publish(next: typeof disconnected) {
  state = next
  for (const listener of listeners) listener()
}

const decodeLiveMessage = Schema.decodeUnknownSync(LiveMessageJson)
