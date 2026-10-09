import { useAtomSubscribe } from "@effect/atom-react"
import { Option } from "effect"
import { toast } from "sonner"
import * as DisplayScreen from "./DisplayScreen.ts"
import type { ScreenRejection } from "./Screen.ts"

/** Shows each screen command this Display refused as a warning toast, saying why. */
export function useScreenRejectionToasts() {
  useAtomSubscribe(DisplayScreen.rejected, (rejected) =>
    Option.map(rejected, ({ reason }) => toast.warning(rejectionText[reason]))
  )
}

const rejectionText: Record<ScreenRejection["reason"], string> = {
  "no-such-tile": "There is no tile there.",
  "empty-tile": "That tile is empty.",
  "offscreen-tile": "That game is on the bench. Swap it in first.",
  "split-out-of-range": "Every tile needs some room."
}
