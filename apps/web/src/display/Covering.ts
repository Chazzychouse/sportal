import type { TileBounds } from "@sportal/api/ShellBridge"
import type { GameId } from "@sportal/domain/Game"
import { Effect, Scheduler, Stream } from "effect"
import { Atom } from "effect/reactivity"
import * as TilePlacements from "../screen/TilePlacements.ts"
import * as TileRects from "../screen/TileRects.ts"
import { Shell } from "../shell/Shell.ts"
import { runtime } from "../WebRuntime.ts"

/** Each open overlay's rectangle in the window, by the overlay. */
export const overlays: Atom.Writable<ReadonlyMap<string, TileBounds>> = Atom.make<
  ReadonlyMap<string, TileBounds>
>(new Map()).pipe(Atom.keepAlive)

/**
 * Where overlays meet native video. Provider views draw above the web UI, so an overlay over a video would be hidden
 * behind it: the shell hides exactly the videos an open overlay covers, until it closes. Nothing is told until
 * something is covered. Mounted once, by the Display.
 */
export const sync = runtime.atom((get) =>
  Effect.gen(function* () {
    const shell = yield* Shell

    yield* get.stream(hidden).pipe(
      Stream.mapAccum(
        (): ReadonlyArray<GameId> => [],
        (last, next) => (sameGames(last, next) ? [last, []] : [next, [next]])
      ),
      Stream.runForEach(shell.setHidden)
    )
  }).pipe(
    // As in the tile sync: on microtasks, not React's low-priority callback, so the shell hides before paint.
    Effect.provideService(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"))
  )
)

const hidden = Atom.make((get) =>
  TileRects.coveredGames([...get(overlays).values()], get(TilePlacements.placements))
)

function sameGames(a: ReadonlyArray<GameId>, b: ReadonlyArray<GameId>): boolean {
  return a.length === b.length && a.every((game, index) => game === b[index])
}
