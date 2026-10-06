# 8. The feed log is the truth

Date: 2026-10-05
Status: Accepted

Supersedes ADR 0004.

## Context

ADR 0004 made the latest `GameSnapshot` per game the Hub's state, with events derived and never stored, because a
scoreboard poll can miss or repeat updates and nothing depended on history. Three things have changed: FastCast's
per-game topics carry every play, which is history the scoreboard cannot give back; the Hub should come back from a
restart mid-game as it was; and game days should be recorded without running a script by hand, and kept for later
features.

## Decision

Every frame the feeds deliver (poll responses, FastCast checkpoints and patch batches) is appended raw, in order of
arrival, to the feed log, `feed.sqlite`, and kept forever. Snapshots, plays, live games, watchability, and events are
all derived from it by one fold, and can be derived again. Polls and pushes share the log, ordered by one `seq`.
Design: `docs/history.md`.

Chosen over a durable job queue (`PersistedQueue`): a queue delivers work until it succeeds and then prunes it, which
suits work that must eventually happen, not data the next frame supersedes, and leaves no history.

## Consequences

- A restart replays the current game day; a recorded day replays through the code that ran it live.
- A decode bug reproduces from the log exactly, and a fixed decoder can re-derive past days.
- The log grows by an estimated 5–10 GB a season, mostly poll responses.
- Events are still never stored: they are derived from the log, which is.
