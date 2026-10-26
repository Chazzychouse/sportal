# Sportal

A live sports tracker and multi-game viewer. On a football Saturday there are more good games than
screens. Sportal tracks every game as it happens, and arranges the streams you're watching across a
desk, a TV and a phone, all agreeing on what's going on.

It's a personal tool: one person, a few devices on one home network.

## How it fits together

```
ESPN feeds ──► Hub ──── one WebSocket ────► web UI (any browser)
                │                          └► desktop shell (Electron): tiles are the providers' own players
                └─ one in-memory slate of games
```

- **Hub** (`apps/hub`): one server process. It polls ESPN's scoreboard for the day's games and
  takes live updates from ESPN's FastCast push feed (the fastest, measured: `docs/adr/0007`). It
  decodes everything on the way in, folds each delivery into one slate of games, and answers
  requests and live queries over a single WebSocket.
- **Web UI** (`apps/web`): the tracker, in React. It shows scores, game situations, play-by-play,
  team stats, win probability and highlights, and runs in any browser.
- **Desktop shell** (`apps/desktop`): an Electron app whose tiles are the streaming providers' own
  web players. Sportal only positions, tunes and mutes them. It never touches the video, so DRM is
  left alone and nothing is recorded or re-streamed.
- **Packages:** `packages/domain` holds the domain model, as pure functions over Effect Schemas.
  `packages/api` holds the Hub's API contract.

Each domain concept is declared once, as an Effect Schema, and that one declaration is its type,
its decoder and its wire format. `CONTEXT.md` defines every term.

## Run it

Requires Node 24 and pnpm (versions in `mise.toml`).

```sh
pnpm install
pnpm dev     # Hub, web dev server and desktop shell together, reloading on change
```

| Command | What it does |
|---|---|
| `pnpm dev` | Run everything in development; `pnpm dev:x11` runs the shell through XWayland |
| `pnpm --filter @sportal/hub dev` | Only the Hub, on port 4400 |
| `pnpm --filter @sportal/web dev` | Only the web UI, on port 4401, proxying the Hub's socket |
| `pnpm start` | Build, then run the desktop shell with its embedded Hub, as the installed app runs |
| `pnpm package` | Build the installer for this OS into `apps/desktop/release/` |
| `pnpm check` | Format, lint, typecheck, import boundaries, unused code and tests (the push hook runs it) |

Every Hub setting is an environment variable listed in `apps/hub/src/HubConfig.ts`, with its
default. A bad value stops the Hub at startup.

## Docs

- [`docs/product-plan.md`](docs/product-plan.md): what Sportal is for, and what it won't do
- [`docs/technical-spec.md`](docs/technical-spec.md): architecture, key designs and failure behaviour
- [`docs/adr/`](docs/adr/): architecture decision records
- [`CONTEXT.md`](CONTEXT.md): the domain language
- [`AGENTS.md`](AGENTS.md): how code is written here (for people and coding agents alike)
- [`docs/release.md`](docs/release.md): CI and releases

## A note on streaming

Sportal is an unofficial client for streaming services you already pay for, used for personal
viewing. It doesn't defeat DRM, capture or re-stream video, or share credentials. The score data
comes from unofficial feeds that can change without notice.
