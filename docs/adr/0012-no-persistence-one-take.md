# 12. No persistence for now; the slate takes each frame as it arrives

Date: 2026-10-08
Status: Accepted

Supersedes ADR 0008, the poll fallback of ADR 0010, and the feed-log half of ADR 0011. Amends ADR 0009.

## Context

ADR 0008 logged every frame raw to `feed.sqlite` so a restarted Hub could replay its day, a decode bug could be
reproduced, and recorded days could be played back. ADR 0010 made a game the push covers hold a poll snapshot ahead of
it for `fallbackAfter`, and ADR 0011 made every day the feed log recorded a scenario. Around them grew an
`Acknowledgement` per game (its source, when it was heard, a held poll), states derived from it (holding, stale), a
timer that ticked the slate, slate and decode observations, and the metrics that counted them.

None of it paid its way. In every recorded day the hold never fired: every take was `taken`, never held or fallen
back. A restart mid-game is rare, and the next poll gives the slate back in seconds. The feed log, its writer, gaps and
replay boundary, the data directory, the decode telemetry and the stale and fallback metrics were weight carried for
behaviour nobody needed, and each made the model harder to change.

## Decision

- **For now, the Hub keeps nothing between runs.** No feed log, no SQLite, no data directory (`SPORTAL_DATA_DIR` is gone). A
  restarted Hub starts from an empty slate and its provider's next poll fills it.
- **The provider decodes its own frames.** The `Provider` port is `deliveries: Stream<ReadonlyArray<Delivery>>`, each
  frame's deliveries in order. ESPN reads its polls and FastCast frames with `EspnDecoder.decode`; a scenario plays
  its recorded frames through the same decode.
- **The slate takes each frame as it arrives.** The `Slate` is each league's listed games, each as its latest
  snapshot, and each game's plays; `take(deliveries)` returns the next slate. A snapshot behind its game (earlier in
  game time, or at the same game time with fewer points) is ignored, except that an over game takes one ahead of its
  end; there is no acknowledgement, hold, fallback, staleness, timer or tick.
- **Game events are gone.** Nothing read them; the planned Producer derives them again from snapshot changes and plays.
- **Scenarios are recordings only**: `fixtures/scenarios/<name>.frames.jsonl.gz`. A game day by date is not a scenario.
- **Telemetry keeps what is solid**: poll duration, provider errors, FastCast's connection, connects, errors and
  checkpoint failures, the `EspnProvider.pollEveryLeague` and `Board.take` spans, and logs. A frame that does not decode and a FastCast topic
  that loses its document are Warning logs. The Board logs only a take that raised a defect, and frames that stop.

## Consequences

- The Hub's state is again the latest snapshot per game, as ADR 0004 had it, plus each game's plays.
- A restart loses the day's plays until the push resends them, and the slate is empty until the next poll.
- A decode bug can no longer be replayed from the Hub's own log; a recording is captured on purpose instead.
- A game the push stops updating keeps its last snapshot until a poll is not behind it; nothing marks it stale.
- Persistence is added back once the model is simple, on top of it, as a decision of its own; this record does not
  design it.
