# 9. One fold over the feed log, not actors

Amended by ADR 0010: the fold is the slate. Amended by ADR 0012: the slate takes the provider's decoded frames as they
arrive, with no feed log, replay, timer or hold.

Date: 2026-10-05
Status: Accepted

Supersedes ADR 0006.

## Context

ADR 0006 made each game an `effect/cluster` entity. What the Hub used from cluster was per-entity serial handling,
idle passivation, and keep-alive; to get them it composed a single-process cluster with no-op runners, in-memory
message storage only because keep-alive persists, a shard-acquisition wait, a pinned termination timeout, and
guarded handlers, on an API marked unstable. Requests in flight to one entity were not served in the order sent.

With the feed log (ADR 0008), live, restart, and replay should give the same games from the same frames, which needs
one order.

## Decision

One fiber folds the deliveries decoded from the feed log, in `seq` order, into a `Map<GameId, LiveGame>`. `LiveGame`
is pure: `take(delivery, now)` and `tick(now)` return the next live game and its events. The fold's `now` is each
frame's receive time, and one timer wakes it at the earliest time any game changes without a delivery. All I/O is
outside the fold.

## Consequences

- `effect/cluster` and its settings leave the Hub.
- Replaying the same log gives the same live games, events, and watchability, so tests and tuning can replay days.
- Peak load is tens of deliveries a second and each is microseconds of pure work, so one fiber is not a bottleneck.
  Slow per-game work belongs after the fold, never in it.
- Running several Hubs is no longer something the design leans towards; nothing planned needs it.
