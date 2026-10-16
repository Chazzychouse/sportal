import { Hotkey } from "@sportal/api/Hotkey"
import type { ScreenTransition, TileBounds, TilePlacement } from "@sportal/api/ShellBridge"
import type { TileKey } from "@sportal/api/TileKey"
import { Clock, Context, Effect, FiberHandle, Layer, Option, PubSub, Stream } from "effect"
import type { WebContentsView } from "electron"
import { hostOf, load } from "./Navigation.ts"
import { ProviderSession } from "./ProviderSession.ts"
import { ShellWindow } from "./ShellWindow.ts"
import { Transition } from "./Transition.ts"

/**
 * Keeps one provider web view per stream tile, by the tile's key, laid over the web UI at the rectangle the UI
 * reports. A view belongs to its tile's key, so a game that changes tiles keeps its player.
 * The shell only ever sets a view's address, bounds, visibility, mute flag, and focus, reads the keys pressed in
 * a view, and keeps the mouse from a view's player unless it is interactive; the provider's page is never modified.
 */
export class TileViews extends Context.Service<
  TileViews,
  {
    /**
     * Makes the views match the placements: views for keys not listed are closed. With a transition, views
     * move from where they are to their new bounds along it, and views new in it appear when it ends.
     */
    sync(placements: ReadonlyArray<TilePlacement>, transition?: ScreenTransition): Effect.Effect<void>
    /** Hides exactly these tiles' views, now and through later syncs, until a later call no longer names them. */
    hide(keys: ReadonlyArray<TileKey>): Effect.Effect<void>
    /** Each hotkey pressed while a stream view had keyboard focus. The page never receives it. */
    readonly hotkeys: Stream.Stream<Hotkey>
    /**
     * The key of each tile whose stream view was pressed with the left button while it was not interactive. The page
     * never receives it.
     */
    readonly tilePresses: Stream.Stream<TileKey>
  }
