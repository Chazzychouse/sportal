# 17. The Hub relays for Remotes

Date: 2026-10-10
Status: Accepted.

## Context

Each Display owns its Screen (ADR 0015), and its prompts are its own too. A phone must still be able to control one
Display: see what it shows, change its layout and tiles, and answer its prompt from the couch.

## Decision

The Hub relays a Display's report to its Remotes and their inputs to it, in memory, without decoding either. The web
app owns both schemas: the Remote report (the Screen, the autopilot, the prompts and the prompt shown) and the Remote
input. A Remote sends inputs, screen commands and hotkeys, that the Display applies as its own, as if pressed on it.

## Consequences

There is no Screen code in `packages/api` or the Hub. A Display that is offline cannot be controlled: its Remotes say
so and wait. Nothing survives a Hub restart; a Display reports again when its input stream reopens. Push to a locked
phone needs HTTPS, which the home network's plain HTTP does not have, so it is not done: the Remote chimes only while
its page is open.
