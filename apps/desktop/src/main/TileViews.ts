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
      for (const [tile, entry] of views) {
        if (placements.some((placement) => placement.tile === tile)) continue
        window.contentView.removeChildView(entry.view)
        entry.view.webContents.close()
        views.delete(tile)
      }

      for (const placement of placements) {
        if (!ProviderSession.allows(placement.url)) continue
        let entry = views.get(placement.tile)
        if (entry === undefined) {
          entry = { view: ProviderSession.createView(), url: "" }
          window.contentView.addChildView(entry.view)
          views.set(placement.tile, entry)
        }
        if (entry.url !== placement.url) {
          entry.url = placement.url
          void entry.view.webContents.loadURL(placement.url)
        }
        entry.view.setBounds(placement.bounds)
        entry.view.webContents.setAudioMuted(placement.muted)
      }
    }
  }
}
