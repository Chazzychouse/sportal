import type { TilePlacement } from "@sportal/api/ShellBridge"
import type { BrowserWindow, WebContentsView } from "electron"
import * as ProviderSession from "./ProviderSession.ts"

/**
 * Keeps one provider web view per stream tile, laid over the web UI at the rectangle the UI reports.
 * The shell only ever sets a view's address, bounds, and mute flag; the provider's page is never modified.
 */
export function attach(window: BrowserWindow) {
  const views = new Map<number, { view: WebContentsView; url: string }>()

  return {
    sync(placements: ReadonlyArray<TilePlacement>) {
      const permitted = placements.filter((placement) => {
        const allowed = ProviderSession.allows(placement.url)
        if (!allowed)
          console.warn(
            `TileViews: refused tile ${placement.tile} address on ${ProviderSession.hostOf(placement.url)}`
          )
        return allowed
      })

      for (const [tile, entry] of views) {
        if (permitted.some((placement) => placement.tile === tile)) continue
        window.contentView.removeChildView(entry.view)
        entry.view.webContents.close()
        views.delete(tile)
      }

      for (const placement of permitted) {
        let entry = views.get(placement.tile)
        if (entry === undefined) {
          entry = { view: ProviderSession.createView(), url: "" }
          window.contentView.addChildView(entry.view)
          views.set(placement.tile, entry)
        }
        if (entry.url !== placement.url) {
          entry.url = placement.url
          loadTile(entry.view, placement.url)
        }
        entry.view.setBounds(placement.bounds)
        entry.view.webContents.setAudioMuted(placement.muted)
      }
    }
  }
}

function loadTile(view: WebContentsView, url: string) {
  view.webContents.loadURL(url).catch((error: unknown) => {
    const code = ProviderSession.loadErrorCode(error)
    // A newer placement superseding this load aborts it; that is routine.
    if (code === "ERR_ABORTED") return
    console.error(`TileViews: could not load a tile from ${ProviderSession.hostOf(url)}: ${code}`)
  })
}
