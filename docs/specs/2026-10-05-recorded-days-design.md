# Recorded Game Days — Design

Date: 2026-10-05
Status: Approved 2026-10-05

## Goal

Test what the Hub automates (Watchability today; the live feed and the Director later) against real game days,
deterministically, on any day of the week. Two recordings exist. This spec reports what they show, picks the
moments worth keeping as scenarios, and decides what to build first. The Director is out of scope: nothing here
designs or builds it, but every scenario says what it should do, so the scenarios are ready when it is.

## The recordings

| Day | What | Where | Size |
| --- | --- | --- | --- |
| Sun 2026-10-04, NFL | FastCast push (one connection, 16:44:54–20:30:05) and the polled scoreboard, summary, situation, and plays every 10 s (16:15–20:29), on one clock | `fixtures/espn-recordings/2026-10-04/nfl/` (copied from `~/.cache/sportal-spike/feed-lag/nfl-2026-10-04/`) | 247 MB |
| Sat 2026-10-03, FBS | Scoreboard every 30 s (16:08Z–06:30Z), summaries for up to three live games every 60 s; no push | `fixtures/espn-recordings/2026-10-03/college-football/` | 198 MB |

Sunday covers the 1pm window from kickoff to final, and the first minutes of the 4pm games. It has no overtime.
Saturday covers a full college day: up to 18 games live at once, two overtimes, and one delay.

## What the data shows

### Feed timing (Sunday)

| Feed | From the snap to first seen, median / p90 | Behind the push, median / p90 / max |
| --- | --- | --- |
| FastCast | 28 s / 48 s | — |
| Scoreboard (what Sportal polls) | 40 s / 60 s | 9 s / 16 s / 36 s |
| Summary | 48 s / 68 s | 17 s / 25 s / 38 s |

- Most of the lag is ESPN's own, not ours. Replay reviews add 130–277 s in every feed.
- Polling at 10 s barely misses any game state. It saw every score state, all 108 red-zone trips (the shortest
  lasted 5 s), and 98% of plays.
- What polling gets wrong is timing and consistency. Every arrival is snapped to the 10 s grid. In 22 of 87
  scoring plays, the scoreboard shows the touchdown text and the score out of step by 10–30 s; FastCast delivers
  98 of 100 scoring plays together with their score.
- FastCast was clean for the whole session: no reconnects, no `mid` gaps, duplicates, or reorders. Reconnect
  behaviour went unobserved.

### Snapshots are not monotonic

| What | Seen | Example |
| --- | --- | --- |
| A score goes down | 34 times (Sat) | CAL@UNLV 30→24→30; a touchdown overturned by penalty or review fires `ScoreChanged` twice |
| A touchdown arrives in two polls | common (Sat) | +6, then the try, in the next poll |
| The period goes backwards | 5 games (Sat) | MICH@MINN Q4→Q3; four games Q3→halftime |
| The clock jumps or reverses | 7 times (Sun), several (Sat) | LAR@PHI Q2 showed 1:01 for 83 s, really about 9:40; OSU@IOWA flipped between 4:57 and 12:47 |
| The clock freezes while plays keep coming | 111 times (Sat) | TEM@USF stuck at Q4 8:32 for 10 min, then jumped to 3:08 with a lead change |
| One game freezes while the feed stays fresh | Sat | SYR@CONN, tied, stuck at Q4 2:43 for 5.5 min |
| The same play under new ids | Sun | DAL@HOU: one extra point three times as −433160, −433184, −433189 |
| A play's text is edited | 202 times (Sun) | Same id, new text |
| Possession is missing | 32% of in-progress polls (Sat) | Whenever the last play is a timeout |

### Lulls and quiet feeds

- **Lull flips constantly.** About one change every 3 min per game on Saturday, and 497 of them reverse on the
  very next poll.
- **A game's push goes quiet at every break.** Each TV timeout is 150–240 s with no message for that game, and
  halftime is 660–890 s. There were about 125 silences over 90 s across Sunday's games.
- **Content goes unchanged while the feeds are healthy.** On Sunday 18:34–18:36, the whole slate's scoreboard did
  not change for 30–90 s with eight games live.
- **The push stalls and bursts.** At 20:13:00, 17 messages for 6 topics arrived together, up to 12.1 s late.

## Consequences for approved designs

These follow from the data. Each is a finding to accept, reject, or reword; none is decided here.

