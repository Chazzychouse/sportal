# 7. ESPN FastCast is the live feed; the scoreboard poll backs it up

Date: 2026-10-05
Status: Accepted

## Question

Is the data the Hub polls fresh enough for the Director and notifications, and is there a fresher source? This
finishes the feed-fidelity spike of `docs/technical-spec.md` §8, whose lag measurement was never written up.

## What was observed

NFL, 2026-10-04, from the end of the London game through the 1 PM ET window (9 live games). Two throwaway recorders
ran side by side:

- a poller fetching, every 10 s, the site scoreboard and, for each live game, the site summary, ESPN's core-API
  `situation`, and the latest page of core-API plays;
- a FastCast client subscribed to `event-football-nfl` and each game's `gp-football-nfl-<id>` topic.

Lag is the time from a play's `wallclock` (ESPN's stamp of when the snap happened) to the first time each feed
showed that play. Polled feeds are upper bounds: polls were 10 s apart.

| Feed | Plays | Median | p90 |
| --- | ---: | ---: | ---: |
| FastCast push | 382 | **28 s** | **49 s** |
| Core API plays (10 s poll) | 409 | 33 s | 55 s |
| Core API situation (10 s poll) | 408 | 33 s | 56 s |
| Site scoreboard, what the Hub polls (10 s poll) | 403 | 41 s | 61 s |
| Site summary (10 s poll) | 406 | 48 s | 68 s |

(Figures as of 13:48 ET, 409 plays, not refreshed with the full window.)

- FastCast showed a play before the core-API plays on 261 of 300 plays (median +4 s), and before the scoreboard on
  most.
- A push arrives within a fraction of a second of ESPN's own publish stamp on it. The remaining lag is ESPN's,
  between the snap and publishing; no ESPN feed can beat it.
- The CDN caches polled responses for 2–10 s (`max-age`), so polling faster than that returns the same copy.
- FastCast is what espn.com's live pages use: a WebSocket whose host and token come from
  `fastcast.semfs.engsvc.go.com/public/websockethost`, carrying JSON Patch operations against ESPN's scoreboard and
  gamecast documents, with checkpoints on its CDN. Node's built-in `WebSocket` fails its handshake; the `ws` package
  connects.
- Its scoreboard topic carries everything a `GameSnapshot` needs (status, clock, scores, situation, last play); its
  gamecast topics carry drives, plays, win probability, the box score, and highlight clips.

## Decision

The Hub takes live updates from FastCast through a new `LiveFeed` port. Ingest runs it beside the scoreboard poll,
which stays as the source of the whole slate and as the fallback. A pushed game reaches the game actors as its listed
game advanced to the push. Design: `docs/specs/2026-10-05-fastcast-design.md`.

"Connected" (`sportal_live_feed_connected`) means the subscriptions were sent, not that ESPN acknowledged them.

## Consequences

- Fresher snapshots for live games (about 13 s at the median against today's poll).
- The Hub depends on an undocumented feed in addition to undocumented endpoints. When it fails, Ingest logs and counts
  the failure and resubscribes from a checkpoint with backoff, and the poll carries on: the Hub degrades to
  poll-only, rather than breaking.
- Plays and win probability for every live game become affordable later, as patches, instead of 600 KB summaries.
- Recordings and the prototype are kept on the unmerged branch `prototype/feed-lag`.
