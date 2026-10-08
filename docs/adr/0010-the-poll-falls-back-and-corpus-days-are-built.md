# 10. The poll falls back to the push; corpus days are built

Date: 2026-10-07
Status: Superseded: its corpus half by ADR 0011, its poll fallback by ADR 0012

Amends ADR 0008 and ADR 0009.

## Context

The push (FastCast) and the poll (the scoreboard) both wrote a game's snapshot, and a tie rule settled between them:
the push won a tie. The rule was a consequence of the design, not something wanted. The Director must be tuned and
regression-tested against hundreds of days in seconds, and the only way to replay a day was the live path: ESPN's
frames, the stateful FastCast decode, and the Hub's timer. Two recorded days existed, and capture adds one weekend a
week.

## Decision

- **The poll and the push have separate roles.** The push gives live games' snapshots and plays. The poll gives
  listings: the slate, upcoming and final games, broadcasts.
- **A covered game holds a poll snapshot ahead of it for `fallbackAfter` (15 s), replacing the tie rule.** A game is
  covered when its snapshot came from the push. A poll is ahead when it is later in game time, or at the same game
  time has more total points, or at equal totals has a different split: the clock stops on a score, so only points
  say which snapshot is newer. Game time puts halftime after play at the same clock and ties any other status-only
  difference, so no two snapshots are ahead of each other on their status alone. A covered game ignores a poll with fewer points. The held snapshot applies when
  `fallbackAfter` passes and the push has not caught it up, and says its events. A dropped push is a stuck one; the
  hold covers it.
- **Each event kind has one origin.** State events come from snapshot changes and play events from plays, each said
  once; summary plays take their team from `end.team`, as FastCast does.
- **The fold is the slate.** The pure `Slate` is the only thing that combines the two feeds; it returns its game
  events and, apart, observations for telemetry. It remembers each game it saw finish, so a lagging poll cannot
  start it again: only a snapshot later on the clock than the final, whatever its status, or at the same clock with
  more points, is past it, so overtime after a spurious final or a postponed game resuming starts it again. The final
  is forgotten when no listing names it. The Hub's one `Slate` service runs it live.
- **Corpus days are build products, rebuilt rather than migrated.** A day is two typed files, poll and push lines,
  built from the feed log (captured) or synthesized from the archive of ESPN's finished games (backfilled), and played
  through the slate on virtual time by `corpus run`. A decoder or format change rebuilds days; nothing is migrated.
  A backfill never overwrites a captured day, refuses a date that is not over, and archives a 404 or 410 summary as a
  refusal so its game is skipped. A timeout's caller is read from ESPN's text by the adapter and matched per game;
  `Play` stays identical across feeds.
- **The truth is the feed log and the archive.** Amending ADR 0008: the feed log is the truth of what the Hub saw
  live; the archive is the truth of what ESPN gave afterwards. Both are raw.

## Consequences

- A corpus run replays as the Hub played live, and tests assert it: 3880 events in 1.0 s.
- A captured day builds in about 1.8 s and runs in about 100 ms on one worker. A backfilled NFL weekend
  (2026-09-13..14, 14 games) fetches and builds in 10.5 s, and again from the archive in 2.4 s.
- `corpus` commands exit nonzero (`DaysFailed`) when a day fails.
- `fallbackAfter` is a guess the corpus can now tune; `sportal_poll_fallbacks` shows how often it fires live.
- A correction that lowers a score reaches a covered game by the push, not the poll.
- The archive and corpus grow with seasons, outside the feed log.
