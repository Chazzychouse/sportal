import { Hotkey } from "@sportal/api/Hotkey"
import type { ChannelPick, StageTransition, TileBounds, TilePlacement } from "@sportal/api/ShellBridge"
import type { GameId } from "@sportal/domain/Game"
import { Clock, Context, Data, Effect, FiberHandle, Layer, Option, PubSub, Stream } from "effect"
import type { WebContentsView } from "electron"
import { hostOf, load } from "./Navigation.ts"
import { ProviderSession } from "./ProviderSession.ts"
import { ShellWindow } from "./ShellWindow.ts"
import { Transition } from "./Transition.ts"
import { isChannelAddress } from "./YouTubeTv.ts"

/**
 * Keeps one provider web view per game in a stream or guide tile, laid over the web UI at the rectangle the UI
 * reports. A view belongs to its game, so a game that changes tiles keeps its player.
 * The shell only ever sets a view's address, bounds, visibility, mute flag, and focus, reads the address a guide
 * view lands on, reads the keys pressed in a stream view, and keeps the mouse from a stream view's player unless
 * it is interactive; the provider's page is never modified.
 */
export class TileViews extends Context.Service<
  TileViews,
  {
    /**
     * Makes the views match the placements: views for games not listed are closed. With a transition, views
     * move from where they are to their new bounds along it, and views new in it appear when it ends.
     */
    sync(placements: ReadonlyArray<TilePlacement>, transition?: StageTransition): Effect.Effect<void>
    /** Hides exactly these games' views, now and through later syncs, until a later call no longer names them. */
    hide(games: ReadonlyArray<GameId>): Effect.Effect<void>
    /** Each channel a guide view lands on, as the user picks it. */
    readonly channelPicks: Stream.Stream<ChannelPick>
    /** Each hotkey pressed while a stream view had keyboard focus. The page never receives it. */
    readonly hotkeys: Stream.Stream<Hotkey>
    /** Each game whose stream view was pressed with the left button while it was not interactive. The page never receives it. */
    readonly tilePresses: Stream.Stream<GameId>
  }
