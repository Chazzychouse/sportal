import { Schema } from "effect"

/** A Display's own id, made once in its browser; a Remote names its Display by it. */
export const DisplayId = Schema.String.pipe(Schema.brand("DisplayId"))
export type DisplayId = typeof DisplayId.Type
