import { Cause, Effect, Exit, Pull } from "effect"

export function isStopping(exit: Exit.Exit<unknown, unknown>): boolean {
  return (
    Exit.isFailure(exit) &&
    exit.cause.reasons.length > 0 &&
    exit.cause.reasons.every((reason) => Cause.isInterruptReason(reason) || Pull.isDoneFailure(reason))
  )
}

export function loggedUnlessStopping(
  message: string,
  ended: string
): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
  return (self) =>
    Effect.onExitIf(
      self,
      (exit) => !isStopping(exit),
      (exit) => Effect.logError(message, Exit.isFailure(exit) ? exit.cause : ended)
    )
}
