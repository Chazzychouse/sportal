# One-command dev launch

## Goal

`pnpm dev` from the repo root starts the Hub, the web dev server, and the desktop shell, each reloading
on change, with no env vars to type and no required start order. A fresh `pnpm install` leaves
Electron ready to run.

## Today

| Friction | Cause |
| --- | --- |
| Three terminals, in order | No root `dev`; the shell fails if the web server is not up yet |
| `SPORTAL_HUB_URL=…:4401` typed by hand | The shell defaults to the Hub at :4400, which serves no dev UI |
| Shell edits need a manual restart | Desktop `start` is `electron-vite build && electron .` (one shot) |
| Database moves with the working dir | `.sportal/` is relative; `pnpm --filter` runs in `apps/hub`, so it is `apps/hub/.sportal` today |
| `node …/electron/install.js` after every fresh install | The castlabs package ships no `postinstall` script, only an `install-electron` bin, so `allowBuilds: electron` has nothing to run |

## Changes

### 1. Root scripts — `package.json`

```json
"dev": "pnpm -r --parallel run dev",
"dev:x11": "ELECTRON_CLI_ARGS='[\"--ozone-platform=x11\"]' pnpm dev"
```

pnpm prefixes each package's output and Ctrl-C stops all of them. Only the three apps define `dev`.
`electron-vite dev` reads `ELECTRON_CLI_ARGS` (JSON array) for extra Electron flags.

### 2. Hub — `apps/hub/package.json`

```json
"dev": "SPORTAL_DATA_DIR=${SPORTAL_DATA_DIR:-../../.sportal} node --watch src/main.ts"
```

Dev data lives at the repo-root `.sportal/` (already gitignored) no matter how the Hub is launched;
an explicit `SPORTAL_DATA_DIR` still wins. One-time move of the existing database:
`mv apps/hub/.sportal .sportal`.

### 3. Desktop — `apps/desktop/package.json`

```json
"postinstall": "install-electron",
"dev": "SPORTAL_HUB_URL=${SPORTAL_HUB_URL:-http://127.0.0.1:4401} electron-vite dev --watch"
```

- `install-electron` exits immediately when the binary is already present, so it costs nothing on
  repeat installs. pnpm runs a workspace package's own lifecycle scripts; `allowBuilds` only gates
  dependencies.
- `electron-vite dev --watch` rebuilds main and preload on change: a main edit restarts Electron, a
  preload edit reloads the window. The config has no renderer, which electron-vite allows.
- `start` and `start:x11` stay as they are for running against a built Hub.

### 4. The shell waits for the Hub — `apps/desktop/src/main/main.ts`

In `serveHub`, retry the Hub load while the Hub refuses the connection and the window is still open:

```ts
yield* load(window.webContents, hubUrl).pipe(
  Effect.tapError((failure) =>
    failure.code === "ERR_CONNECTION_REFUSED"
      ? Effect.logInfo(`Sportal: waiting for the Hub at ${hostOf(hubUrl)}`)
      : Effect.void
  ),
  Effect.retry({
    schedule: Schedule.spaced("1 second"),
    while: (failure) => failure.code === "ERR_CONNECTION_REFUSED" && !window.isDestroyed()
  }),
  Effect.catchTag("LoadFailed", /* unchanged */)
)
```

No cap: the window exists only to show the Hub, and closing it ends the wait (the load then fails with
`ERR_ABORTED`, which is not retried). This also covers a Hub restart before the shell's first load in
production. The log line repeats once per second while waiting; if that is too noisy, log only the
first attempt.

`main.ts` runs at import and has no test harness; this is verified by hand (below), not by a unit test.

### 5. Docs — `AGENTS.md` Commands

Lead with `pnpm dev` / `pnpm dev:x11`; keep the per-app commands for running one piece; drop the
manual `install.js` note.

## Verification

1. `pnpm dev`: all three start; the shell window shows the web UI once Vite is up, whatever order
   they come up in.
2. Edit a file in each of hub / web / desktop main / desktop preload: Hub restarts, Vite hot-reloads,
   Electron restarts, window reloads.
3. Ctrl-C stops all three processes.
4. The Hub's database is `./.sportal/sportal.sqlite`.
5. `rm -rf apps/desktop/node_modules/electron/dist && pnpm install` then `pnpm dev`: Electron runs.
6. `pnpm check` passes.
