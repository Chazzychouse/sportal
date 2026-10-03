import { Schema } from "effect"

export const StreamLocator = Schema.Union([Schema.TaggedStruct("WebView", { url: Schema.String })])
export type StreamLocator = typeof StreamLocator.Type
