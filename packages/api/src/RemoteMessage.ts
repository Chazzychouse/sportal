import { Schema } from "effect"

/**
 * One update the Hub pushes to a Remote about its Display: the Display's latest report, which the Hub passes on
 * without reading, or that the Display is offline (not connected, or not reported yet).
 */
export const RemoteMessage = Schema.TaggedUnion({
  Reported: { report: Schema.Json },
  Offline: {}
})
export type RemoteMessage = typeof RemoteMessage.Type

/** A Remote message as one line of JSON, as the Remote stream sends it. */
export const RemoteMessageJson = Schema.fromJsonString(RemoteMessage)
