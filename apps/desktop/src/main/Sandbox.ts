/** What every window and view the shell opens runs under: no Node in the page, an isolated context, the Chromium sandbox. */
export const sandboxed = { contextIsolation: true, nodeIntegration: false, sandbox: true } as const
