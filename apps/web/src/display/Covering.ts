import type { TileBounds } from "@sportal/api/ShellBridge"
import type { TileKey } from "@sportal/api/TileKey"
import { Effect, Stream } from "effect"
import { Atom } from "effect/reactivity"
import * as TilePlacements from "../screen/TilePlacements.ts"
import * as TileRects from "../screen/TileRects.ts"
import { Shell } from "../shell/Shell.ts"
import { beforePaint, logDefect, runtime } from "../WebRuntime.ts"

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
        (): ReadonlyArray<TileKey> => [],
        (last, next) => (sameKeys(last, next) ? [last, []] : [next, [next]])
      ),
      Stream.runForEach(shell.setHidden)
    )
  }).pipe(logDefect("The covering sync"), beforePaint)
)

const hidden = Atom.make((get) =>
  TileRects.coveredTiles([...get(overlays).values()], get(TilePlacements.placements))
)

function sameKeys(a: ReadonlyArray<TileKey>, b: ReadonlyArray<TileKey>): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}
