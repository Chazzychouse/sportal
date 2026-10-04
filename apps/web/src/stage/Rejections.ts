import type { StageRejection } from "@sportal/domain/Stage"
import { useEffect } from "react"
import { toast } from "sonner"
import { onStageRejected } from "../hub/HubClient.ts"

/** Shows each stage command the Hub refuses as a warning toast, saying why. */
export function useRejectionToasts() {
  useEffect(() => onStageRejected((reason) => toast.warning(rejectionText(reason))), [])
}

function rejectionText(reason: StageRejection["reason"]): string {
  switch (reason) {
    case "no-such-tile":
      return "There is no tile there."
    case "empty-tile":
      return "That tile is empty."
    case "offstage-tile":
      return "That game is on the bench. Swap it in first."
    case "split-out-of-range":
      return "Every tile needs some room."
  }
}
