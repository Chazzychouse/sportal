import type { StageRejection } from "@sportal/domain/Stage"
import { Effect, Fiber, Stream } from "effect"
import type { HttpClientError } from "effect/http"
import { useEffect } from "react"
import { toast } from "sonner"
import { stageFailures } from "../hub/HubClient.ts"
import { runtime } from "../hub/HubRuntime.ts"

/** Shows each stage command that failed as a warning toast, saying why: the Hub refused it, or never got it. */
export function useRejectionToasts() {
  useEffect(() => {
    const fiber = runtime.runFork(
      stageFailures.pipe(
        Stream.runForEach((failure) => Effect.sync(() => toast.warning(failureText(failure))))
      )
    )
    return () => {
      runtime.runFork(Fiber.interrupt(fiber))
    }
  }, [])
}

function failureText(failure: StageRejection | HttpClientError.HttpClientError): string {
  if (failure._tag === "HttpClientError") return "The Hub did not get that. Is it running?"
  switch (failure.reason) {
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
