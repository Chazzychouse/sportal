# Classification

2026-10-10. The first piece of the Director's automation: the Hub classifies every game's current moment and scores
how worth watching it is, and Displays show the suggested order. Nothing acts on it yet; the later pieces (see
[Roadmap](#roadmap)) all read what this one publishes.

The vision behind it: a personal NFL RedZone with a dramatic host. This spec gives the "what is happening, and where
is the best of it" that the host, the prompts, and the autopilot need.

## What it gives

- Each listed game has a **Classification**: one **Moment** (what kind of thing is happening now), a **score** 0–100
  (how worth watching it is), when the moment began, and the score's breakdown.
- The live stream carries the classifications beside the slate and its availability.
- The slate strip sorts its Live section by score and badges each card and tile with its moment; hovering a badge
  shows the breakdown.

Not in this spec: acting on the classifications (autopilot, prompts, commentary), break detection beyond the plain
rules below, follows, and keeping the classifier between runs.

## Domain

### New feed data

ESPN's scoreboard already sends both; the ESPN decoder reads them.

- `Side.record`: the team's overall wins and losses (`{ wins, losses }`, from `"3-1"`), optional. Ties, where a record
  has them, are ignored.
- `GameSnapshot.odds`: `{ favorite: TeamId, spread, overUnder }`, optional. ESPN sends odds only before kickoff (on
  the 2026-10-04 NFL 1 PM scoreboard, only the six games not yet started had them; about 46 of 59 FBS games on a
  Saturday do), so the classifier keeps what it saw.

### Moment

`packages/domain/src/Moment.ts`, a wire union (`Schema.TaggedUnion`). One moment per game, the one highest in
precedence:

| Precedence | Case | Holds while | Carries |
|---|---|---|---|
| 1 | `ScoringThreat` | The team with the ball is in the red zone (`Situation#inRedZone`) | the team, yards to the end zone |
| 2 | `CrunchTime` | 4th quarter or overtime, margin within 8, under 5:00 left (any overtime counts) | margin, seconds left |
| 3 | `BigPlay` | For 60 s after a play `Play#bigPlay` names | the play's id, its `BigPlayKind` |
| 4 | `Live` | The game is live, nothing above holds, and it is not in a break | – |
| 5 | `Break` | See below | `BreakReason` |
| – | `Upcoming` / `Final` | The game's progress is upcoming / over | – |

`Break` holds, with its reason, when:

- `timeout`: the latest play is a `Timeout`;
- `periodEnd`: the latest play is a `PeriodEnd` and the next period has not started;
- `halftime`: the status is `halftime`;
- `delay`: the status is `delayed` mid-game;
- `afterScore`: from a scoring play until the next kickoff play (the extra point or two-point try, then the
  commercial).

Precedence decides between moments that hold at once, so a red-zone timeout is a `ScoringThreat`, not a `Break`.

`Moment.precedence` is an `Order` on the cases.

### Big plays

`Play#bigPlay(): Option<BigPlayKind>`, a method on each play case, matched exhaustively so a new play case must decide.
`BigPlayKind` is `sack | turnover | touchdown | return | longGain`. The thresholds sit in one table beside it:

| Kind | When |
|---|---|
| `touchdown` | A scoring play that is a touchdown (any case) |
| `turnover` | An `Interception`, or a `Fumble` the defense recovers |
| `sack` | Any `Sack` |
| `return` | A kickoff or punt return for a touchdown, or of 30 yards or more |
| `longGain` | A `Rush` or `Completion` of 25 yards or more |

A play that is several (a pick-six) takes the first in the table.

### Classification

`packages/domain/src/Classification.ts`, a `Schema.Class`, the wire value:

```ts
{ moment: Moment, score: Int 0–100, since: DateTimeUtc, breakdown: Breakdown }
```

`Breakdown` (beside it) is `{ prior, closeness, swing, upset, momentBonus }`, each the part's contribution in score
points, so the parts and the score agree.

### Classifier

`packages/domain/src/Classifier.ts`, a `Data.Class`, never on the wire. Pure.

- `Classifier.empty`
- `classifier.step(slate, changes, now): readonly [Classifier, ReadonlyMap<GameId, Classification>]` — `changes` may
  be empty (a timer step).
- `classifier.nextExpiry(): Option<DateTime.Utc>` — when the earliest held moment (a `BigPlay`, a hysteresis hold)
  runs out.

Per game it remembers:

- the **matchup prior** inputs, taken from the first snapshot that has them and kept: rankings and records from the
  latest snapshot, the odds from the last snapshot that had them;
- the current moment and `since`;
- the win probability of the last three plays that had one;
- held moments and when they end.

A delisted game is forgotten.

**Hysteresis.** A moment holds at least 20 s. A higher-precedence moment replaces it at once; a lower one waits out
the 20 s. `Upcoming`, `Final` and a game's first classification never wait.

## Scoring

All constants are in one table at the top of the scoring code in `Classifier.ts`; they are first guesses, to be tuned
on game days.

**Matchup prior P (0–1)**, the mean of the inputs present (a missing one is dropped and the rest reweighted):

- spread closeness: `1 − min(|spread|, 21) / 21`;
- rankings: the mean of each team's `(26 − rank) / 25`, an unranked team counting 0 (FBS only; the NFL has no
  rankings, so the input is missing there);
- records: the mean of the two teams' win percentages.

**Live value L (0–1)**:

- closeness `c = 1 − 2·|wp − 0.5|` from the latest play's home win probability; with none, from the margin:
  `c = max(0, 1 − margin / 17)`;
- time played `t`: the fraction of regulation played, from period and clock (overtime is 1);
- `L = c × (0.4 + 0.6·t)`;
- swing: the largest win-probability change between consecutive kept plays, capped at 0.30, scaled to 0–1, worth up
  to +0.3;
- upset: +0.15 in the second half while the pregame underdog (by the odds) has a win probability above 0.5.

**Blend**:

```
upcoming: score = 100 × 0.6·P
live:     score = 100 × clamp((1 − t)·P + t·(L + swing + upset) + momentBonus)
over:     score = 0
```

Moment bonus: `ScoringThreat` +0.15, `CrunchTime` +0.10, `BigPlay` +0.10, `Live` 0, `Break` −0.20.

## Ranking statements

The ranking tests assert orderings, never raw scores, so tuning cannot break them unless it breaks the football:

1. A tied game late in the 4th quarter outranks a tied game in the 1st quarter.
2. A blowout (21+) in the 4th quarter ranks below any one-score game in the 4th.
3. Two top-10 teams before kickoff outrank an unranked game 21–0 in the 2nd quarter.
4. A ranked team against an unranked one before kickoff ranks below a game tied in the 3rd quarter.
5. Of two games tied in the 3rd quarter, the better matchup ranks higher.
6. A sack on 3rd down that swings win probability late outranks a sack in the 1st quarter of a 28–0 game.
7. A game in the red zone outranks the same game between plays at midfield.
8. A game in a break ranks below the same game live.
9. A pregame underdog leading in the 4th outranks the same score with the favorite leading.
10. A final game ranks below every live and upcoming game.

## Director

The Director holds the Classifier beside the slate.

- After each take that changes the slate, it steps the classifier with the take's slate changes and `DateTime.now`.
- A scoped fiber sleeps until `nextExpiry()` and steps the classifier with no changes; a take that moves the expiry
  earlier restarts the sleep.
- Each new moment is logged: `Director: OSU–MICH ScoringThreat`.

Its port:

```ts
readonly slate: Stream.Stream<Slate>
readonly classifications: Stream.Stream<ReadonlyMap<GameId, Classification>>
```

Two streams, because the timer changes classifications without changing the slate.

## Wire

`SlateChanged` gains `classifications: Record<GameId, Classification>` beside the availability. The live route joins
the Director's two streams with availability and keeps its 250 ms settle.

## Web

- **Slate strip:** the Live section is ordered by score, highest first; Next and Final keep their order.
- **Badge** on each strip card and tile chrome: red-zone flag (`ScoringThreat`), clock (`CrunchTime`), bolt
  (`BigPlay`), dimmed `BRK` (`Break`), none for `Live`.
- **Breakdown** on hovering a badge: the score and its five parts.

## Glossary

Add **Moment**, **Classification**, **Classifier**, **Matchup prior**, **Big play**, **Break**, **Record** and
**Odds** rows. Update **Director** (it classifies and publishes classifications) and **Slate changed** (it carries
them). Retire the Planned **Game event**, **Trigger**, **Rule** and **Alert** rows: Moment covers what they planned;
the later pieces add their own words.

## Testing

- **Domain, test-first**: `Play.test.ts` (each big-play kind and its threshold edge, such as a 24-yard gain that is
  not one), `Moment.test.ts` (precedence), `Classifier.test.ts` (each moment and break reason, hysteresis both ways,
  expiry and `nextExpiry`, the prior keeping odds after kickoff and reweighting a missing input, and the ten ranking
  statements). New builders for odds, records and plays with win probability go in `TestGame.ts`.
- **ESPN decoding**: records and odds from the recorded scoreboard fixtures (`fbs-scoreboard-2026-10-03T2024Z.json`
  has odds; `nfl-scoreboard-pregame.json` has records).
- **Director**: with the test clock, a `BigPlay` expires with no new delivery, and a take publishes classifications.
- **Tuning**: on a live game day, from the breakdown. Offline tuning over the 2026-10-03/04 recordings waits for Replay
  (`2026-10-09-recording-and-replay-design.md`).

## Roadmap

The automation, in order; each gets its own spec.

1. **Classification** — this spec.
2. **Break detection** — sharper commercial and lull inference from data only (provider players are never captured or
   inspected): TV timeouts by clock and period, two-minute warnings, injury stoppages, a clock that has not moved.
3. **Autopilot** — a Display may follow the classifications: promote, move audio focus, change layout, then revert.
   Manual input always wins and suspends it on that tile for a while. The Hub suggests; the Display, which owns its
   Screen (ADR 0015), acts.
4. **Prompts** — "a big moment on a game you cannot see: pull it up?" An in-app toast first, a phone push later.
5. **Commentary** — an original host persona (not a real person's name, image, catchphrases or cloned voice): a
   writer turns moment changes into lines (templates, then an LLM with the persona sheet as its prompt), a `Voice`
   port speaks them (a local engine such as Kokoro or Piper, or a hosted designed voice), and the Display ducks the
   focused game's audio under them.