>()("sportal/desktop/TileViews") {
  static readonly layer: Layer.Layer<TileViews, never, ProviderSession | ShellWindow> = Layer.effect(
    TileViews,
    Effect.gen(function* () {
      const providers = yield* ProviderSession
      const window = yield* ShellWindow
      const scope = yield* Effect.scope
      const picks = yield* PubSub.unbounded<ChannelPick>()
      const hotkeys = yield* PubSub.unbounded<Hotkey>()
      const presses = yield* PubSub.unbounded<GameId>()
      const views = new Map<GameId, Entry>()
      let hidden: ReadonlySet<GameId> = new Set()
      // Views created during a transition, kept out of sight until it ends.
      const arriving = new Set<GameId>()
      const animation = yield* FiberHandle.make<void>()

      const showWhereDue = () => {
        for (const [game, { view }] of views) view.setVisible(!hidden.has(game) && !arriving.has(game))
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

      const create = Effect.fn("TileViews.create")(function* (game: GameId) {
        const entry: Entry = {
          view: yield* providers.createView,
          url: Option.none(),
          role: Role.Stream({ interactive: false }),
          bounds: { x: 0, y: 0, width: 0, height: 0 }
        }
        // YouTube TV moves between pages with pushState, which fires did-navigate-in-page, not will-navigate.
        const landed = (url: string) => {
          // A view removed in a sync stays silent, even if its page navigates before it closes.
          if (views.get(game) !== entry) return
          const role = entry.role
          if (role._tag !== "Guide") return
          // Leaving a channel address forgets it, so a refused pick can be retried with the same channel.
          // Only the same address arriving twice in a row (did-navigate, then did-navigate-in-page) is a repeat.
          if (!isChannelAddress(url)) {
            entry.role = Role.Guide({ reported: Option.none() })
            return
          }
          if (Option.contains(role.reported, url)) return
          entry.role = Role.Guide({ reported: Option.some(url) })
          PubSub.publishUnsafe(picks, { game, url })
        }
        entry.view.webContents.on("did-navigate", (_event, url) => landed(url))
        entry.view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
          if (isMainFrame) landed(url)
        })
        // A guide view gets every key, so its search box keeps working.
        entry.view.webContents.on("before-input-event", (event, input) => {
          if (views.get(game) !== entry || entry.role._tag !== "Stream" || input.type !== "keyDown") return
          const hotkey = Hotkey.of(input, "stream")
          if (hotkey === undefined) return
          event.preventDefault()
          PubSub.publishUnsafe(hotkeys, hotkey)
        })
        // YouTube TV shows its title and controls whenever the pointer moves over a player.
        entry.view.webContents.on("before-mouse-event", (event, mouse) => {
          if (views.get(game) !== entry || entry.role._tag !== "Stream" || entry.role.interactive) return
          event.preventDefault()
          if (mouse.type === "mouseDown" && mouse.button === "left") PubSub.publishUnsafe(presses, game)
        })
        window.contentView.addChildView(entry.view)
        return entry
      })

      const sync = Effect.fn("TileViews.sync")(function* (
        placements: ReadonlyArray<TilePlacement>,
        transition?: StageTransition
      ) {
        const permitted: Array<TilePlacement> = []
        for (const placement of placements) {
          if (providers.allows(placement.url)) permitted.push(placement)
          else
            yield* Effect.logWarning(
              `TileViews: refused the address for game ${placement.game} on ${hostOf(placement.url)}`
            )
        }

        for (const [game, entry] of views) {
          if (permitted.some((placement) => placement.game === game)) continue
          remove(entry.view)
          views.delete(game)
          arriving.delete(game)
        }

        const moves: Array<{ game: GameId; entry: Entry; from: TileBounds; to: TileBounds }> = []
        for (const placement of permitted) {
          let entry = views.get(placement.game)
          if (entry === undefined) {
            entry = yield* create(placement.game)
            views.set(placement.game, entry)
            // A new view has nowhere to move from: it waits at its place until the others arrive.
            place(entry, placement.bounds)
            if (transition !== undefined) arriving.add(placement.game)
          }
          const moved = !Option.contains(entry.url, placement.url)
          if (moved) {
            entry.url = Option.some(placement.url)
            // The load starts now, as Electron issues it; only its outcome is awaited in the background.
            yield* Effect.forkIn(loadTile(entry.view, placement.url), scope, { startImmediately: true })
          }
          const wasInteractive = entry.role._tag === "Stream" && entry.role.interactive
          const reported = entry.role._tag === "Guide" && !moved ? entry.role.reported : Option.none<string>()
          entry.role =
            placement.role === "guide"
              ? Role.Guide({ reported })
              : Role.Stream({ interactive: placement.interactive })
          if (placement.interactive && !wasInteractive) entry.view.webContents.focus()
          entry.view.webContents.setAudioMuted(placement.muted)
          moves.push({ game: placement.game, entry, from: entry.bounds, to: placement.bounds })
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
        moves: ReadonlyArray<{ game: GameId; entry: Entry; from: TileBounds; to: TileBounds }>,
        transition: StageTransition
      ) =>
        Effect.gen(function* () {
          const start = yield* Clock.currentTimeMillis
          let t = 0
          while (t < 1) {
            yield* Effect.sleep(frame)
            t = ((yield* Clock.currentTimeMillis) - start) / transition.durationMs
            const eased = Transition.progress(transition.easing, t)
            for (const { game, entry, from, to } of moves)
              if (views.get(game) === entry) place(entry, Transition.between(from, to, eased))
          }
          arriving.clear()
          showWhereDue()
        })

      const hide = (games: ReadonlyArray<GameId>) =>
        Effect.sync(() => {
          hidden = new Set(games)
          showWhereDue()
        })

      return TileViews.of({
        sync,
        hide,
        channelPicks: Stream.fromPubSub(picks),
        hotkeys: Stream.fromPubSub(hotkeys),
        tilePresses: Stream.fromPubSub(presses)
      })
    })
  )
}

/** About one display frame: how often a view moves during a transition. */
const frame = "16 millis"

/**
 * One game's view, the address last placed in it, what it shows, and where it is now. A guide view remembers the
 * channel address it last reported; a stream view, whether its player gets the mouse.
 */
type Entry = {
  view: WebContentsView
  url: Option.Option<string>
  role: Role
  bounds: TileBounds
}

type Role = Data.TaggedEnum<{
  Guide: { reported: Option.Option<string> }
  Stream: { interactive: boolean }
}>
const Role = Data.taggedEnum<Role>()

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
