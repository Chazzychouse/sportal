import type { DisplayId } from "@sportal/api/DisplayId"
import { DisplayOffline } from "@sportal/api/DisplayOffline"
import { RemoteMessage } from "@sportal/api/RemoteMessage"
import { Context, Effect, HashMap, Layer, Option, Queue, Schema, Stream, SubscriptionRef } from "effect"

/**
 * The Hub's relay between each connected Display and its Remotes: the Display's latest report and the inputs waiting
 * for it, in memory, by Display id. It never reads a report or an input. A Display is connected while its input
 * stream runs; when it ends, the Display and its report are forgotten.
 */
export class Displays extends Context.Service<
  Displays,
  {
    /** Registers the Display now; the stream gives each input sent to it, and its end forgets the Display. */
    readonly connect: (id: DisplayId) => Effect.Effect<Stream.Stream<Schema.Json>>
    readonly report: (id: DisplayId, report: Schema.Json) => Effect.Effect<void, DisplayOffline>
    /** The Display as a Remote sees it: now, then each change. */
    readonly follow: (id: DisplayId) => Stream.Stream<RemoteMessage>
    readonly send: (id: DisplayId, input: Schema.Json) => Effect.Effect<void, DisplayOffline>
  }
>()("sportal/hub/Displays") {
  static readonly layer: Layer.Layer<Displays> = Layer.effect(
    Displays,
    Effect.gen(function* () {
      const connected = yield* SubscriptionRef.make(HashMap.empty<DisplayId, Connected>())

      const connect = Effect.fn("Displays.connect")(function* (id: DisplayId) {
        const inputs = yield* Queue.unbounded<Schema.Json>()
        yield* SubscriptionRef.update(connected, HashMap.set(id, { inputs, report: Option.none() }))

        // A second connection under the same id replaced this one's entry; its end must not remove that one.
        const forget = SubscriptionRef.update(connected, (all) =>
          Option.exists(HashMap.get(all, id), (entry) => entry.inputs === inputs)
            ? HashMap.remove(all, id)
            : all
        )
        return Stream.fromQueue(inputs).pipe(Stream.ensuring(forget))
      })

      const report = Effect.fn("Displays.report")(function* (id: DisplayId, json: Schema.Json) {
        const found = yield* SubscriptionRef.modify(connected, (all) => {
          const entry = HashMap.get(all, id)
          if (Option.isNone(entry)) return [false, all] as const
          return [true, HashMap.set(all, id, { ...entry.value, report: Option.some(json) })] as const
        })
        if (!found) return yield* new DisplayOffline()
      })

      const follow = (id: DisplayId) =>
        SubscriptionRef.changes(connected).pipe(
          Stream.map(
            (all): RemoteMessage =>
              Option.match(
                Option.flatMap(HashMap.get(all, id), (entry) => entry.report),
                {
                  onNone: () => ({ _tag: "Offline" }),
                  onSome: (json) => ({ _tag: "Reported", report: json })
                }
              )
          ),
          Stream.changesWith(sameMessage)
        )

      const send = Effect.fn("Displays.send")(function* (id: DisplayId, input: Schema.Json) {
        const all = yield* SubscriptionRef.get(connected)
        const entry = HashMap.get(all, id)
        if (Option.isNone(entry)) return yield* new DisplayOffline()

        yield* Queue.offer(entry.value.inputs, input)
      })

      return Displays.of({ connect, report, follow, send })
    })
  )
}

/** A connected Display: the inputs waiting for it, and its latest report. */
interface Connected {
  readonly inputs: Queue.Queue<Schema.Json>
  readonly report: Option.Option<Schema.Json>
}

const sameMessage = Schema.toEquivalence(RemoteMessage)
