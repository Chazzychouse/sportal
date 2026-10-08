import type { ScreenRejection } from "@sportal/domain/Screen"
import { Effect, Fiber, Stream } from "effect"
import { HttpClientError } from "effect/http"
import { useEffect } from "react"
import { toast } from "sonner"
import { screenFailures } from "../hub/HubClient.ts"
import { runtime } from "../hub/HubRuntime.ts"

/** Shows each screen command that failed as a warning toast, saying why: the Hub refused it, or never got it. */
export function useScreenFailureToasts() {
  useEffect(() => {
    const fiber = runtime.runFork(
      screenFailures.pipe(
        Stream.runForEach((failure) => Effect.sync(() => toast.warning(failureText(failure))))
      )
    )
    return () => {
      runtime.runFork(Fiber.interrupt(fiber))
    }
  }, [])
}

function failureText(failure: ScreenRejection | HttpClientError.HttpClientError): string {
  return HttpClientError.isHttpClientError(failure)
    ? "The Hub did not get that. Is it running?"
    : rejectionText[failure.reason]
}

const rejectionText: Record<ScreenRejection["reason"], string> = {
  "no-such-tile": "There is no tile there.",
  "empty-tile": "That tile is empty.",
  "offscreen-tile": "That game is on the bench. Swap it in first.",
  "split-out-of-range": "Every tile needs some room."
}
