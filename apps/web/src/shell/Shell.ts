import { Hotkey } from "@sportal/api/Hotkey"
import type { ScreenTransition, ShellBridge, TilePlacement } from "@sportal/api/ShellBridge"
import type { TileKey } from "@sportal/api/TileKey"
import { Context, Effect, Layer, Option, Queue, Ref, Stream } from "effect"

/**
 * The web UI's edge to its window and to the desktop shell: hotkeys (the guide's while it is open), full screen, presses
 * on a video, and the guide the shell reads, and the calls that place videos and ask for a guide. The one reader of `window.sportalShell`.
 */
export class Shell extends Context.Service<
  Shell,
  {
    /** Hotkeys pressed on the page (not repeats, not typed into a field, not already handled; Ctrl+K always) and in a focused stream view. */
    readonly hotkeys: Stream.Stream<Hotkey>
    /** Whether the window is full screen, each time it changes. */
    readonly fullScreen: Stream.Stream<boolean>
    /** The key of the tile whose video was clicked while it was not interactive. */
    readonly tilePressed: Stream.Stream<TileKey>
    /** Each guide the shell reads from the source, unchanged. */
    readonly guideRead: Stream.Stream<string>
    readonly setFullScreen: (on: boolean) => Effect.Effect<void>
    /** Replaces the provider views; with a transition they move along it, without one at once. */
    readonly syncTiles: (
      placements: ReadonlyArray<TilePlacement>,
      transition: Option.Option<ScreenTransition>
    ) => Effect.Effect<void>
    /** Hides exactly these tiles' videos and shows the rest. */
    readonly setHidden: (keys: ReadonlyArray<TileKey>) => Effect.Effect<void>
    /**
     * Whether the guide is open. While it is, the arrows, Enter, the brackets and I are the guide's hotkeys, on the
     * page and in a focused stream view; while it is closed, the page and the players keep them.
     */
    readonly setGuideOpen: (on: boolean) => Effect.Effect<void>
    /** Asks the shell to read the guide now. */
    readonly readGuide: Effect.Effect<void>
    /** Opens the YouTube TV sign-in; none in a plain browser, which has no sign-in to open. */
    readonly openSignIn: Option.Option<Effect.Effect<void>>
    /**
     * Whether provider views lay the streams over the page: in the desktop shell. A plain browser has none, so the page
     * plays what it can itself.
     */
    readonly providerViews: boolean
  }
