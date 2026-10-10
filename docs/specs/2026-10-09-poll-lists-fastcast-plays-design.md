# FastCast follows game topics only

2026-10-09. Follows the Hub encapsulation (e8adeb2) and ADR 0014 (one ESPN fold). Recording and replay
(`2026-10-09-recording-and-replay-design.md`) records `Delivery` batches, so it doesn't depend on this.

Revised the same day: the first draft also made each game topic's header the live score feed and slowed the poll to a
15-minute listing. That moved code more than it removed it, so it is dropped. See "Not doing" below.

## The problem

ESPN reaches the Hub by two feeds that both say how a game is going:

- **The site poll** lists each league's games and, every 10 s while one is live, their status, clock, scores and
  situation.
- **FastCast** follows each league's scoreboard topic, whose events are decoded as what they move (`PushedEvent`), and
  each live game's topic, of which only `/entities/plays` is kept.

The poll and the scoreboard topic say the same facts. Keeping both costs a second event decoder (`PushedEvent`,
`FastCastEvent`), a scoreboard half of `FastCastDocuments` (uid-prefixed paths, whole-event patches, its checkpoint
schema), `EspnState`'s `movedForward` with push-behind logging and its metric and dashboard panel, and a second case of
`Topic`.

## What a live probe showed (2026-10-09, FSU @ LOU)

- **The college scoreboard topic can't list the slate.** `event-football-college-football` carries only games with a
  ranked team: 19 of the week's 58 FBS games. It left out the game being played at the time. No FBS-wide topic was
  found; six guessed names each answered `S` with `rc` 404.
- **College game topics work.** `gp-football-college-football-401858254` subscribed, checkpointed with 62 plays, and
  pushed every few seconds. The college topic name in `Topic.ts` is confirmed.

## The design

**The poll is each game's status and score; FastCast is each game's plays.**

- FastCast follows only game topics: each listed game live or within `GameSnapshot.kickoffWindow` of kickoff, as now.
- `Topic` has one case. It becomes a `Data.Class` `{ league, game }` with `tc()` and `static fromTc(tc)`.
- Patch paths are plain JSON Pointers into the game package (the uid prefix was the scoreboard's).
- `FastCastMessage.Checkpoint` is one schema, the game checkpoint, with no `topic` argument.
- `FastCastDocuments` keeps game documents only; `DocumentChange` is `Game` or `Reset`.
- `EspnState` loses the scoreboard branch, `movedForward`, `pushBehind` and `sportal_push_behind_listing`;
  `wanted` lists game topics only.
- `PushedEvent`, `Moved` and `FastCastEvent` go. The dashboard's push-behind panel goes.

Unchanged: the poll and its cadence (10 s while a league has a live game, a minute near a kickoff, 15 minutes
otherwise, 30 s after a failure), `Provider`, `Delivery`, the Slate, the Director, the web, FastCast's socket and
recovery, the one fold, retention after polls.

A live game's score and clock now move with the poll, about every 10 s, not with a push; its plays still arrive by
push. The Slate's existing rule (`Game#listed`) already orders a poll against what it had.

## Not doing

Reading each game topic's `header.competitions[0]` (status, scores, `timeoutsUsed`, `possession`) and deriving the
situation from the latest play's `end` would make the game topic the live score feed and let the poll slow to a
15-minute listing. It needs a header decoder, `Situation.after`, and a snapshot path in `EspnState`: about as much code
as this change removes. Revisit only if the 10 s score lag shows on a game day. The probe's findings for it (header
shape, pre-kickoff headers without period or clock) are in memory, not here.

## Docs and tests

- ADR 0016: FastCast follows game topics only. Refines ADR 0014.
- `CONTEXT.md`: **ESPN event**, **ESPN state** and **Document change** lose the scoreboard topic.
- Tests: scoreboard-topic tests go; document tests (gaps, resets, copies, undecodable messages) move to a game topic.
  A recorded college checkpoint (`fixtures/fbs-gp-checkpoint-2026-10-10T0022Z.json`) shows college plays decode.
- Game-day checklist: row 45's college `gp-` question is answered.

## Follow-on (agreed 2026-10-09)

With no scoreboard topic, nothing pushes a snapshot, and the poll and FastCast never say the same fact. So:

- **Listings are the only snapshots.** `Delivery.Snapshot`, `Game#listed` and `GameSnapshot#tiesLive` go. The tie rule
  now compared two polls and kept the older one at the same clock and score, hiding a new down and ball.
- **The poll and the game topics run on their own.** `EspnState`, the one fold that kept two overlapping feeds in order,
  splits: each league's poll is a loop with its own listing and cadence; `GameTopics` folds FastCast frames into
  documents and plays. They meet only in the listings that say which topics are wanted. ADR 0014 is superseded.
