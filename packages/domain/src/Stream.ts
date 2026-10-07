import { Schema } from "effect"

export const StreamLocator = Schema.TaggedUnion({ WebView: { url: Schema.String } })
export type StreamLocator = typeof StreamLocator.Type
