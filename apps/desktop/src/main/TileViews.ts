import type { TilePlacement } from "@sportal/api/ShellBridge"
import { Context, Effect, Layer } from "effect"
import type { View, WebContentsView } from "electron"
import { allows, hostOf, load, ProviderSession } from "./ProviderSession.ts"

/**
 * Keeps one provider web view per stream tile, laid over the web UI at the rectangle the UI reports.
 * The shell only ever sets a view's address, bounds, and mute flag; the provider's page is never modified.
 */
export class TileViews extends Context.Service<
  TileViews,
  {
    /** Makes the views match the placements: views for tiles not listed are closed. */
    sync(placements: ReadonlyArray<TilePlacement>): Effect.Effect<void>
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
        const views = new Map<number, { view: WebContentsView; url: string }>()

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
              entry = { view: yield* providers.createView, url: "" }
              window.contentView.addChildView(entry.view)
              views.set(placement.tile, entry)
            }
            if (entry.url !== placement.url) {
              entry.url = placement.url
              // The load starts now, as Electron issues it; only its outcome is awaited in the background.
              yield* Effect.forkIn(loadTile(entry.view, placement.url), scope, { startImmediately: true })
            }
            entry.view.setBounds(placement.bounds)
            entry.view.webContents.setAudioMuted(placement.muted)
          }
        })

        return TileViews.of({ sync })
      })
    )
}

function loadTile(view: WebContentsView, url: string) {
  return load(view.webContents, url).pipe(
    Effect.catchTag("LoadFailed", (failure) =>
      // A newer placement superseding this load aborts it; that is routine.
      failure.code === "ERR_ABORTED"
        ? Effect.void
        : Effect.logError(`TileViews: could not load a tile from ${hostOf(url)}: ${failure.code}`)
    )
  )
}
