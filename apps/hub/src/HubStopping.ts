import { Cause, Effect, Exit, Pull } from "effect"

/**
 * Whether a task that should run until the Hub stops ended because the Hub is stopping: it was interrupted, or a stream
 * it read over a `PubSub` (the feed log's frames, the fold's changes) failed with the end a subscription gives when it is
 * shut down as the Hub's scope closes, and nothing else went wrong beside them.
 */
export function isStopping(exit: Exit.Exit<unknown, unknown>): boolean {
  return (
    Exit.isFailure(exit) &&
    exit.cause.reasons.length > 0 &&
    exit.cause.reasons.every((reason) => Cause.isInterruptReason(reason) || Pull.isDoneFailure(reason))
  )
}

/**
 * Logs at Error that a task which should run until the Hub stops has ended, with its failure or else `ended`, unless
 * the Hub is stopping.
 */
export function loggedUnlessStopping(message: string, ended: string) {
  return Effect.onExitIf(
    (exit: Exit.Exit<unknown, unknown>) => !isStopping(exit),
    (exit) => Effect.logError(message, Exit.isFailure(exit) ? exit.cause : ended)
  )
}
