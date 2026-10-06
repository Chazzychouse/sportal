import { Effect, Schema } from "effect"
import type { WebContents } from "electron"

/**
 * Keeps a page on the addresses `permits` allows: a navigation or server redirect elsewhere is refused and
 * reported to `warn` by hostname only, and the page never opens a window. With `subframes`, navigations
 * inside the page's frames are held to the same addresses.
 */
export function confine(
  contents: {
    on(
      event: "will-navigate" | "will-redirect" | "will-frame-navigate",
      listener: (details: { url: string; isMainFrame: boolean; preventDefault(): void }) => void
    ): unknown
    setWindowOpenHandler(handler: () => { action: "deny" }): void
  },
  permits: (url: string) => boolean,
  warn: (message: string) => void,
  options: { subframes: boolean }
) {
  const refuseUnlessPermitted = (details: { url: string; preventDefault(): void }) => {
    if (permits(details.url)) return
    details.preventDefault()
    warn(`refused navigation to ${hostOf(details.url)}`)
  }
  // will-navigate does not fire for server redirects, so both are guarded.
  contents.on("will-navigate", refuseUnlessPermitted)
  contents.on("will-redirect", refuseUnlessPermitted)
  if (options.subframes)
    contents.on("will-frame-navigate", (details) => {
      if (!details.isMainFrame) refuseUnlessPermitted(details)
    })
  contents.setWindowOpenHandler(() => ({ action: "deny" }))
}

/** The hostname alone, for logging: a full URL can carry tokens. */
export function hostOf(url: string) {
  return URL.canParse(url) ? new URL(url).hostname : "(unparseable address)"
}

/** Loads an address into a page; a failed load fails with Electron's error code, never its message. */
export function load(contents: WebContents, url: string) {
  return Effect.tryPromise({
    try: () => contents.loadURL(url),
    catch: (error) => new LoadFailed({ code: loadErrorCode(error) })
  })
}

/**
 * The code Electron attaches to a failed load (such as `ERR_ABORTED`); the message would carry the full URL.
 * @testonly
 */
export function loadErrorCode(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown"
}

class LoadFailed extends Schema.TaggedError<LoadFailed>()("LoadFailed", { code: Schema.String }) {}
