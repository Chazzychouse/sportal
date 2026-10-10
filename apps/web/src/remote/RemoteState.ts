import type { DisplayId } from "@sportal/api/DisplayId"
import { RemoteMessage, RemoteMessageJson } from "@sportal/api/RemoteMessage"
import { Data, DateTime, Effect, Option, Schema, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Display, type DisplayInput } from "../display/Display.ts"
import { HubClient } from "../hub/HubClient.ts"
import * as LiveStream from "../hub/LiveStream.ts"
import * as ServerEvents from "../hub/ServerEvents.ts"
import { ServerEvent } from "../hub/ServerEvents.ts"
import { StripCard } from "../slate/StripCard.ts"
import { runtime } from "../WebRuntime.ts"
import { RemoteInput } from "./RemoteInput.ts"
import { RemoteReport } from "./RemoteReport.ts"

/** The Display as a Remote sees it: not heard from yet, offline, or as it last reported. */
export type Followed = Data.TaggedEnum<{
  Connecting: object
  Offline: object
  Reported: { readonly report: RemoteReport }
}>
export const Followed = Data.taggedEnum<Followed>()

/** The Display `id`, followed through the Hub; it reconnects after an error and starts again from `Connecting`. */
export const followed = Atom.family((id: DisplayId) =>
  Atom.make(ServerEvents.from(`/api/displays/${id}`).pipe(Stream.scanEffect(connecting, step))).pipe(
    Atom.map(AsyncResult.getOrElse(connecting)),
    Atom.keepAlive
  )
)

/** Sends one input to the Display `id`; a Display that is offline counts on `offline`. */
export const send = Atom.family((id: DisplayId) =>
  runtime
    .fn(
      (input: RemoteInput, get) =>
        Effect.gen(function* () {
          const hub = yield* HubClient
          const json = yield* encodeInput(input)

          yield* hub.send(id, json)
        }).pipe(
          Effect.catchTags({
            DisplayOffline: () => Effect.sync(() => get.registry.update(offline, (count) => count + 1)),
            HttpClientError: (error) => Effect.logWarning("Could not reach the Hub", error)
          })
        ),
      // Each input stands alone: a second tap must not cancel the first one's request.
      { concurrent: true }
    )
    .pipe(Atom.keepAlive)
)

/** How many inputs the Hub refused because the Display was offline; the view toasts on each. */
export const offline = Atom.make(0).pipe(Atom.keepAlive)

/**
 * This phone's own Display state for the Display `id` (the selected tile), applied against the reported Screen and
 * the live slate; its screen commands go to the Display as `Commanded`. Before a report, inputs do nothing.
 */
export const display = Atom.family((id: DisplayId) =>
  Atom.writable(
    (get) => get(kept(id)),
    (ctx, input: DisplayInput) => {
      const seen = ctx.get(followed(id))
      if (!Followed.$is("Reported")(seen)) return
      const { screen } = seen.report
      const live = ctx.get(LiveStream.live)
      const cards = StripCard.of(screen, live.slate, live.classifications)
      const step = ctx.get(kept(id)).apply(input, screen, cards)
      ctx.set(kept(id), step.display)
      for (const command of step.commands) ctx.set(send(id), { _tag: "Commanded", command })
    }
  ).pipe(Atom.keepAlive)
)

/**
 * The reported prompt's game and `since`; it changes only when the Display shows another prompt, and keeps its last
 * value while the Display is not reporting, so a reconnection does not chime the same prompt again.
 */
export const promptKey = Atom.family((id: DisplayId) =>
  Atom.make((get): string | undefined => {
    const seen = get(followed(id))
    if (!Followed.$is("Reported")(seen)) return Option.getOrUndefined(get.self<string | undefined>())
    return Option.match(seen.report.prompt, {
      onNone: () => undefined,
      onSome: ({ game, since }) => `${game} ${DateTime.formatIso(since)}`
    })
  })
)

function connecting(): Followed {
  return Followed.Connecting()
}

const kept = Atom.family((_: DisplayId) => Atom.make(Display.initial).pipe(Atom.keepAlive))

/** What `current` becomes on `event`. */
function step(current: Followed, event: ServerEvent): Effect.Effect<Followed> {
  return ServerEvent.$match(event, {
    Opened: () => Effect.succeed(current),
    Errored: () => Effect.succeed(Followed.Connecting()),
    Received: ({ data }) =>
      decodeMessage(data).pipe(
        Effect.flatMap((message) =>
          RemoteMessage.match(message, {
            Offline: () => Effect.succeed<Followed>(Followed.Offline()),
            Reported: ({ report }) =>
              Effect.map(decodeReport(report), (decoded): Followed => Followed.Reported({ report: decoded }))
          })
        ),
        Effect.catchTag("SchemaError", (error) =>
          Effect.logWarning("A report from the Display did not decode", error).pipe(
            Effect.as(Followed.Offline())
          )
        )
      )
  })
}

const encodeInput = Schema.encodeEffect(RemoteInput)

const decodeMessage = Schema.decodeUnknownEffect(RemoteMessageJson)

const decodeReport = Schema.decodeUnknownEffect(RemoteReport)
