import type { StageRejection } from "@sportal/domain/Stage"
import { Effect, Fiber, Stream } from "effect"
import { useEffect } from "react"
import { toast } from "sonner"
import { stageRejections } from "../hub/HubClient.ts"
import { runtime } from "../hub/HubRuntime.ts"

/** Shows each stage command the Hub refuses as a warning toast, saying why. */
export function useRejectionToasts() {
  useEffect(() => {
    const fiber = runtime.runFork(
      stageRejections.pipe(
        Stream.runForEach((rejection) => Effect.sync(() => toast.warning(rejectionText(rejection.reason))))
      )
    )
    return () => {
      runtime.runFork(Fiber.interrupt(fiber))
    }
  }, [])
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
