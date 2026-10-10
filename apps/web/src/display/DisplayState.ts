import { Hotkey } from "@sportal/api/Hotkey"
import { Effect, Option, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import * as LiveStream from "../hub/LiveStream.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { Shell } from "../shell/Shell.ts"
import { StripCard } from "../slate/StripCard.ts"
import { logDefect, runtime } from "../WebRuntime.ts"
import { Display, DisplayInput } from "./Display.ts"

/**
 * This Display's local state. An input written to it is applied against the Screen and the slate strip: the next
 * Display is kept, and the step's screen commands go to the Screen.
 */
export const display: Atom.Writable<Display, DisplayInput> = Atom.writable(
  (get) => get(kept),
  (ctx, input: DisplayInput) => {
    const step = ctx.get(kept).apply(input, ctx.get(DisplayScreen.screen), ctx.get(cards))
    Atom.batch(() => {
      ctx.set(kept, step.display)
      for (const command of step.commands) ctx.set(DisplayScreen.screen, command)
    })
  }
).pipe(Atom.keepAlive)

/** The slate strip's cards: this Screen's bench, then the live slate. */
export const cards: Atom.Atom<ReadonlyArray<StripCard>> = Atom.make((get) =>
  StripCard.of(get(DisplayScreen.screen), get(LiveStream.live).slate)
)

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
    const keys = Stream.map(shell.hotkeys, (hotkey) => DisplayInput.Pressed({ hotkey }))
    const videos = Stream.map(shell.tilePressed, (game) => DisplayInput.VideoPressed({ game }))

    yield* Stream.merge(keys, videos).pipe(
      Stream.runForEach((input) =>
        Effect.sync(() => {
          if (DisplayInput.$is("Pressed")(input) && Hotkey.guards.FullScreen(input.hotkey))
            get.set(toggleFullScreen, undefined)
          else get.set(display, input)
        })
      )
    )
  }).pipe(logDefect("The Display's inputs"))
)

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

const kept = Atom.make(Display.initial).pipe(Atom.keepAlive)
