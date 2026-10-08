# 13. Scenarios go; offline play is designed again

Date: 2026-10-08
Status: Accepted

Supersedes ADR 0011.

## Context

A scenario let a Hub play a recorded window of a game day in place of ESPN and YouTube TV: its frames replayed at their
offsets through ESPN's decode, on a scenario clock running faster than real time, with every game carried on a
synthetic stream page the web UI drew. It made the Hub's second mode, and the second mode shaped the rest of the code.

- `HubMode` had to choose between two layer graphs, annotated so that a scenario provided everything the live day did.
- `HubConfig` carried a scenario's name and speed.
- The Director ran on a substitute clock.
- `Frame` doubled as a recording format.
- The domain's sources named a synthetic one.
- The shell let provider views load the UI's own pages.
- The web UI resolved stream paths against its own origin.

The scenarios themselves were cut by hand from two recorded days. They were also bound to ESPN's wire format, so they
could only replay what ESPN once said, never make up a day a design needed.

## Decision

Remove scenarios, scenario time and the synthetic stream page, and every constraint they put on the rest of the code.
The Hub has one mode, the live day. The cut recordings in `fixtures/scenarios/` go. The raw game-day recordings in
`fixtures/espn-recordings/` stay as material, as do the recorded frames the ESPN decoder's tests read.

Offline play is designed again from nothing, and the Hub process test returns with it.

## Consequences

- With no game on, `pnpm dev` shows an empty slate until offline play exists again.
- `HubMode`, `HubConfig`, `Telemetry`, `Frame`, `Channel`, the shell's provider session and the web UI's placements are
  each simpler. The Hub dashboard has no mode to filter by.
- Nothing in the code depends on how a recorded day is stored or replayed, so the new design is free to choose.
