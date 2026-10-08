import type { StageRejection } from "@sportal/domain/Stage"
import { Effect, Fiber, Stream } from "effect"
import { HttpClientError } from "effect/http"
import { useEffect } from "react"
import { toast } from "sonner"
import { stageFailures } from "../hub/HubClient.ts"
import { runtime } from "../hub/HubRuntime.ts"

/** Shows each stage command that failed as a warning toast, saying why: the Hub refused it, or never got it. */
export function useStageFailureToasts() {
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
  return HttpClientError.isHttpClientError(failure)
    ? "The Hub did not get that. Is it running?"
    : rejectionText[failure.reason]
}

const rejectionText: Record<StageRejection["reason"], string> = {
  "no-such-tile": "There is no tile there.",
  "empty-tile": "That tile is empty.",
  "offstage-tile": "That game is on the bench. Swap it in first.",
  "split-out-of-range": "Every tile needs some room."
}
