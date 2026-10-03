import type { ChannelPick, StageTransition, TilePlacement } from "@sportal/api/ShellBridge"
import type { GameId } from "@sportal/domain/Game"
import { Clock, Context, Effect, FiberHandle, Layer, PubSub, Stream } from "effect"
import type { View, WebContentsView } from "electron"
import { allows, hostOf, load, ProviderSession } from "./ProviderSession.ts"
import { Transition } from "./Transition.ts"

/**
 * Keeps one provider web view per game in a stream or guide tile, laid over the web UI at the rectangle the UI
 * reports. A view belongs to its game, so a game that changes tiles keeps its player.
 * The shell only ever sets a view's address, bounds, visibility, and mute flag, and reads the address a guide
 * view lands on; the provider's page is never modified.
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
  }
>()("sportal/desktop/TileViews") {
  // Only the window's own view tree is touched, so that is all the layer asks for.
  static readonly layer = (window: {
    readonly contentView: Pick<View, "addChildView" | "removeChildView">
    isDestroyed(): boolean
  }) =>
    Layer.effect(
      TileViews,
      Effect.gen(function* () {
        const providers = yield* ProviderSession
        const scope = yield* Effect.scope
        const picks = yield* PubSub.unbounded<ChannelPick>()
        const views = new Map<GameId, Entry>()
        let hidden: ReadonlySet<GameId> = new Set()
        // Views created during a transition, kept out of sight until it ends.
        const arriving = new Set<GameId>()
        const animation = yield* FiberHandle.make<void>()

        const showWhereDue = () => {
          for (const [game, { view }] of views) view.setVisible(!hidden.has(game) && !arriving.has(game))
        }
        const place = (entry: Entry, bounds: Bounds) => {
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
            url: "",
            role: "stream",
            reported: "",
            bounds: { x: 0, y: 0, width: 0, height: 0 }
          }
          // YouTube TV moves between pages with pushState, which fires did-navigate-in-page, not will-navigate.
          const landed = (url: string) => {
            // A view removed in a sync stays silent, even if its page navigates before it closes.
            if (views.get(game) !== entry) return
            if (entry.role !== "guide") return
            // Leaving a channel address forgets it, so a refused pick can be retried with the same channel.
            // Only the same address arriving twice in a row (did-navigate, then did-navigate-in-page) is a repeat.
            if (!isChannelAddress(url)) {
              entry.reported = ""
              return
            }
            if (url === entry.reported) return
            entry.reported = url
            PubSub.publishUnsafe(picks, { game, url })
          }
          entry.view.webContents.on("did-navigate", (_event, url) => landed(url))
          entry.view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
            if (isMainFrame) landed(url)
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
            if (allows(placement.url)) permitted.push(placement)
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

          const moves: Array<{ entry: Entry; from: Bounds; to: Bounds }> = []
          for (const placement of permitted) {
            let entry = views.get(placement.game)
            if (entry === undefined) {
              entry = yield* create(placement.game)
              views.set(placement.game, entry)
              // A new view has nowhere to move from: it waits at its place until the others arrive.
              place(entry, placement.bounds)
              if (transition !== undefined) arriving.add(placement.game)
            }
            if (entry.url !== placement.url) {
              entry.url = placement.url
              entry.reported = ""
              // The load starts now, as Electron issues it; only its outcome is awaited in the background.
              yield* Effect.forkIn(loadTile(entry.view, placement.url), scope, { startImmediately: true })
            }
            entry.role = placement.role
            entry.view.webContents.setAudioMuted(placement.muted)
            moves.push({ entry, from: entry.bounds, to: placement.bounds })
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
          moves: ReadonlyArray<{ entry: Entry; from: Bounds; to: Bounds }>,
          transition: StageTransition
        ) =>
          Effect.gen(function* () {
            const start = yield* Clock.currentTimeMillis
            let t = 0
            while (t < 1) {
              yield* Effect.sleep(frame)
              t = ((yield* Clock.currentTimeMillis) - start) / transition.durationMs
              const eased = Transition.progress(transition.easing, t)
              for (const { entry, from, to } of moves)
                if ([...views.values()].includes(entry)) place(entry, Transition.between(from, to, eased))
            }
            arriving.clear()
            showWhereDue()
          })

        const hide = (games: ReadonlyArray<GameId>) =>
          Effect.sync(() => {
            hidden = new Set(games)
            showWhereDue()
          })

        return TileViews.of({ sync, hide, channelPicks: Stream.fromPubSub(picks) })
      })
    )
}

/** About one display frame: how often a view moves during a transition. */
const frame = "16 millis"

/**
 * One game's view, the address last placed in it, its role, the last channel address it reported, and where
 * it is now.
 */
type Entry = {
  view: WebContentsView
  url: string
  role: TilePlacement["role"]
  reported: string
  bounds: Bounds
}
type Bounds = TilePlacement["bounds"]

function isChannelAddress(url: string) {
  if (!URL.canParse(url)) return false
  const { protocol, hostname, pathname } = new URL(url)
  return protocol === "https:" && hostname === "tv.youtube.com" && pathname.startsWith("/watch/")
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
