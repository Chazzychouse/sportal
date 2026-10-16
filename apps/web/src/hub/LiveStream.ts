import { Effect, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { runtime } from "../WebRuntime.ts"
import { Connection, type HubApiClient, HubSocket } from "./HubSocket.ts"

/**
 * The live query `query` asks over the Hub socket, its elements folded by `fold` from `initial`, and the socket's
 * connection. It is asked when the atom is first read, ended on the Hub when nothing reads it, and asked again each
 * time the socket connects; the Hub's first answer to each asking is its current one.
 */
export function of<A, E, S>(
  query: (client: HubApiClient) => Stream.Stream<A, E>,
  initial: S,
  fold: (state: S, element: A) => S
): Atom.Atom<Live<S>> {
  const start: Live<S> = { connection: Connection.Connecting(), value: initial }
  const live = Effect.gen(function* () {
    const socket = yield* HubSocket
    // Stream.scan sends its initial state only with the first element, and the connection must show before it.
    const folded = Stream.mapAccum(
      socket.live(query),
      () => initial,
      (state, element) => {
        const next = fold(state, element)
        return [next, [next]]
      }
    )
    const values = Stream.concat(Stream.succeed(initial), folded)

    return Stream.zipLatestWith(
      socket.connection,
      values,
      (connection, value): Live<S> => ({ connection, value })
    )
  })
  return runtime.atom(Stream.unwrap(live)).pipe(Atom.map(AsyncResult.getOrElse(() => start)))
}

/** A live query's folded elements, and whether the Hub socket is up. */
export interface Live<S> {
  readonly connection: Connection
  readonly value: S
}