>()("sportal/desktop/main/TileViews") {
  static readonly layer: Layer.Layer<TileViews, never, ProviderSession | ShellWindow> = Layer.effect(
    TileViews,
    Effect.gen(function* () {
      const providers = yield* ProviderSession
      const window = yield* ShellWindow
      const scope = yield* Effect.scope
      const hotkeys = yield* PubSub.unbounded<Hotkey>()
      const presses = yield* PubSub.unbounded<TileKey>()
      const animation = yield* FiberHandle.make<void>()

      const views = new Map<TileKey, Entry>()
      let hidden: ReadonlySet<TileKey> = new Set()
      // Views created during a transition, kept out of sight until it ends.
      const arriving = new Set<TileKey>()

      const showWhereDue = () => {
        for (const [key, { view }] of views) view.setVisible(!hidden.has(key) && !arriving.has(key))
      }
      const place = (entry: Entry, bounds: TileBounds) => {
        entry.bounds = bounds
        entry.view.setBounds(bounds)
      }

      const remove = (view: WebContentsView) => {
        if (!window.isDestroyed()) window.contentView.removeChildView(view)
        if (!view.webContents.isDestroyed()) view.webContents.close()
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const { view } of views.values()) remove(view)
          views.clear()
        })
      )

      const create = Effect.fn("TileViews.create")(function* (key: TileKey) {
        const view = yield* providers.createView
        const entry: Entry = {
          view,
          url: Option.none(),
          interactive: false,
          bounds: { x: 0, y: 0, width: 0, height: 0 }
        }
        entry.view.webContents.on("before-input-event", (event, input) => {
          if (views.get(key) !== entry || input.type !== "keyDown") return
          const hotkey = Hotkey.of(input)
          if (hotkey === undefined) return
          event.preventDefault()
          PubSub.publishUnsafe(hotkeys, hotkey)
        })
        // YouTube TV shows its title and controls whenever the pointer moves over a player.
        entry.view.webContents.on("before-mouse-event", (event, mouse) => {
          if (views.get(key) !== entry || entry.interactive) return
          event.preventDefault()
          if (mouse.type === "mouseDown" && mouse.button === "left") PubSub.publishUnsafe(presses, key)
        })
        window.contentView.addChildView(entry.view)
        return entry
      })

      const sync = Effect.fn("TileViews.sync")(function* (
        placements: ReadonlyArray<TilePlacement>,
        transition?: ScreenTransition
      ) {
        const permitted = yield* Effect.filter(placements, (placement) =>
          providers.allows(placement.url)
            ? Effect.succeed(true)
            : Effect.logWarning(
                `TileViews: refused the address for tile ${placement.key} on ${hostOf(placement.url)}`
              ).pipe(Effect.as(false))
        )

        for (const [key, entry] of views) {
          if (permitted.some((placement) => placement.key === key)) continue
          remove(entry.view)
          views.delete(key)
          arriving.delete(key)
        }

        const moves: Array<{ key: TileKey; entry: Entry; from: TileBounds; to: TileBounds }> = []
        for (const placement of permitted) {
          let entry = views.get(placement.key)
          if (entry === undefined) {
            entry = yield* create(placement.key)
            views.set(placement.key, entry)
            // A new view has nowhere to move from: it waits at its place until the others arrive.
            place(entry, placement.bounds)
            if (transition !== undefined) arriving.add(placement.key)
          }
          if (!Option.contains(entry.url, placement.url)) {
            entry.url = Option.some(placement.url)
            // The load starts now, as Electron issues it; only its outcome is awaited in the background.
            yield* Effect.forkIn(loadTile(entry.view, placement.url), scope, { startImmediately: true })
          }
          if (placement.interactive && !entry.interactive) entry.view.webContents.focus()
          entry.interactive = placement.interactive
          entry.view.webContents.setAudioMuted(placement.muted)
          moves.push({ key: placement.key, entry, from: entry.bounds, to: placement.bounds })
        }

        if (transition === undefined) {
          yield* FiberHandle.clear(animation)
          arriving.clear()
          for (const { entry, to } of moves) place(entry, to)
          showWhereDue()
          return
        }
        showWhereDue()
        // A newer sync interrupts this one, and starts from wherever the views have got to.
        yield* FiberHandle.run(animation, animate(moves, transition))
      })

      const animate = (
        moves: ReadonlyArray<{ key: TileKey; entry: Entry; from: TileBounds; to: TileBounds }>,
        transition: ScreenTransition
      ) =>
        Effect.gen(function* () {
          const start = yield* Clock.currentTimeMillis
          const step = Effect.sleep(frame).pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.map((now) => (now - start) / transition.durationMs),
            Effect.tap((t) =>
              Effect.sync(() => {
                const eased = Transition.progress(transition.easing, t)
                moves.forEach(({ key, entry, from, to }) => {
                  if (views.get(key) === entry) place(entry, Transition.between(from, to, eased))
                })
              })
            )
          )
          yield* Effect.repeat(step, { while: (t) => t < 1 })
          arriving.clear()
          showWhereDue()
        })

      const hide = (keys: ReadonlyArray<TileKey>) =>
        Effect.sync(() => {
          hidden = new Set(keys)
          showWhereDue()
        })

      return TileViews.of({
        sync,
        hide,
        hotkeys: Stream.fromPubSub(hotkeys),
        tilePresses: Stream.fromPubSub(presses)
      })
    })
  )
}

/** About one display frame: how often a view moves during a transition. */
const frame = "16 millis"

/** One tile's view, the address last placed in it, whether its player gets the mouse, and where it is now. */
interface Entry {
  view: WebContentsView
  url: Option.Option<string>
  interactive: boolean
  bounds: TileBounds
}

function loadTile(view: WebContentsView, url: string) {
  return load(view.webContents, url).pipe(
    Effect.catchTag("LoadFailed", (failure) =>
      // A newer placement superseding this load aborts it, and a removed view's load fails; both are routine.
      failure.code === "ERR_ABORTED" || view.webContents.isDestroyed()
        ? Effect.void
        : Effect.logError(`TileViews: could not load a tile from ${hostOf(url)}: ${failure.code}`)
    )
  )
}
