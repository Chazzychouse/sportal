# Hub Foundations — Design

Date: 2026-10-04
Status: Approved 2026-10-04

Piece 1 of the hardening work that comes before hosting and sharing Sportal. The pieces, in order:

1. **Hub foundations** (this design)
2. Your deployment: a multi-arch Hub image, `compose.yaml` with a Tailscale sidecar on an always-on box at home,
   `https://sportal.<tailnet>.ts.net`, backups
3. Device pairing: per-device credentials, QR pairing, revoke
4. Open-source readiness: GitHub remote, CI on Linux, macOS, and Windows, README, license
5. Packaged app: the shell runs its own Hub in a `utilityProcess`; VMP-signed installers for all three OSes

## Goal

The Hub can be run by someone other than its author, on any of the three desktop OSes, and left running on a box
at home. Concretely:

- Every setting the Hub reads is declared in one place, `HubConfig`, and an invalid one stops the Hub at startup
  with a message naming it.
- With no settings at all, the Hub keeps its data where the OS expects application data, not in whatever directory
  it was started from.
- `pnpm install`, `pnpm dev`, and `pnpm check` behave the same in bash, fish, PowerShell, and `cmd`.
- A supervisor (Docker, systemd) can ask the Hub whether it is up, and stop it cleanly within a few seconds,
  even with Displays connected.
