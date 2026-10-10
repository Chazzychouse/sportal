import { Hotkey } from "@sportal/api/Hotkey"
import { Schema } from "effect"
import { ScreenCommand } from "../screen/Screen.ts"

/**
 * What a Remote sends its Display: a screen command, which the Display applies as yours, or a hotkey, which it routes
 * as if pressed on it.
 */
export const RemoteInput = Schema.TaggedUnion({
  Commanded: { command: ScreenCommand },
  Pressed: { hotkey: Hotkey }
})
export type RemoteInput = typeof RemoteInput.Type

/** A Remote input as the Hub relays it: a JSON string. */
export const RemoteInputJson = Schema.fromJsonString(RemoteInput)