| # | Design | Finding | Proposal |
| --- | --- | --- | --- |
| C1 | Watchability (built) | `Watchability.ts:102` treats a live game with the clock at 0:00 as a lull. In college overtime ESPN shows the clock as 0:00, so every college overtime counts as a lull: UK@SC's overtime would score 74–90 and still never be promoted | A failing test from the UK@SC cut, then the fix (overtime is never a lull for its clock alone) |
| C2 | Live feed (approved, not built) | The 90 s per-game stale timer would fire at nearly every TV break and every halftime, because a game's push really is silent that long. Every one would flip the game to `needsPoll` and put the poll back to 10 s | Staleness comes from the feed going quiet (no heartbeat or message on the connection), not from one game going quiet. Or 90 s holds only while the game's last poll also shows play. To decide in the live-feed spec |
| C3 | Director (approved, not built) | "Hold while the newest snapshot is more than 30 s old" would hold during healthy quiet stretches if "old" means unchanged content | Reword as "while no delivery has arrived for 30 s" |
| C4 | Director | Solo by score (75 and a 25-point lead) held for only 6 spans all Saturday, nearly all a single poll | Solo will in practice come from "every other game is in a lull". Retune against the scenarios below when the Director is built |
| C5 | Game events | A score that goes down, or one touchdown split over two polls, gives two `ScoreChanged` | Leave it to the Director's spec, with `cal-unlv-phantom-touchdown` pinning what it should do |

## The catalogue

Each moment says what the Director should do, written now so the scenarios do not change when it is built.
"Fault" moments need delivery timing (below) to be faithful; as plain cuts they replay only the snapshots.

### Sunday, NFL

| Name | UTC | What happens | The Director should |
| --- | --- | --- | --- |
| `late-go-ahead-cascade` | 20:00–20:17 | Go-ahead TDs at 1:50 (NE@BUF), 0:40 (DAL@HOU), and 1:10 (LAR@PHI); a pick-six; an onside kick; six finals; MIA@MIN kicks off | Follow each drive in turn, at most one main-tile change per 45 s; never promote a final game |
| `four-touchdowns-in-150-seconds` | 19:50–19:56:30 | Four TDs, two of them lead changes; five games in the red zone at once | Make at most two or three main-tile changes; no solo; no promote into a game on a post-score break |
| `goal-line-stand-overturned-touchdowns` | 17:13–17:21 | NYJ@CHI: two touchdowns overturned at the goal line, then a turnover on downs | Promote NYJ@CHI, maybe solo on 4th and 1, and end the solo on the turnover; no score boost |
| `halftime-staggered-return` | 18:22–18:49 | All eight games at halftime together, then GB@TB plays alone | Hold while all are in a lull; solo GB@TB once it resumes; unsolo as others return |
| `first-half-two-minute-drills` | 18:08–18:33 | All eight games in a second-quarter two-minute drill | Do not oscillate when every game gets the same boost |
| `q3-red-zone-pileup` | 18:53–19:05:40 | Three to six games in the red zone for 12 minutes; two lead changes | Space out promotions by the hold; at most one pull per 90 s |
| `q4-lull-solo-lead-change` | 19:25–19:31 | Only DAL@HOU and JAX@CIN in play; DAL goes ahead 26–23 | Keep or solo DAL@HOU through the TD; end the solo on the score |
| `slate-handover-4pm` | 20:03–20:30 | 1pm games go final as the 4pm games kick off (cut off at 20:30) | Do not pull on kickoff alone; never fill the Stage with a final game |
| Fault: `fastcast-stall-burst` | 20:12:50–20:13:30 | 12 s stall, then 17 messages at once | No hold; apply the burst in order, decide once |
| Fault: `bogus-clock-two-minute` | 17:48:30–17:51:15 | LAR@PHI clock reads 1:01 for 83 s, then 9:31 | No solo or promote from the fake two-minute window |
| Fault: `pat-phantom-play-ids` | 20:07–20:08:30 | One extra point under three ids | No new-play activity, no second score event |
| Fault: `quiet-feed-not-stale` | 17:43:20–17:44:20 | No patch for 30 s with eight games live; the feeds are healthy | No hold |

### Saturday, FBS

