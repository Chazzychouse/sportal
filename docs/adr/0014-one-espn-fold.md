# 14. One ESPN fold; FastCast follows what it is told

Date: 2026-10-09
Status: Superseded by 0016.

Amends ADR 0007 (the FastCast live feed).

## Context

ESPN's frames were folded four times. The poll's schedule kept the games each scoreboard last showed, to pace the next
poll. ESPN's decode kept each league's listing and every FastCast document, to decode pushes. FastCast folded the same
documents again, and decoded the scoreboards again, to decide which game topics to follow. The slate held the result.
Polling and steering answered "what is live or about to kick off" from separate states that could disagree, and every
pushed frame was patched twice.

## Decision

- **One fold.** `EspnState` holds each topic's document and each league's listed games, as its last poll listed
  them, and each push since (a push behind its listed game is logged and counted on `sportal_push_behind_listing`; removed by 0016).
  `EspnProvider` keeps it in one `SubscriptionRef` and takes every polled and pushed frame into it once. Deliveries,
  the wait after each poll, and the topics FastCast follows are all read from it.
- **FastCast follows what it is told.** `FastCast.follow(wanted)` reconciles each socket toward the wanted set. It
  follows each topic newly wanted and each whose document went from synced back to waiting for its checkpoint, and
  leaves each no longer wanted. It decodes only envelopes and checkpoints, to frame them; it no longer folds or decodes
  games.
- **Typed at the edge.** Frames (`Polled`, `Pushed`, `Checkpoint`) and topics (`Scoreboard`, `Game`) are tagged
  enums, read once where they arrive.

## Consequences

- A push that shows a game live paces the next poll's wait. A poll lagging a push does not set the pushed game back in
  the listing (`Game#listed`'s rule).
- A push behind its listed game is still taken into the listing for now; it is logged and counted
  (`sportal_push_behind_listing`) so game days show how often it happens (removed by 0016).
- FastCast follows only games a poll has listed; before the first poll it follows only the scoreboards.
- A lost document is logged by the fold, which knows why; FastCast logs only that it follows the topic again.
- FastCast no longer needs `HubConfig`: the wanted set carries the scoreboards.