- The live stream survives a proxy that drops idle connections (`tailscale serve`, a phone's mobile network).

## Today

| Gap | Where |
| --- | --- |
| Settings are read inline in `main.ts`; `HubConfig.ts`, named in the technical spec, does not exist | `apps/hub/src/main.ts` |
| The default data directory is `.sportal` relative to the working directory | `main.ts`: `Config.withDefault(".sportal")` |
| Scripts use POSIX shell syntax (`VAR=x cmd`, `${VAR:-default}`, `$VAR`), which `cmd` and PowerShell do not understand | root, `apps/hub`, `apps/desktop` `package.json` |
| No line-ending policy; a Windows checkout with `core.autocrlf=true` turns every file CRLF and Biome's format check fails | no `.gitattributes` |
| Nothing but mise pins Node and pnpm; a contributor without mise gets whatever they have | no `packageManager` or `engines` |
| No way to ask the Hub whether it is up | `SportalApi` |
| On SIGTERM, the HTTP server waits up to its default 20 s for open connections. Every connected Display holds an SSE connection open, so Docker's 10 s stop timeout kills the Hub mid-shutdown | `NodeHttpServer.layer` options |
| The live stream sends nothing between changes; in a quiet stretch an idle-timeout proxy closes it | `HubServer.liveRoute` |
| Log level and format are fixed | — |

## Decisions

| Question | Decision |
| --- | --- |
| Where settings are read | `apps/hub/src/HubConfig.ts` exports `HubConfig`, a `Context.Service` whose value is every Hub setting, decoded once from `Config`, and its `layer`. `main.ts` reads `HubConfig` and passes values to the layers that need them, as it does today. No other Hub file reads `Config` or `process.env` (the `scenario:cut` dev tool, which is not the Hub, keeps its `INIT_CWD`) |
| The settings | `SPORTAL_PORT` (4400), `SPORTAL_HOST` (`0.0.0.0`), `SPORTAL_WEB_ROOT` (none), `SPORTAL_DATA_DIR` (the OS default, below), `SPORTAL_SCENARIO` (none), `SPORTAL_SCENARIO_SPEED` (1, finite and above 0), `SPORTAL_LOG_LEVEL` (`Info`), `SPORTAL_LOG_FORMAT` (`pretty` or `json`, default `pretty`), `SPORTAL_VERSION` (`dev`). Names and defaults that exist today are unchanged |
| A bad setting | The Hub stops before it opens a port or a database, and the error names the variable and what it accepts. This is what Effect's `Config` errors already say; `HubConfig` adds no wrapper |
| Default data directory | Linux: `$XDG_DATA_HOME/sportal`, else `~/.local/share/sportal`. macOS: `~/Library/Application Support/Sportal`. Windows: `%LOCALAPPDATA%\Sportal`, else `~\AppData\Local\Sportal`. `HubConfig` computes it from `process.platform`, with `HOME` (`USERPROFILE` on Windows), `XDG_DATA_HOME`, and `LOCALAPPDATA` read through `Config` and joined with Effect's `Path`, so tests cover each OS by giving the variables and a POSIX or Windows `Path`. Local, not roaming, on Windows: the database must not sync between machines |
| Composition root | `main.ts` is the Hub's layer pipe and nothing else. What it composed by hand moves to modules of its own, each a layer that yields `HubConfig` for the settings it needs: **`HubMode.ts`** (the live day from ESPN and YouTube TV, or a scenario in their place; it becomes the only file that names providers and sources, and the dependency-cruiser rule moves with it), **`Logging.ts`** (level and format), **`HubServer.serve`** (every route and the built web UI, on `host:port`), and **`Database.inDataDir`** (which creates the data directory). A service or setting is yielded where it is used, never passed as an argument; `StageSessions` stops passing its services to a helper |
| Dev data | Unchanged: `pnpm dev` keeps using the repo-root `.sportal/`, through the existing `SPORTAL_DATA_DIR` default in the Hub's `dev` script. The container (piece 2) sets `/data`; the packaged app (piece 5) sets Electron's `userData` |
| Scripts on Windows | `shellEmulator: true` in `pnpm-workspace.yaml`. pnpm then runs every script through its own cross-platform shell, which understands `VAR=x cmd`, `${VAR:-default}`, and `$VAR` on every OS, so the existing scripts stay as they are. `pnpm dev:x11` still applies only on Linux, which is the only place it means anything |
| Line endings | `.gitattributes`: `* text=auto eol=lf`, with the recorded fixtures and scenario slices marked `-diff` so they do not flood diffs. Every checkout gets LF regardless of the user's git settings |
| Toolchain pins for people without mise | Root `package.json` gains `"packageManager": "pnpm@12.8.1"` and `"engines": { "node": ">=24" }`. `mise.toml` stays the primary pin and is changed to the same exact pnpm version |
| Path handling | An audit of the Hub, the shell, and their tests for paths built by string joining or split on `/`, file paths compared as strings, and hard-coded `/tmp`. Anything found uses `node:path` or `FileSystem`. URL paths (`/scenario-stream/…`) are URLs and stay `/` |
| Health | `GET /api/health` in the `host` group of `SportalApi` returns `{ version, startedAt }` (the `SPORTAL_VERSION` setting and the instant the Hub finished starting). It answers 200 whenever the Hub is serving, and needs no request body. The response shape is written inline in the endpoint and is not a named type. In piece 3 it is one of the few routes that stays open without a device credential, so a supervisor can call it |
| What health does not say | Whether ESPN is answering. Ingest already logs every provider failure, and a Hub that cannot reach ESPN is still up and must not be restarted for it. Per-league freshness can be added to health later if logs turn out not to be enough |
| Stopping | `NodeRuntime.runMain` already turns SIGINT and SIGTERM into interruption, which closes the server, ends every live stream, stops Ingest, and closes the database. The change: `NodeHttpServer.layer` gets `gracefulShutdownTimeout: "3 seconds"`, so open SSE connections cannot hold shutdown past Docker's 10 s. The clients reconnect to the next Hub by themselves (`EventSource`) |
| A clean stop leaves the database clean | `node:sqlite` checkpoints the WAL and removes `-wal` and `-shm` when the last connection closes. After a clean stop the data directory holds only `sportal.sqlite`, which is what makes a file-level backup safe in piece 2 |
| Live stream keep-alive | `liveRoute` merges a comment line (`: keep-alive\n\n`) every 20 seconds into the stream. `EventSource` ignores comment lines, so the web UI does not change. 20 s is under every common idle timeout (nginx and most load balancers 60 s, mobile carriers usually 30 s or more) |
| Log level | `SPORTAL_LOG_LEVEL` sets the minimum level for the whole Hub (`References.MinimumLogLevel`), one of Effect's level names |
| Log format | `pretty` is Effect's console logger, as today. `json` is `Logger.consoleJson`, one object per line, for `docker logs` and anything that ships logs (Loki later, if wanted) |

## Not in this piece

- Authentication of any kind (piece 3). Until then the Hub is as open as it is today.
- The container image, the compose file, backups, and the box (piece 2).
- CI, and so any proof on real Windows and macOS machines (piece 4). This piece is verified on Linux; the
  cross-platform choices above are the ones that need no Windows or macOS machine to be correct, and piece 4's CI
  matrix is where they are proved.
- Postgres. The technical spec keeps it as the cloud option; nothing about running at home needs it.
- Anything in the desktop shell. Its one setting, `SPORTAL_HUB_URL`, is already read through `Config`.

## Testing

| What | How |
| --- | --- |
| `HubConfig` | Unit tests with a `ConfigProvider` built from a plain record: defaults with nothing set; each setting read; a bad port, a zero or `NaN` speed, an unknown log level, and an unknown log format each fail and name the variable |
| Default data directory | Unit tests of the computation for each platform, with the platform, home, and the two environment variables given as inputs, so Linux, macOS, and Windows are all covered on a Linux machine |
| Health | A `HubServer.test.ts` case through the existing handler harness: 200, the configured version, and `startedAt` from the test clock |
| Keep-alive | A `HubServer.test.ts` case under the test clock: with no changes, advancing 20 s yields one comment line; a change still arrives at once |
| Clean stop | One test that starts the real Hub (`node src/main.ts`) as a child process with a temporary data directory and a free port, waits for `/api/health`, opens `/api/live`, sends SIGTERM, and asserts that the process exits with code 0 within 5 seconds and the data directory holds no `-wal` or `-shm` file. Skipped on Windows, where a child cannot be sent SIGTERM; Ctrl-C in a terminal is SIGINT there and takes the same path |
| Scripts | `pnpm dev`, `pnpm check`, and `pnpm dev:x11` run on Linux with `shellEmulator` on and behave as before |

## Documents that change

- `CONTEXT.md`: rows for **Hub config**, the Hub's settings, read once from the environment, and **Hub mode**, the live day or a scenario.
- `AGENTS.md`: the commands section names the default data directory for each OS and lists the new settings.
- `docs/technical-spec.md`: §4.1 rule 9, the §4.2 tree, and §5.1 say `HubMode.ts`, not `main.ts`, names the adapters.