| Name | UTC | What happens | The Director should |
| --- | --- | --- | --- |
| `maction-double-finish` | 22:19–22:49 | Two late MAC finishes overlap (BGSU@M-OH, OHIO@KENT) | Promote BGSU@M-OH and keep it through its timeouts; solo briefly at first and goal; then promote OHIO@KENT |
| `overtime-and-final-drive` | 19:46–20:07 | SYR@CONN in overtime against WMU@BUFF's last drive | Rank overtime hottest and never a lull (C1); promote BUFF only for its red-zone snaps |
| `uk-sc-tying-drive-solo` | 23:20–23:48:30 | The day's only real solo by score | Solo at the 4:14 red zone; unsolo on the tying field goal; the 3-minute cap holds |
| `uk-sc-overtime-and-delay` | 23:48–00:04 | Overtime, and the day's only delay (TXSO@FAU) | Keep UK@SC main and soloed through overtime; never pull the delayed game |
| `crowded-fourth-quarter` | 18:51–19:21 | Five one-score fourth quarters, and a nullified touchdown | Promote rarely, each time on a real score or drive, never back and forth |
| `cal-unlv-phantom-touchdown` | 22:52–23:08 | A score of 30→24→30 | Make one decision for one touchdown, not two |
| `syr-conn-stale-tied-finish` | 19:28–19:46 | A tied game frozen at Q4 2:43 for 5.5 min while the feed is fresh | Re-promote quickly once the game catches up |
| `mich-minn-period-flap` | 18:29:30–18:40 | Q4 for one poll, then Q3 again | No promote on the one-poll spike |
| `halftime-status-flaps` | 21:15–21:40 | Q3→halftime flaps in four games | Hold |
| `night-all-lull` | 04:17–04:40 | Every game in a lull | Hold: no promote, solo, or pull |

Seven more Saturday windows and their ready `scenario:cut` commands are in the analysis output; these are the
ones that add something the written scenarios and `recorded-red-zones` do not.

### Faults never seen

Socket drops, `mid` gaps, duplicates, reorders, a dead feed for 30 s or more, and a final game turning live
again never happened on either day. They have to be made by changing a real recording, not found in one.

## Decisions to make

| # | Question | Proposal |
| --- | --- | --- |
| D1 | Keep Sunday's recording | Move it to `fixtures/espn-recordings/2026-10-04/nfl/`, ignored by git like Saturday's. `~/.cache` can be wiped, and this is the only push recording there is. Open: should the raw recordings also be backed up off this machine? |
| D2 | What to build first | Cut the catalogue's non-fault moments into `fixtures/scenarios/` with the existing `scenario:cut`, after it learns Sunday's file names (`<epoch>.json.gz`; it reads only `20261003T160848Z.json.gz` today). This needs no format change and plays in `pnpm dev` at once |
| D3 | Simulation without a Director | A test that folds `Watchability` over every recorded scenario under the test clock and checks properties that hold for any day: overtime is never a lull for its clock alone (C1); a final game scores nothing; folding the same scenario twice gives the same result. Each failure names the scenario and the instant. When the Director arrives, its properties join the same test |
| D4 | Lull flapping | 497 lull reversals on the next poll. Is that wrong? If yes, a property bounds it (for example, no lull shorter than one poll interval) and Watchability changes. If no, it is the Director's job to ride it out. **Your call** |
| D5 | Delivery timing in scenarios | A scenario today is whole-slate frames at fixed offsets: one source, no arrival times. The fault moments, C2, and C3 all depend on when each source delivered. Proposal: a recorded scenario may carry its deliveries (`{ at, source: push \| poll, games }`, plus connection events), so one day replays as poll-only, push-only, or both. It belongs with the live feed, which already plans a scenario push "every second of scenario time": decide it in the live-feed spec, not here |
| D6 | Synthetic faults | Overlays on a recorded scenario that drop, delay, duplicate, reorder, or stall deliveries, for the faults never seen. Depends on D5; later |

## Order

1. D1 (keep the recording), then D2 (cut the moments).
2. D3 with C1: the first property fails on `uk-sc-overtime-and-delay`, then the Watchability fix.
3. Take C2, C3, and D5 into the live-feed spec before it is built.
4. D6, and the Director's properties, with those pieces.

## Glossary to add

Only if D5 is accepted, in the live-feed piece:

| Term | Meaning |
| --- | --- |
| **Delivery** | One arrival of game data at the Hub, from the push or a poll, at an instant. |
