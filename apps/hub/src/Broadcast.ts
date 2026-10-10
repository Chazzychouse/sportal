import { LiveMessage, type SlateChanged } from "@sportal/api/LiveMessage"
import { Context, DateTime, Effect, Layer, Option, Record, Schema, Sink, Stream } from "effect"
import { Director } from "./Director.ts"
import { Source } from "./source/Source.ts"

export class Broadcast extends Context.Service<
  Broadcast,
  {
    readonly messages: Stream.Stream<SlateChanged>
  }
>()("sportal/hub/Broadcast") {
  static readonly layer: Layer.Layer<Broadcast, never, Director | Source> = Layer.effect(
    Broadcast,
    Effect.gen(function* () {
      const director = yield* Director
      const source = yield* Source

      const messages = yield* Stream.zipLatest(settled(director.slate), Stream.tick("30 seconds")).pipe(
        Stream.mapEffect(([slate]) =>
          Effect.gen(function* () {
            const availabilityOf = yield* source.availability
            const now = yield* DateTime.now

            const availability = Record.fromEntries(
              slate.games.map(({ snapshot }) => [snapshot.id, availabilityOf(snapshot, now)] as const)
            )
            return { _tag: "SlateChanged", slate: slate.recent(), availability } satisfies SlateChanged
          })
        ),
        Stream.changesWith(samePublished),
        Stream.share({ capacity: "unbounded", replay: 1 })
      )

      return { messages }
    })
  )
}

function settled<A>(changes: Stream.Stream<A>): Stream.Stream<A> {
  return Stream.unwrap(
    Effect.map(Stream.peel(changes, Sink.head()), ([current, rest]) =>
      Stream.concat(Stream.fromIterable(Option.toArray(current)), rest.pipe(Stream.debounce("250 millis")))
    )
  )
}

const samePublished = Schema.toEquivalence(LiveMessage.cases.SlateChanged)
