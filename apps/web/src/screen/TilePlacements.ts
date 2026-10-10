import { type ScreenTransition, type TileBounds, TilePlacement } from "@sportal/api/ShellBridge"
import { Effect, Option, Schema, Stream } from "effect"
import { Atom } from "effect/reactivity"
import * as DisplayState from "../display/DisplayState.ts"
import { Shell } from "../shell/Shell.ts"
import { beforePaint, logDefect, runtime } from "../WebRuntime.ts"
import * as DisplayScreen from "./DisplayScreen.ts"
import { type Screen, type Split, Tile } from "./Screen.ts"
import * as TileRects from "./TileRects.ts"

/** The Screen area's size and its place in the window, as the Screen view last measured it. */
export const area: Atom.Writable<TileBounds> = Atom.make<TileBounds>({
  x: 0,
  y: 0,
  width: 0,
  height: 0
}).pipe(Atom.keepAlive)

/** The split a divider is being dragged to, until its drop commits it. */
export const dragged: Atom.Writable<Option.Option<Split>> = Atom.make<Option.Option<Split>>(
  Option.none()
).pipe(Atom.keepAlive)

/** The Screen as shown: the dragged split in place of its own. */
export const shown: Atom.Atom<Screen> = Atom.make((get) => {
  const screen = get(DisplayScreen.screen)
  return Option.match(get(dragged), { onNone: () => screen, onSome: (split) => screen.withSplit(split) })
})

/** Each on-screen tile's rectangle in the Screen area, as shown. */
export const rects: Atom.Atom<ReadonlyArray<TileBounds>> = Atom.make((get) =>
  TileRects.tileRects(get(shown), get(area))
)

/** What the shell must show for each stream tile with a size, as shown. */
export const placements: Atom.Atom<ReadonlyArray<TilePlacement>> = Atom.make((get) => {
  const screen = get(DisplayScreen.screen)
  const interacting = get(DisplayState.display).interactingOn(screen)
  return TileRects.placements(get(shown), get(rects), get(area), interacting)
})

/** How tiles move when the Screen's arrangement changes; the shell moves the video along the same curve. */
export const screenTransition: ScreenTransition = { durationMs: 280, easing: [0.2, 0, 0, 1] }

/**
 * Tells the shell each changed set of placements, so a re-render never cuts a transition short. A change of
 * arrangement moves the views along the Screen transition; a resize or a drag moves them at once. Nothing is told
 * while the area has no size. Mounted once, by the Display.
 */
export const sync = runtime.atom((get) =>
  Effect.gen(function* () {
    const shell = yield* Shell

    yield* get.stream(pending).pipe(
      Stream.filter(({ sized }) => sized),
      Stream.changesWith((a, b) => samePlacements(a.placements, b.placements)),
      Stream.mapAccum(
        () => Option.none<Screen>(),
        (last, next) => {
          const moved =
            Option.exists(last, (screen) => !sameArrangement(screen, next.screen)) && !next.dragging
          const transition = moved ? Option.some(screenTransition) : Option.none<ScreenTransition>()
          return [Option.some(next.screen), [{ placements: next.placements, transition }]] as const
        }
      ),
      Stream.runForEach(({ placements, transition }) => shell.syncTiles(placements, transition))
    )
  }).pipe(logDefect("The tile sync"), beforePaint)
)

/** What a sync reads: the placements, the Screen they arrange (without a dragged split), and whether one is dragged. */
const pending = Atom.make((get) => ({
  placements: get(placements),
  screen: get(DisplayScreen.screen),
  dragging: Option.isSome(get(dragged)),
  sized: get(area).width > 0
}))

const samePlacements = Schema.toEquivalence(Schema.Array(TilePlacement))

/** Whether two Screens put tiles in the same places: the layout, its split, solo, and the game in each slot. */
function sameArrangement(a: Screen, b: Screen): boolean {
  const split = a.splits[a.layout]
  const other = b.splits[b.layout]
  const games = gamesIn(a)
  const others = gamesIn(b)
  return (
    a.layout === b.layout &&
    split.x === other.x &&
    split.y === other.y &&
    Option.getOrUndefined(a.solo) === Option.getOrUndefined(b.solo) &&
    games.length === others.length &&
    games.every((game, slot) => game === others[slot])
  )
}

function gamesIn(screen: Screen) {
  return screen.onScreen().map((tile) => (Tile.guards.Empty(tile) ? undefined : tile.game))
}
