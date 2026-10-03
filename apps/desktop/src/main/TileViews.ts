import type { ChannelPick, TilePlacement } from "@sportal/api/ShellBridge"
import { Context, Effect, Layer, PubSub, Stream } from "effect"
import type { View, WebContentsView } from "electron"
import { allows, hostOf, load, ProviderSession } from "./ProviderSession.ts"

/**
 * Keeps one provider web view per stream or guide tile, laid over the web UI at the rectangle the UI reports.
 * The shell only ever sets a view's address, bounds, and mute flag, and reads the address a guide view
 * lands on; the provider's page is never modified.
 */
export class TileViews extends Context.Service<
  TileViews,
  {
    /** Makes the views match the placements: views for tiles not listed are closed. */
    sync(placements: ReadonlyArray<TilePlacement>): Effect.Effect<void>
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
        const views = new Map<number, Entry>()

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

        const create = Effect.fn("TileViews.create")(function* (tile: number) {
          const entry: Entry = { view: yield* providers.createView, url: "", role: "stream", reported: "" }
          // YouTube TV moves between pages with pushState, which fires did-navigate-in-page, not will-navigate.
          const landed = (url: string) => {
            // A view removed in a sync stays silent, even if its page navigates before it closes.
            if (views.get(tile) !== entry) return
            if (entry.role !== "guide") return
            // Leaving a channel address forgets it, so a refused pick can be retried with the same channel.
            // Only the same address arriving twice in a row (did-navigate, then did-navigate-in-page) is a repeat.
            if (!isChannelAddress(url)) {
              entry.reported = ""
              return
            }
            if (url === entry.reported) return
            entry.reported = url
            PubSub.publishUnsafe(picks, { tile, url })
          }
          entry.view.webContents.on("did-navigate", (_event, url) => landed(url))
          entry.view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
            if (isMainFrame) landed(url)
          })
          window.contentView.addChildView(entry.view)
          return entry
        })

        const sync = Effect.fn("TileViews.sync")(function* (placements: ReadonlyArray<TilePlacement>) {
          const permitted: Array<TilePlacement> = []
          for (const placement of placements) {
            if (allows(placement.url)) permitted.push(placement)
            else
              yield* Effect.logWarning(
                `TileViews: refused tile ${placement.tile} address on ${hostOf(placement.url)}`
              )
          }

          for (const [tile, entry] of views) {
            if (permitted.some((placement) => placement.tile === tile)) continue
            remove(entry.view)
            views.delete(tile)
          }

          for (const placement of permitted) {
            let entry = views.get(placement.tile)
            if (entry === undefined) {
              entry = yield* create(placement.tile)
              views.set(placement.tile, entry)
            }
            if (entry.url !== placement.url) {
              entry.url = placement.url
              entry.reported = ""
              // The load starts now, as Electron issues it; only its outcome is awaited in the background.
              yield* Effect.forkIn(loadTile(entry.view, placement.url), scope, { startImmediately: true })
            }
            entry.role = placement.role
            entry.view.setBounds(placement.bounds)
            entry.view.webContents.setAudioMuted(placement.muted)
          }
        })

        return TileViews.of({ sync, channelPicks: Stream.fromPubSub(picks) })
      })
    )
}

/** One tile's view, the address last placed in it, its role, and the last channel address it reported. */
type Entry = { view: WebContentsView; url: string; role: TilePlacement["role"]; reported: string }

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
