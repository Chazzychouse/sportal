# The poll lists, FastCast plays

2026-10-09. Follows the Hub encapsulation (e8adeb2) and ADR 0014 (one ESPN fold). Recording and replay
(`2026-10-09-recording-and-replay-design.md`) records `Delivery` batches, so it doesn't depend on this.

## The problem

ESPN reaches the Hub by two live feeds that each say how a game is going:

- **The site poll** lists each league's games and is also a live score feed. It polls every 10 s while a game is live,
  every minute near a kickoff, and every 15 minutes otherwise, with a 30 s retry after a failure.
- **FastCast** follows each league's scoreboard topic, whose events are decoded as what they move (`PushedEvent`), and
  each live game's topic, of which only `/entities/plays` is kept.

So `EspnState` merges two sources of the same facts. It keeps a listing advanced by pushes, counts and logs pushes behind
it (`pushBehind`), and drops pushes for a game no listing has. It needs two decoders of an event (`EspnEvent`,
`PushedEvent`) and a per-league poll cadence. The Slate then applies "which snapshot wins" again (`Game#listed`,
`Game#snapshotTaken`).

## What a live probe showed (2026-10-09, FSU @ LOU)

- **The college scoreboard topic can't list the slate.** `event-football-college-football` carries only games with a
  ranked team: 19 of the week's 58 FBS games. It left out the game being played at the time. No FBS-wide topic was
  found; six guessed names each answered `S` with `rc` 404.
- **The game topic carries a game's whole live state.** `gp-football-college-football-401858254` subscribed. Its
  checkpoint had 62 plays and pushes followed (`P` every few seconds, `I` between). The college topic name in
  `Topic.ts` is confirmed. The game package holds:
  - `header.competitions[0].status`: `displayClock`, `period`, and `type` with the same `name`/`state` the site event
    has.
  - `header.competitions[0].competitors[]`: `homeAway`, `score`, `possession`, `timeoutsUsed`, `team`.
  - `entities.plays`: each play with `start`/`end` `{ team, down, distance, yardLine, yardsToEndzone }` and `text`.
  - There's no `situation` object. Down, distance and ball come from the latest play's `end`.
- **Most pushes aren't ours.** In 90 s, most patched `/boxscore`, `/pickcenter` and `/entities/athleteStatistics`, 16
  patched `/header/competitions/0/status`, and a few touched `/entities/plays`.

## The design

**The poll only lists games. FastCast's game topic is each game's only live feed.**

```
 site poll (15 min) ──► Listing ─────────────────────────────┐
                                                             ├─► EspnState ─► Listing / Snapshot / Plays
 FastCast gp-<game> topics ──► header + plays document ──────┘
          ▲
          └── wanted: each listed game live or within its kickoff window
```

### 1. The poll is a listing, on one slow cadence

- Each league polls its site scoreboard every 15 minutes, and 30 s after a poll that failed or didn't decode. The live
  and kickoff-window cadences go. `EspnState#pollInterval` becomes a two-way choice.
- A poll is still its league's `Listing` of every game it shows, as it shows them: teams, kickoff, broadcasts, rank,
  colors, and status and score as the site has them. A listing that lags a pushed score is settled by the Slate as it
  is today (`Game#listed`: a snapshot behind is ignored and the push wins a tie). `Slate.ts` and `Game.ts` don't change.
- `EspnEvent` (the site event decoder) stays. `Frame.Polled`/`PollFailed` and the per-league poll stream stay as they
  are.

### 2. No scoreboard topics

- `Topic.Scoreboard` goes, and so do `DocumentChange.Scoreboard`, `PushedEvent`, `FastCastEvent` in `EspnPayload.ts`,
  the scoreboard branch of `FastCastDocuments`, `movedForward`, `pushBehind` and its counting.
- `Topic` has one case. Unless the plan finds a reason to keep the tagged enum, it becomes a `Data.Class`
  `{ league, game }`, with `tcOf`/`topicOf` as before.
