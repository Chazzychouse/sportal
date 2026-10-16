# 20. One installable app: the desktop shell runs its own Hub

Date: 2026-10-15
Status: Accepted

Amends the technical spec's "the shell never starts a Hub".

## Context

Running Sportal meant a development checkout: Node 24 and pnpm, a built web UI, a Hub started with `SPORTAL_WEB_ROOT`,
then the shell pointed at it. The goal is a build someone installs and opens, on Linux and Windows.

The shell has to be the castlabs Electron build for Widevine, so a native executable means shipping Electron. The Hub
is plain Node, and Electron already carries Node. Two installers (a Hub service and a shell) would leave a person to
start, find and keep the two in step.

## Decision

The desktop app ships the Hub and the web UI's build as resources and runs the Hub itself.

- The Hub is bundled by Vite into one ES module, `apps/hub/dist/hub.mjs`, every dependency inlined, so it needs no
  `node_modules`. The desktop app does not import it: apps still never import each other.
- `EmbeddedHub` runs it as an Electron utility process for as long as the shell runs, on `SPORTAL_PORT` (4400) on
  every interface, so a phone's Remote and a second Display can still reach it. Its output goes to `hub.log`. If it
  stops on its own, a dialog says so and the app quits.
- `SPORTAL_HUB_URL` still points the shell at a Hub already running, and then it starts none: `pnpm dev`, and a
  second Display on the network, work as before.
- One shell runs at a time on a machine (Electron's single-instance lock), so two never race for the port.
- electron-builder packages an AppImage and a `.deb` for Linux and an NSIS installer for Windows. Windows builds get
  castlabs' VMP signature after any Authenticode signing; Linux has no VMP.

## Consequences

- One download, one icon. The Hub lives and dies with the window.
- A Hub that should outlive the window (a TV box serving several Displays) is still `pnpm --filter @sportal/hub start`
  or a container image of the same bundle, not built yet.
- Windows playback depends on a castlabs EVS account to sign releases; see `docs/release.md`.
