import { DisplayId } from "@sportal/api/DisplayId"
import { DisplayMessage } from "@sportal/api/DisplayMessage"
import { Effect, Schema, Stream, SubscriptionRef } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Atom } from "effect/reactivity"
import * as DisplayState from "../display/DisplayState.ts"
import { HubClient } from "../hub/HubClient.ts"
import { Connection, HubSocket } from "../hub/HubSocket.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { logDefect, runtime } from "../WebRuntime.ts"
import { RemoteInput } from "./RemoteInput.ts"
import { RemoteReport } from "./RemoteReport.ts"

/**
 * This Display's link to its Remotes: once the Hub has registered its input stream it reports, then reports each
 * change, until the socket is lost; and it applies each input a Remote sends, a screen command to the Screen and a
 * hotkey as if pressed here. Mounted once, by the Display.
 */
export const link = runtime.atom((get) =>
  Effect.gen(function* () {
    const hub = yield* HubClient
    const socket = yield* HubSocket
    const id = get(displayId)
    const registered = yield* SubscriptionRef.make(false)

    const inputs = socket
      .live((client) => client.inputs({ display: id }))
      .pipe(
        Stream.runForEach((message) =>
          DisplayMessage.match(message, {
            Registered: () => SubscriptionRef.set(registered, true),
            Sent: ({ input }) => applied(get, input)
          })
        )
      )
    const lost = socket.connection.pipe(
      Stream.filter((connection) => !Connection.$is("Connected")(connection)),
      Stream.runForEach(() => SubscriptionRef.set(registered, false))
    )
    const reports = SubscriptionRef.changes(registered).pipe(
      Stream.switchMap((isRegistered) =>
        isRegistered ? get.stream(report).pipe(Stream.changesWith(sameReport)) : Stream.empty
      ),
      Stream.runForEach((each) => reported(hub, id, each))
    )
    yield* Effect.all([inputs, lost, reports], { concurrency: "unbounded", discard: true })
  }).pipe(logDefect("The Remote link"))
)

/** What this Display tells its Remotes now. */
const report: Atom.Atom<RemoteReport> = Atom.make(
  (get) =>
    new RemoteReport({
      screen: get(DisplayScreen.screen)
    })
)

/** This Display's id, 16 random bytes as hex, made once and kept in this browser. */
export const displayId: Atom.Writable<DisplayId> = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: "sportal/display-id",
  schema: DisplayId,
  defaultValue: () => {
    // Not crypto.randomUUID: it exists only in a secure context, and a Display opened at a LAN address is not one.
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
    return DisplayId.make(hex)
  }
}).pipe(Atom.keepAlive)

/** Applies one input a Remote sent; one that does not decode is logged and dropped. */
function applied(get: Atom.FnContext, data: unknown) {
  return decodeInput(data).pipe(
    Effect.map((input) =>
      RemoteInput.match(input, {
        Commanded: ({ command }) => get.set(DisplayScreen.screen, command),
        Pressed: ({ hotkey }) => get.set(DisplayState.pressed, hotkey)
      })
    ),
    Effect.catchTag("SchemaError", (error) =>
      Effect.logWarning("Skipped a Remote input that did not decode", error)
    )
  )
}

/** Sends one report to the Hub; a refusal or a lost Hub is logged, and the next change or reopening tries again. */
function reported(hub: HubClient["Service"], id: DisplayId, each: RemoteReport) {
  return encodeReport(each).pipe(
    Effect.flatMap((json) => hub.report(id, json)),
    Effect.catchTags({
      DisplayOffline: () => Effect.logWarning("The Hub has not registered this Display"),
      RpcClientError: (error) => Effect.logWarning("Could not report to the Hub", error)
    })
  )
}

const sameReport = Schema.toEquivalence(RemoteReport)

const decodeInput = Schema.decodeUnknownEffect(RemoteInput)

const encodeReport = Schema.encodeEffect(RemoteReport)
