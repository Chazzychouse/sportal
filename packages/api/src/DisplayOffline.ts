import { Schema } from "effect"

/** No Display with that id is connected to the Hub. */
export class DisplayOffline extends Schema.TaggedError<DisplayOffline>()("DisplayOffline", {}) {}