- `EspnState#wanted` is each listed game's topic, live or kicking off within `GameSnapshot.kickoffWindow`, unchanged
  apart from losing the scoreboards.

### 3. A game topic's document is its header and its plays

- `FastCastDocuments` keeps two parts of a game package: `/header/competitions/0` and `/entities/plays`. Patches
  elsewhere are applied to nothing and are not a change. `mid` still advances, so a gap still resets the topic.
- `DocumentChange.Game` carries `{ league, game, header, plays, touched }` and fires when either part changed.
- `EspnState` turns a game change into:
  - `Snapshot`: the listed game advanced by what the header and the latest play move. That's status, period and clock
    from `status`, scores from `competitors[].score`, and the situation from the latest play's `end` (by `Play.order`):
    down (none when below 1, as now), distance, `yardsToEndzone` as the domain's yard line, the possession team, and
    `text` as `lastPlay`. Timeouts come from `competitors[].timeoutsUsed`; see open checks. It's only sent when the
    advanced snapshot differs from the listed game's.
  - `Plays`, when `touched` names a play, as now.
  - A game no listing has still delivers nothing. It can't be wanted, so this only happens around a relisting.
- A new decoder sits beside `EspnPlay.ts` for the header (`GameHeader`, or a name `CONTEXT.md` picks): status,
  competitors, scores and timeouts, read into what a game moves. Its wire spelling goes in `EspnPayload.ts`.
- What a game moves (`Moved` in `EspnEvent.ts`) moves to that decoder's module with `PushedEvent` gone.

### 4. What doesn't change

- `Provider`, `Delivery`, the Slate, the Director, the web and recording and replay.
- `FastCast`'s socket, checkpoint loading, ordered recovery, the 30 s refollow and silence handling.
- One fold over polls and pushes (ADR 0014). The poll frame still sets that league's next poll.
- Retention: after any poll, documents and plays are kept only for wanted topics.

## What goes, in short

`Topic.Scoreboard`, `PushedEvent`, `FastCastEvent`, `DocumentChange.Scoreboard`, `movedForward`, `pushBehind`, the
live and kickoff-window poll cadences, and the scoreboard half of `FastCastDocuments`. `EspnState`'s doc comment loses
its push/listing paragraph.

## Open checks (before or during the plan)

1. **Timeouts.** Is `timeoutsUsed` per half, with remaining = 3 − used (college and NFL both give 3 a half)? Check
   against a recorded halftime or a second-half checkpoint.
2. **Kickoff.** A game topic exists before kickoff: on 2026-10-09, IOWA @ WASH 38 min out and ISU @ BYU about 2 h out
   both checkpointed with `STATUS_SCHEDULED`. Still to confirm: `pre → in` arrives as a `status` patch.
3. **Final.** Does the topic push `STATUS_FINAL` before ESPN stops it? A game leaves `wanted` once it's over, and
   the 15-minute listing would otherwise be the one to say so.
4. **Latest play.** Is the latest play by `Play.order` (sequence) always the one whose `end` is the live situation,
   including after a penalty or a review that rewrites an earlier play?
5. **NFL.** Same header shape on an NFL `gp-` topic. The 2026-10-04 recording (`nfl-2026-10-04-ne-buf.frames.jsonl.gz`)
   has one.

## Docs and tests

- ADR 0016: the poll lists, FastCast plays. It refines ADR 0014's two feeds into a listing feed and a live feed.
- `CONTEXT.md`: **ESPN event** loses `PushedEvent`; **ESPN state** loses the cadence by live games; **Document change**
  becomes a game topic's header and plays, or a reset; add the header decoder's term.
- Fixtures: save a college game checkpoint and a minute of its messages from the probe into `fixtures/`. Re-cut the
  NFL tests from the 2026-10-04 recording's `gp-` topic. Remove the scoreboard-topic fixtures and tests that only
  served `PushedEvent`.
- Game-day checklist: row 45's college `gp-` question is answered. Add rows for open checks 2 and 3 on Saturday.
