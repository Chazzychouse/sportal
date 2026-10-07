/**
 * Imported into electron-vite in development so Ctrl+C waits for Electron. The terminal sends SIGINT to both, and
 * electron-vite would exit at once, returning the prompt while Electron is still quitting. Ignoring it here lets
 * electron-vite exit when Electron closes, as it already does; the timer covers a Ctrl+C before Electron has started.
 */
process.on("SIGINT", () => {
  setTimeout(() => process.exit(130), 5000).unref()
})
