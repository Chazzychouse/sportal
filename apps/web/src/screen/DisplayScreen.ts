import { Option, Result } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Atom } from "effect/reactivity"
import * as LiveStream from "../hub/LiveStream.ts"
import { Screen, type ScreenCommand, type ScreenRejection } from "./Screen.ts"

/**
 * This Display's Screen. A screen command written to it is applied against where each game on the live slate can be
 * streamed; one refused is published on `rejected` instead. Each slate the live stream brings refreshes it, and it is
 * kept in this browser, so a reload shows it as it was.
 */
export const screen: Atom.Writable<Screen, ScreenCommand> = Atom.writable(
  (get) => {
    get.subscribe(
      LiveStream.live,
      ({ availability }) => {
        const current = get.once(kept)
        const next = current.refresh((game) => Option.fromNullishOr(availability[game]))
        if (next !== current) get.set(kept, next)
      },
      { immediate: true }
    )
    return get(kept)
  },
  (ctx, command: ScreenCommand) => {
    const { availability } = ctx.get(LiveStream.live)
    const result = ctx.get(kept).apply(command, (game) => availability[game] ?? [])
    Result.match(result, {
      onSuccess: (next) => ctx.set(kept, next),
      onFailure: (rejection) => ctx.set(rejected, Option.some(rejection))
    })
  }
).pipe(Atom.keepAlive)

/** The last screen command this Display refused, and why; none until one is. */
export const rejected = Atom.make<Option.Option<ScreenRejection>>(Option.none()).pipe(Atom.keepAlive)

// TODO(Chase): fix this once persistence layers are added
const kept = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: "sportal/screen",
  schema: Screen,
  defaultValue: () => Screen.initial
}).pipe(Atom.keepAlive)