>()("sportal/web/shell/Shell") {
  /** The shell's bridge when the page runs in the shell, else the browser's own. */
  static readonly layer: Layer.Layer<Shell> = Layer.unwrap(
    Effect.sync(() => {
      const bridge = window.sportalShell
      return bridge === undefined ? Shell.layerBrowser : Shell.layerBridge(bridge)
    })
  )

  static layerBridge(bridge: ShellBridge): Layer.Layer<Shell> {
    return Layer.effect(
      Shell,
      Effect.gen(function* () {
        const guideOpen = yield* Ref.make(false)

        return Shell.of({
          hotkeys: Stream.merge(
            pageHotkeys(guideOpen),
            listened<Hotkey>((listener) => bridge.onHotkey(listener))
          ),
          fullScreen: listened((listener) => bridge.onFullScreenChanged(listener)),
          tilePressed: listened((listener) => bridge.onTilePressed(listener)),
          guideRead: listened((listener) => bridge.onGuideRead(listener)),
          setFullScreen: (on) => Effect.sync(() => bridge.setFullScreen(on)),
          syncTiles: (placements, transition) =>
            Effect.sync(() => bridge.syncTiles(placements, Option.getOrUndefined(transition))),
          setHidden: (keys) => Effect.sync(() => bridge.setHidden(keys)),
          setGuideOpen: (on) =>
            Ref.set(guideOpen, on).pipe(Effect.andThen(Effect.sync(() => bridge.setGuideOpen(on)))),
          readGuide: Effect.sync(() => bridge.readGuide()),
          openSignIn: Option.some(Effect.sync(() => bridge.openSignIn())),
          providerViews: true
        })
      })
    )
  }

  /**
   * The browser's own Shell, for a page outside the desktop shell: hotkeys pressed on the page and the document's full
   * screen, and no calls to a shell. Built lazily because the helpers it reads sit below the class.
   */
  static readonly layerBrowser: Layer.Layer<Shell> = Layer.effect(
    Shell,
    Effect.gen(function* () {
      const guideOpen = yield* Ref.make(false)

      return Shell.of({
        hotkeys: pageHotkeys(guideOpen),
        fullScreen: listened((listener) => {
          const changed = () => listener(document.fullscreenElement !== null)
          document.addEventListener("fullscreenchange", changed)
          return () => document.removeEventListener("fullscreenchange", changed)
        }),
        tilePressed: Stream.empty,
        guideRead: Stream.empty,
        // A browser refuses full screen outside a user gesture, or when the page may not have it.
        setFullScreen: (on) =>
          Effect.tryPromise(() =>
            on ? document.documentElement.requestFullscreen() : document.exitFullscreen()
          ).pipe(Effect.catch((error) => Effect.logWarning("The browser did not change full screen", error))),
        syncTiles: () => Effect.void,
        setHidden: () => Effect.void,
        setGuideOpen: (on) => Ref.set(guideOpen, on),
        readGuide: Effect.void,
        openSignIn: Option.none(),
        providerViews: false
      })
    })
  )

  /**
   * A Shell giving these events (none where not given), and running `record` for each call it is asked to make. It has
   * provider views, as the desktop shell does.
   */
  static layerTest(options: {
    readonly hotkeys?: Stream.Stream<Hotkey>
    readonly fullScreen?: Stream.Stream<boolean>
    readonly tilePressed?: Stream.Stream<TileKey>
    readonly guideRead?: Stream.Stream<string>
    readonly record: (
      call:
        | { readonly _tag: "SetFullScreen"; readonly on: boolean }
        | {
            readonly _tag: "SyncTiles"
            readonly placements: ReadonlyArray<TilePlacement>
            readonly transition: Option.Option<ScreenTransition>
          }
        | { readonly _tag: "SetHidden"; readonly keys: ReadonlyArray<TileKey> }
        | { readonly _tag: "SetGuideOpen"; readonly on: boolean }
        | { readonly _tag: "ReadGuide" }
        | { readonly _tag: "OpenSignIn" }
    ) => Effect.Effect<void>
  }): Layer.Layer<Shell> {
    const { record } = options
    return Layer.succeed(
      Shell,
      Shell.of({
        hotkeys: options.hotkeys ?? Stream.empty,
        fullScreen: options.fullScreen ?? Stream.empty,
        tilePressed: options.tilePressed ?? Stream.empty,
        guideRead: options.guideRead ?? Stream.empty,
        setFullScreen: (on) => record({ _tag: "SetFullScreen", on }),
        syncTiles: (placements, transition) => record({ _tag: "SyncTiles", placements, transition }),
        setHidden: (keys) => record({ _tag: "SetHidden", keys }),
        setGuideOpen: (on) => record({ _tag: "SetGuideOpen", on }),
        readGuide: record({ _tag: "ReadGuide" }),
        openSignIn: Option.some(record({ _tag: "OpenSignIn" })),
        providerViews: true
      })
    )
  }
}

/**
 * Hotkeys pressed on the page, the guide's keys among them while `guideOpen` holds. Keys typed into a text field are the
 * field's, and a key already handled is ignored, except Ctrl+K.
 */
function pageHotkeys(guideOpen: Ref.Ref<boolean>): Stream.Stream<Hotkey> {
  return listened<Hotkey>((listener) => {
    const pressed = (event: KeyboardEvent) => {
      const hotkey = Hotkey.of({
        code: event.code,
        shift: event.shiftKey,
        alt: event.altKey,
        control: event.ctrlKey,
        meta: event.metaKey,
        guideOpen: Ref.getUnsafe(guideOpen)
      })
      if (hotkey === undefined || event.repeat) return
      if (!Hotkey.guards.CommandPalette(hotkey) && (isTyping(event.target) || event.defaultPrevented)) return
      // In the listener itself: a default prevented after the event has been dispatched is too late.
      event.preventDefault()
      listener(hotkey)
    }
    window.addEventListener("keydown", pressed)
    return () => window.removeEventListener("keydown", pressed)
  })
}

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
  )
}

/**
 * An event as a stream: `listen` subscribes, and the function it returns unsubscribes. It subscribes in the fiber that
 * runs the stream, as the stream starts, so nothing that fiber does next can miss an event.
 */
function listened<A>(listen: (listener: (value: A) => void) => () => void): Stream.Stream<A> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<A>()
      yield* Effect.acquireRelease(
        Effect.sync(() => listen((value) => Queue.offerUnsafe(queue, value))),
        (stop) => Effect.sync(stop)
      )
      return Stream.fromQueue(queue)
    })
  )
}
