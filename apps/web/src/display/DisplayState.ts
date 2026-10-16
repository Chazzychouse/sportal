import type { Hotkey } from "@sportal/api/Hotkey"
import { Effect, Match, Option, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import * as GuideShelves from "../guide/GuideShelves.ts"
import * as Games from "../hub/Games.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { Shell } from "../shell/Shell.ts"
import { logDefect, runtime } from "../WebRuntime.ts"
import { Display, DisplayInput } from "./Display.ts"

/**
 * This Display's local state. An input written to it is applied against the Screen: the next Display is kept, and the
 * step's screen commands go to the Screen.
 */
export const display: Atom.Writable<Display, DisplayInput> = Atom.writable(
  (get) => get(kept),
  (ctx, input: DisplayInput) => {
    const step = ctx.get(kept).apply(input, ctx.get(DisplayScreen.screen), ctx.get(shelves))
    Atom.batch(() => {
      ctx.set(kept, step.display)
      for (const command of step.commands) ctx.set(DisplayScreen.screen, command)
    })
  }
).pipe(Atom.keepAlive)

/**
 * The guide's entries and shelves over today's games: only All live, with nothing on it, before the first answer.
 * What the fold and the guide read.
 */
export const shelves: Atom.Atom<GuideShelves.GuideShelves> = Atom.make((get) => {
  const games = Option.match(get(Games.today).value, { onNone: () => [], onSome: ({ games }) => games })
  return GuideShelves.guideShelves(games)
})

/** Whether this Display's window is full screen: in the shell the window, in a browser the page. */
export const fullScreen: Atom.Atom<boolean> = runtime
  .atom(
    Stream.unwrap(
      Effect.gen(function* () {
        const shell = yield* Shell
        return shell.fullScreen
      })
    )
  )
  .pipe(Atom.map(AsyncResult.getOrElse(() => false)), Atom.keepAlive)

/** Puts this Display's window in full screen, or out of it. */
export const toggleFullScreen = runtime.fn((_: undefined, get) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    // Read through the registry, not as a dependency: a dependency would run the toggle again when it lands.
    const on = get.registry.get(fullScreen)

    yield* shell.setFullScreen(!on)
  })
)

/**
 * The hotkeys and video presses the Shell reports, as this Display's inputs; the `FullScreen` hotkey toggles full
 * screen. Mounted once, by the Display.
 */
export const inputs = runtime.atom((get) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const keys = Stream.runForEach(shell.hotkeys, (hotkey) => Effect.sync(() => get.set(pressed, hotkey)))
    const videos = Stream.runForEach(shell.tilePressed, (key) =>
      Effect.sync(() => get.set(display, DisplayInput.VideoPressed({ key })))
    )

    yield* Effect.all([keys, videos], { concurrency: "unbounded", discard: true })
  }).pipe(logDefect("The Display's inputs"))
)

/** A hotkey pressed anywhere, a Remote's included: routed as the shell's hotkeys are. */
export const pressed: Atom.Writable<void, Hotkey> = Atom.writable(
  () => undefined,
  (ctx, hotkey: Hotkey) => route(ctx, hotkey)
).pipe(Atom.keepAlive)

/** Whether this Display can open the YouTube TV sign-in: only in the shell. */
export const signIn: Atom.Atom<boolean> = runtime
  .atom(
    Effect.gen(function* () {
      const shell = yield* Shell
      return Option.isSome(shell.openSignIn)
    })
  )
  .pipe(Atom.map(AsyncResult.getOrElse(() => false)))

/** Opens the YouTube TV sign-in, when there is one. */
export const openSignIn = runtime.fn((_: undefined) =>
  Effect.gen(function* () {
    const shell = yield* Shell

    yield* Option.getOrElse(shell.openSignIn, () => Effect.void)
  })
)

/**
 * Tells the shell whether the guide is open, each time that changes: while it is, the arrows and Enter are the guide's,
 * and while it is closed a player keeps them. Mounted once, by the Display.
 */
export const guideOpenSync = runtime.atom((get) =>
  Effect.gen(function* () {
    const shell = yield* Shell

    yield* get.stream(guideOpen).pipe(Stream.changes, Stream.runForEach(shell.setGuideOpen))
  }).pipe(logDefect("The guide-open sync"))
)

const kept = Atom.make(Display.initial).pipe(Atom.keepAlive)

const guideOpen = Atom.make((get) => get(display).shows("Guide"))

function route(ctx: Atom.WriteContext<void>, hotkey: Hotkey) {
  Match.value(hotkey).pipe(
    Match.tag("FullScreen", () => ctx.set(toggleFullScreen, undefined)),
    Match.orElse(() => ctx.set(display, DisplayInput.Pressed({ hotkey })))
  )
}
