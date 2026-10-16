import { Schema } from "effect"

/**
 * One update the Hub pushes to a Display on its input stream: that the Hub has registered it (`Registered`, always
 * first), so its Remotes reach it from now on, then each input a Remote sent (`Sent`), passed on unread.
 */
export const DisplayMessage = Schema.TaggedUnion({
  Registered: {},
  Sent: { input: Schema.Json }
})
export type DisplayMessage = typeof DisplayMessage.Type
