import type { DisplayId } from "@sportal/api/DisplayId"
import { RemoteMessage } from "@sportal/api/RemoteMessage"
import { Data, Effect, Schema, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Display, type DisplayInput } from "../display/Display.ts"
import * as GuideShelves from "../guide/GuideShelves.ts"
import { HubClient } from "../hub/HubClient.ts"
import { Connection, HubSocket } from "../hub/HubSocket.ts"
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

/**
 * The Display `id`, followed through the Hub: connecting until the Hub first answers, and again while the socket is
 * lost; it follows again when the socket connects.
 */
export const followed = Atom.family((id: DisplayId) => {
  const seen = Stream.unwrap(
    Effect.gen(function* () {
      const socket = yield* HubSocket
      const messages = socket
        .live((client) => client.follow({ display: id }))
        .pipe(Stream.mapEffect(followedOf))
      const lost = socket.connection.pipe(
        Stream.filter((connection) => !Connection.$is("Connected")(connection)),
        Stream.map(connecting)
      )

      return Stream.merge(lost, messages)
    })
  )
  return runtime.atom(seen).pipe(Atom.map(AsyncResult.getOrElse(connecting)), Atom.keepAlive)
})

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
            RpcClientError: (error) => Effect.logWarning("Could not reach the Hub", error)
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
 * This phone's own Display state for the Display `id` (the selected tile), applied against the reported Screen; its
 * screen commands go to the Display as `Commanded`. Before a report, inputs do nothing.
 */
export const display = Atom.family((id: DisplayId) =>
  Atom.writable(
    (get) => get(kept(id)),
    (ctx, input: DisplayInput) => {
      const seen = ctx.get(followed(id))
      if (!Followed.$is("Reported")(seen)) return
      // A Remote shows no guide: its Display state only selects tiles.
      const step = ctx.get(kept(id)).apply(input, seen.report.screen, noGuide)
      ctx.set(kept(id), step.display)
      for (const command of step.commands) ctx.set(send(id), { _tag: "Commanded", command })
    }
  ).pipe(Atom.keepAlive)
)

function connecting(): Followed {
  return Followed.Connecting()
}

const kept = Atom.family((_: DisplayId) => Atom.make(Display.initial).pipe(Atom.keepAlive))

const noGuide = GuideShelves.guideShelves([], [])

/** What `message` says of the Display; a report that does not decode reads as offline. */
function followedOf(message: RemoteMessage): Effect.Effect<Followed> {
  return RemoteMessage.match(message, {
    Offline: () => Effect.succeed<Followed>(Followed.Offline()),
    Reported: ({ report }) =>
      decodeReport(report).pipe(
        Effect.map((decoded): Followed => Followed.Reported({ report: decoded })),
        Effect.catchTag("SchemaError", (error) =>
          Effect.logWarning("A report from the Display did not decode", error).pipe(
            Effect.as(Followed.Offline())
          )
        )
      )
  })
}

const encodeInput = Schema.encodeEffect(RemoteInput)

const decodeReport = Schema.decodeUnknownEffect(RemoteReport)
