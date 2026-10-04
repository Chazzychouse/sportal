# Game Events and Watchability — Design

Date: 2026-10-03
Status: Approved 2026-10-03

Piece 2 of [the Director design](2026-10-03-director-design.md). Builds on [scenarios](2026-10-03-scenarios-design.md).

## Goal

Know, for every live game at every poll, how worth watching it is right now, whether it is in a lull, and why — in
a form the Director (piece 3) can rank and quote, and that can be tuned by watching a scenario play. The score rises
on signals that a big moment is coming, not only after it happens.

## Decisions

| Question | Decision |
| --- | --- |
| What ranks highest | Late and close first: one score or less late in Q4, or overtime. Then field position (scoring range, red zone, goal to go, fourth down, two-minute drill). Then stakes (ranked teams, upsets brewing) |
| Anticipation | The climb starts when a drive reaches the opponent's 40 (`yardLine` ≤ 40) in a game where a score would take, tie, or change the lead, and rises again at the 20, at goal to go, on fourth down, and in the two-minute drill. Field-position credit only counts in such a game: a 38–10 drive in the red zone earns little |
| Where memory lives | In `Watchability` itself. A lull needs history (the clock stopped for a while), so each game's watchability is folded forward: `Watchability.next(previous, snapshot, events, now)` returns the new one. Pure; a scenario folds through it in a test with no Hub |
| Score | 0–100, the sum of capped parts: closeness by time left (largest), situation, stakes, and a short recency boost after a score or turnover. A game that is not live (`GameSnapshot#isLive` false) scores 0 |
| Lull | Halftime, `delayed`, or a 0:00 clock between periods; for 90 s after a timeout, a score, or a change of possession that is not a turnover (TV breaks), ended early by a new last play; or the clock unchanged with no new last play for 45 s or more. A game in a lull keeps its score; the Director treats it as unavailable |
| Reasons | Each watchability carries its reasons as short text in score order ("one-score Q4, 2:10", "goal to go at the 3", "upset brewing: VAN leads #3 ALA"), for the Director's reason chip and the strip tooltip |
| Events | `GameEvent.diff(previous, next)`: `ScoreChanged`, `EnteredRedZone`, `Turnover` (see the next row), `PeriodEnded`, `WentFinal`, `ReachedScoringRange`, `GoalToGo`, `FourthDown`, `TwoMinuteDrill`, `Overtime`, `TimeoutTaken`, `WentToHalftime` |
| Turnover | Possession changes with no score and the previous play was not a fourth down or a punt/kick (from `lastPlay` text); a change after a score or a punt is a change of possession, not a turnover. Unreadable cases count as a change of possession |
| Follows | Not in this piece; they do not exist yet. The score has no follow term until they do |
| Clock | The Hub folds on Ingest's clock: real time on a game day, scenario time in a scenario, so the 90 s and 45 s windows scale with the speed |
| Hub | A `Watch` service follows Ingest's slate changes, diffs each game's previous and new snapshot, folds its watchability, keeps the latest per game, and publishes them. The Director reads it in piece 3 |
| Wire | `SlateChanged` carries `watchability` beside `slate`: the domain `Watchability` as is, one per live game. No copy type |
| Web | Each live strip card shows a small score badge, dimmed in a lull, with the reasons as its tooltip. The synthetic stream page shows the score and reasons under the scorebug. The strip's order does not change |
| Tuning | Every weight and window is a named constant beside the code that uses it. Scenario tests pin orderings, not exact numbers, so tuning does not churn them |
| Not in scope | Follows, alerts, the Director, the decision advisor, re-sorting the strip, win probability (not in the scoreboard feed) |

## Code

- **Domain.** `GameEvent.ts`: the `GameEvent` tagged enum and `GameEvent.diff`. `Watchability.ts`: the `Watchability`
  class (`game`, `score`, `lull`, `reasons`, and what it remembers: when the clock or last play last changed, and
  recent events with their instants) with `Watchability.next` and `Watchability.initial(snapshot, now)`. Both
  test-first against test games; `Watchability.test.ts` also folds each written scenario and the recorded slice.
- **Hub.** `watch/Watch.ts`: the service (`latest`, `changes`), its layer over Ingest, tested on the test clock with
  a scripted provider. `main.ts` provides the scenario clock to `Watch` too, from the same clock layer value as
  Ingest's. `HubServer` publishes `SlateChanged` with the watchability.
- **API.** `LiveMessage`'s `SlateChanged` gains `watchability: Array<Watchability>`.
- **Web.** `Live.ts` keeps the watchability; the strip card badge in `slate/`; the stream page's line.
- **Glossary.** **Lull** added; **GameEvent** and **Watchability** sharpened.

## Scenario expectations

| Scenario | Must hold |
| --- | --- |
| two-minute-drill-tie | UGA–ALA ranks first from 0:00 until it goes final; it is not in a lull before 3:00 |
| three-red-zones-at-once | At 1:00, PSU–IOWA > FSU–CLEM > ORE–WASH |
| all-lulls-but-one | From 0:00 to 2:00, every game but AUB–ARK is in a lull, and AUB–ARK ranks first |
| blowout-and-upset-brewing | VAN–ALA ranks above OSU–AKR throughout; its reasons name the upset |
| kickoff-window | A game scores 0 until it kicks off |
| recorded-red-zones | Each game scores higher in its red-zone frames than in its frames outside the 40 |

## Risks to check

| Risk | Check |
| --- | --- |
| ESPN's `clock` does not change between polls during live play (stale feed), so everything looks like a lull | Measure on the recorded slice: share of live frames flagged as lull. If it is high, the 45 s window grows or the rule needs a second signal |
| `lastPlay` text varies, so turnover vs change of possession is misread | Unreadable cases fall to change of possession (the quieter reading); recorded-slice tests sample real texts |
| Scores cluster, so ties are common | Scenario tests check orderings that matter; ties are left to the Director (which may show both, per piece 3) |
