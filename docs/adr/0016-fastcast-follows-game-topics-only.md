# 16. FastCast follows game topics only

Date: 2026-10-09
Status: Accepted

Refines ADR 0014 (one ESPN fold).

## Context

The poll and FastCast's scoreboard topic said the same facts: each game's listing, status and score. The poll could not
be dropped for the topic. The college scoreboard topic carries only ranked games (19 of 58 on 2026-10-09, and it missed
a live unranked game), so it could not replace the poll. Keeping both meant a second decoder for pushed events, a rule
for a push behind its listed game, and a metric and dashboard panel counting how often that happened.

## Decision

- **FastCast follows only game topics, for plays.** The topic of each listed game live or within 30 minutes of kickoff,
  as ADR 0014 had it; no league's scoreboard topic.
- **The poll stays each game's listing, status and score,** on its current cadence: about every 10 seconds while a
  league has a live game, every minute near a kickoff, every 15 minutes otherwise, at most 30 seconds after a failure.

## Consequences

- A live score moves with the poll, about every 10 seconds; plays arrive by push.
- ESPN has one event decoder, the site scoreboard's. `PushedEvent`, `FastCastEvent` and `Topic.Scoreboard` are gone,
  and a document change is a game's plays or a reset.
- The `sportal_push_behind_listing` metric and its dashboard panel are gone; no pushed snapshot can be behind a listing.
- ADR 0014's one fold stands.
- Reading each game topic's header could make it the live score feed later. It is not done: it adds about as much code
  as this removes.
