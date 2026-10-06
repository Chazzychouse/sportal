/**
 * The IPC channel names the shell and its preload speak on, one per `ShellBridge` call. A module of its own, so the
 * sandboxed preload bundles these strings without the schemas beside `ShellBridge`.
 */
export const ShellChannel = {
  syncTiles: "sportal:sync-tiles",
  setHidden: "sportal:set-hidden",
  setFullScreen: "sportal:set-full-screen",
  fullScreenChanged: "sportal:full-screen-changed",
  hotkey: "sportal:hotkey",
  tilePressed: "sportal:tile-pressed",
  openSignIn: "sportal:open-sign-in",
  guideRead: "sportal:guide-read",
  readGuide: "sportal:read-guide"
} as const
