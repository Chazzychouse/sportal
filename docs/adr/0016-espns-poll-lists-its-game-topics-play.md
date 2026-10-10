# 16. ESPN's poll lists, its game topics play

Date: 2026-10-09
Status: Accepted

Supersedes ADR 0014's one ESPN fold and typed poll frames. ADR 0014's "FastCast follows what it is told" still stands.

## Context

The poll and FastCast's scoreboard topic said the same facts: each game's listing, status and score. The poll could not
be dropped for the topic. The college scoreboard topic carries only ranked games (19 of 58 on 2026-10-09, and it missed
a live unranked game). Keeping both meant a second decoder for pushed events, a rule for a push behind its listed game
and for a tie between a poll and a push, a metric and dashboard panel counting how often a push was behind, and one fold
(`EspnState`) that kept the two overlapping feeds in order.

## Decision

- **FastCast follows only game topics, for plays.** The topic of each listed game live or within 30 minutes of kickoff;
  no league's scoreboard topic.
- **The poll is each game's listing, status and score.** Each league polls on its own loop, with its own last good
  listing and its own wait after each poll: about 10 seconds while it has a live game, a minute while a game kicks off
  within 30 minutes, 15 minutes otherwise, and at most 30 seconds after a poll that failed or did not decode.
- **The poll and the game topics run on their own.** `GameTopics` folds FastCast's frames into each topic's document and
  its plays. The two meet only in the listings, which say which topics are wanted. After each listing, `GameTopics`
  keeps nothing for a topic no longer wanted (`retainedFor`).
- **Listings are the only snapshots.** Nothing pushes a snapshot, so no rule orders a push against a poll:
  `Delivery.Snapshot`, `Game#listed` and `GameSnapshot#tiesLive` are gone. A listing is taken into the slate's game
  unless it is behind it (`Game#snapshotTaken`).

- **FastCast follows what it is told.** (From ADR 0014, unchanged.) `FastCast.follow(wanted)` reconciles each socket
  toward the wanted set: it follows each topic newly wanted and each whose document went back to waiting for its
  checkpoint, and leaves each no longer wanted. `GameTopics` logs a lost document when it resets the topic.

## Consequences

- A live score moves with the poll, about every 10 seconds; plays arrive by push.
- ESPN has one event decoder, the site scoreboard's. `PushedEvent`, `FastCastEvent`, `Topic.Scoreboard` and `EspnState`
  are gone; `Frame` is FastCast's frames only, and a document change is a game's plays or a reset.
- The `sportal_push_behind_listing` metric and its dashboard panel are gone; no pushed snapshot can be behind a listing.
- The tie rule is gone. It compared two polls and kept the older at the same clock and score, which hid a new down and
  ball.
- Reading each game topic's header could make it the live score feed later. It is not done: it adds about as much code
  as this removes.
