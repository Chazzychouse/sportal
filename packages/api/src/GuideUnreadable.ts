import { Schema } from "effect"

/** A guide response the source could not read. */
export class GuideUnreadable extends Schema.TaggedError<GuideUnreadable>()("GuideUnreadable", {}) {}
