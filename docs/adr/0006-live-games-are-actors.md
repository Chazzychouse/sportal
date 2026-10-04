# 6. Live games are volatile `effect/cluster` entities

Date: 2026-10-04
Status: Accepted

## Context

The Hub is about to take a second source of game data (ESPN FastCast) beside the scoreboard poll, and the Director
will need per-game timers. That needs one owner per game for its state, its freshness, and its failures: an actor
per game.

A spike (branch `spike/game-actors`, never merged) replayed the real FastCast recording of 2026-10-04 (2,195 messages,
9 games) through two runtimes, `effect/cluster` entities and hand-rolled `RcMap` + `Queue` actors, and checked both
against a plain fold. Both were correct. What it found about cluster:

- Persisted messages cost about three SQL writes per message, grow without bound, and a message whose handler dies
  is replayed on every start. Volatile messages cost no SQL.
- The defaults are wrong for game actors: a defect is fatal and leaves the sender waiting, and the idle time is a
  minute. `disableFatalDefects`, a guarded handler, `maxIdleTime`, and `keepAlive` fix each.
- `SingleRunner.layer` reads `HOST` and `PORT` from the environment.
- One entity's requests are served one at a time but not in the order they were sent when several are in flight.

## Decision

Each game is an `effect/cluster` entity, `Game`, keyed by game id, with one volatile RPC carrying a whole
`GameSnapshot`. The entity holds a `LiveGame` in memory and stores nothing. The cluster is single-process, composed
from cluster's public layers with in-memory message storage, so it writes nothing to disk and reads no environment.
In-memory storage, not no-op storage, because `Entity.keepAlive` sends a persisted message, and with no-op storage that
send dies. Volatile snapshots never touch the storage; each keep-alive adds one small entry, gone on restart. The
composition sets two things explicitly: `entityTerminationTimeout` to 1 second, since the 15-second default alone would
break the Hub's 3-second shutdown bound, and `simulateRemoteSerialization` off, since snapshots never leave the process.

Snapshots are ordered by game time (how far the game has got), not by arrival or by feed, so actors never know which
feed sent a snapshot. Design: `docs/specs/2026-10-04-game-actors-design.md`.

Chosen over hand-rolled actors for cluster's entity model: lifecycle, idle passivation, keep-alive, and
per-entity serial handling come with it rather than being written and maintained here.

## Consequences

- Each game's state, timer, failures, and lifecycle are its own; the behaviour is a pure, test-first domain type.
- Nothing survives a restart, by design: every snapshot is whole and the next poll brings a game back. Telemetry is
  the record of what a game went through, so the Hub's telemetry comes first.
- The Hub depends on an API marked unstable. Every setting it relies on is pinned by a test.
- Running several Hub processes later is cluster's home ground; the Hub stays single-process by its composition.
- Supersedes the unmerged ADRs on branch `live-feed-design`, which chose persisted messages.
