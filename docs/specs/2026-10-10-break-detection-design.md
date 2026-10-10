# Break detection

2026-10-10. The second piece of the Director's automation (see the [Classification roadmap](2026-10-10-classification-design.md#roadmap)):
the classifier tells, sooner and from more signals, that a live game has stopped, why, and roughly when it will be
back. Break is the top moment for a stopped game, and carries what was at stake when it stopped. Nothing acts on it
yet; the autopilot (piece 3) leaves a game on a break and comes back near its expected end.

All of it is inferred from the data, never the video: ESPN never marks a TV timeout, so the classifier infers them
from where networks break, from play text, and from a feed that has gone quiet.

Not in this spec: predicting a break's real end, decoding ESPN's play `wallclock`, per-network rules, classification
observability (a follow-up from piece 1), and anything that acts on breaks.

## Domain

### Moment

```
Break { reason: BreakReason, expectedEnd: DateTimeUtc, during?: ScoringThreat | CrunchTime }
```

- `expectedEnd` is the break's `since` plus its reason's typical length, by league. It is a hint: a break ends when
  a play arrives that does not start another.
- `during` is the `ScoringThreat` or `CrunchTime` that would hold if the game were not stopped, carried as that
  case's fields.

New precedence for live games: **BigPlay → Break → ScoringThreat → CrunchTime → Live**, then `Upcoming` and `Final`
as before. A big play keeps its minute because that is when the replays air; a break still holding after it takes
over. A red-zone timeout is now a `Break` during a `ScoringThreat`.

### Break reasons

`BreakReason` grows from five reasons to ten. Each holds of a live game in play when nothing above it in this table
holds:

| Reason | Holds when | Typical length (NFL / college) |
|---|---|---|
| `halftime` | the status is `halftime` | 13:00 / 20:00 |
| `delay` | the status is `delayed` mid-game | 10:00 |
| `periodEnd` | as today: the latest play is a `PeriodEnd` and the next period has not started | 2:00 |
| `twoMinuteWarning` | the latest play is the two-minute warning (split out of `timeout`) | 2:15 |
| `timeout` | the latest play is a team timeout or an official timeout | 1:00 |
| `review` | the latest play's text mentions a challenge or a review | 2:30 |
| `injury` | the latest play's text mentions an injury | 2:00 |
| `afterScore` | as today: from a scoring play until the next kickoff | 2:15 |
| `afterKickoff` | the latest play is the kickoff after a score (the double dip) | 2:00 |
| `possessionChange` | the latest play is a punt, a turnover, or a turnover on downs | 2:00 |
| `stall` | nothing above holds, and no new play has arrived for 90 s | 1:30 |

The lengths are starting guesses, tuned by eye on game days like the score weights. They live in one table beside
`BreakReason`, for example as `BreakReason.typicalLength(reason, league)`.

Networks do not break after every punt, so `possessionChange` is sometimes wrong. When it is, the next snap arrives
within about 40 s and the break ends.

### Play text

`Play` owns the text match, like `Play.bigPlay`: a case-insensitive word match on a play's text, with the words in one
place to tune.

- injury: "injur", "shaken up"
- review: "challenge", "review", "replay"

## Classifier

The fold stays pure and keeps its shape.

- **Stall clock.** `Followed` gains `lastPlayAt`: the `now` of the take that last brought the game a new play, or of
  the step that first saw the game. `stall` holds once `now` reaches `lastPlayAt` plus `Classifier.stallAfter` (90 s).
  That deadline joins the game's `expiry`, so `nextExpiry` wakes the fold just as the stall begins. Arrival time, not
  ESPN's `wallclock`, so a feed that runs uniformly behind does not look stalled.
- **Leaving a break never waits.** A moment holds `momentHold` (20 s) before a lower one replaces it; leaving a
  `Break` skips the hold, as moving to `Upcoming` or `Final` already does. Entering one is immediate, since it
  outranks every moment it replaces except a big play.
- **`during`** comes from the same red-zone and crunch-time checks as today, run before the break checks.
- **Score is unchanged.** The `Break` moment bonus stays at −0.20; stakes still count through closeness, time and
  swing, so a red-zone game on a timeout ranks high, below itself live (ranking statement 8).

## Web

- The badge stays a dimmed `BRK`, with `· RZ` or `· CT` when `during` is set.
- The breakdown on hover adds the reason and "back about 3:42 PM", `expectedEnd` as a local time. A time of day
  needs no timer to stay true between slate changes, as a countdown would.

## Tests

Football statements, in the classifier's tests:

1. A punt starts a `possessionChange` break.
2. The next snap ends it.
3. A timeout in the red zone is a `Break` during a `ScoringThreat`.
4. 90 s without a play is a `stall`; 89 s is not.
5. The kickoff after a score starts an `afterKickoff` break.
6. A play whose text says a player was injured starts an `injury` break.
7. A snap after a break shows `Live` at once, not after 20 s.
8. A touchdown's `BigPlay` outranks its `afterScore` break, which follows once the minute is up.
9. A break's `expectedEnd` is its `since` plus its reason's length for the game's league.

`Play`'s tests cover the text match: an injury and a review are found, a play that is neither is not.

## Glossary

Update **Break** (the ten reasons, `expectedEnd`, `during`, top precedence for a stopped game) and **Moment** (the new
precedence). Add **Stall** (no new play for 90 s while in play) and **Double dip** (the break after the kickoff that
follows a score).
