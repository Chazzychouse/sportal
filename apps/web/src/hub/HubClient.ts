import { SportalApi } from "@sportal/api/SportalApi"
import type { Network } from "@sportal/domain/Game"
import type { StageCommand, StageRejection } from "@sportal/domain/Stage"
import { Cause, Context, Effect, Layer, Option, Predicate, PubSub, Stream } from "effect"
import { HttpApiClient } from "effect/http-api"

/** This client's way to the Hub's HTTP API, and the stage commands the Hub refused, to whoever is listening. */
export class HubClient extends Context.Service<
  HubClient,
  { api: HttpApiClient.ForApi<typeof SportalApi>; rejections: PubSub.PubSub<StageRejection> }
>()("sportal/web/HubClient") {
  static readonly layer = Layer.effect(
    HubClient,
    Effect.gen(function* () {
      return {
        api: yield* HttpApiClient.make(SportalApi),
        rejections: yield* PubSub.unbounded<StageRejection>()
      }
    })
  )
}

/**
 * Sends a stage command. The resulting stage arrives on the live stream, not from this call; a command the Hub
 * refuses arrives on `stageRejections`.
 */
export function dispatch(command: StageCommand) {
  return HubClient.use((hub) =>
    hub.api.stage
      .dispatch({ payload: { command } })
      .pipe(Effect.catchTag("StageRejection", (rejection) => PubSub.publish(hub.rejections, rejection)))
  )
}

/** Each stage command the Hub refuses, from when the stream starts. */
export const stageRejections = Stream.unwrap(
  Effect.gen(function* () {
    return Stream.fromPubSub((yield* HubClient).rejections)
  })
)

/** Passes a guide the shell read to the Hub. The tiles it changes arrive on the live stream. */
export function sendGuide(guide: string) {
  return HubClient.use((hub) => hub.api.guide.read({ payload: { guide } }))
}

/**
 * Tells the Hub the channel the user picked for `network`. Like the other channel commands, it succeeds with
 * the message to show the user if the Hub did not take it; the Stage change arrives on the live stream.
 */
export function learnChannel(network: Network, url: string) {
  return outcome(HubClient.use((hub) => hub.api.channels.learn({ payload: { network, url } })))
}

export function markNotCarried(network: Network) {
  return outcome(HubClient.use((hub) => hub.api.channels.notCarried({ payload: { network } })))
}

export function forgetChannel(network: Network) {
  return outcome(HubClient.use((hub) => hub.api.channels.forget({ payload: { network } })))
}

/**
 * The addresses a Remote on the home network can reach the Hub's machine at, or none when the Hub could not be
 * asked — not running, or older than this UI.
 */
export const hostAddresses = HubClient.use((hub) => hub.api.host.addresses()).pipe(
  Effect.map(Option.some),
  Effect.orElseSucceed(() => Option.none())
)

function outcome(command: Effect.Effect<void, unknown, HubClient>) {
  return command.pipe(
    // Any failure, expected or not, becomes a notice on the tile; only a refused channel gets its own words.
    Effect.matchCause({
      onSuccess: () => Option.none(),
      onFailure: (cause) =>
        Option.some(
          Option.exists(Cause.findErrorOption(cause), (error) =>
            Predicate.isTagged(error, "ChannelUrlRefused")
          )
            ? "That is not a live channel. Pick one from the live guide."
            : "The Hub did not take that. Try again."
        )
    })
  )
}
