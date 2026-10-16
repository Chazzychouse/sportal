import type { GameList } from "@sportal/api/GamesQuery"
import type { ChannelAvailability } from "@sportal/domain/Channel"
import type { GameId } from "@sportal/domain/Game"
import { Option, Result, Schema, SchemaGetter } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Atom } from "effect/reactivity"
import * as Games from "../hub/Games.ts"
import { Screen, type ScreenCommand, type ScreenRejection } from "./Screen.ts"

/**
 * This Display's Screen. A screen command written to it is applied against where each of today's games can be
 * streamed; each command's outcome is published on `rejected`. Each answer today's list brings refreshes it, and it is
 * kept in this browser, so a reload shows it as it was, but for its clips.
 */
export const screen: Atom.Writable<Screen, ScreenCommand> = Atom.writable(
  (get) => {
    get.subscribe(
      Games.today,
      ({ value }) => {
        const availability = availabilityOf(value)
        const current = get.once(kept)
        const next = current.refresh((game) => Option.fromNullishOr(availability.get(game)))
        if (next !== current) get.set(kept, next)
      },
      { immediate: true }
    )
    return get(kept)
  },
  (ctx, command: ScreenCommand) => {
    const availability = availabilityOf(ctx.get(Games.today).value)
    const result = ctx.get(kept).apply(command, (game) => availability.get(game) ?? [])
    Result.match(result, {
      onSuccess: (next) => {
        ctx.set(kept, next)
        ctx.set(rejected, Option.none())
      },
      onFailure: (rejection) => ctx.set(rejected, Option.some(rejection))
    })
  }
).pipe(Atom.keepAlive)

/** Why the last screen command this Display was sent was refused; none when it was applied, or before any. */
export const rejected = Atom.make<Option.Option<ScreenRejection>>(Option.none()).pipe(Atom.keepAlive)

/** Each of today's games' availability, by its id; none before the first answer. */
function availabilityOf(
  list: Option.Option<GameList>
): ReadonlyMap<GameId, ReadonlyArray<ChannelAvailability>> {
  return new Map(
    Option.match(list, {
      onNone: () => [],
      onSome: ({ games }) => games.map(({ snapshot, availability }) => [snapshot.id, availability] as const)
    })
  )
}

// TODO(Chase): fix this once persistence layers are added
const kept = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: "sportal/screen",
  schema: Screen.pipe(
    Schema.decodeTo(Schema.toType(Screen), {
      decode: SchemaGetter.transform((restored) => restored.withoutClips()),
      encode: SchemaGetter.passthrough()
    })
  ),
  defaultValue: () => Screen.initial
}).pipe(Atom.keepAlive)
