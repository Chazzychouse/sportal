# Director ("Chris Hansen Mode") — Design

Date: 2026-10-03
Status: Draft

Replaces the Launchpad as the next feature. Builds on the Director outline in `docs/technical-spec.md` §5.4.

## Goal

A personal RedZone channel. While it is on, the Hub keeps the hottest game in the main tile with the sound,
solos a game when it clearly outranks the rest or everything else is in a lull, and pulls good games onto the Stage
from the slate. It moves early, on signals that a big moment is coming, not after the score changes. You can always
take over: a tile you touch cools down, and a game you pin is never moved.

Every behaviour is pinned by scenarios: scripted and recorded game timelines that play through the real Hub, with
synthetic streams standing in for YouTube TV.

## Pieces

Four specs, plans, and builds, in this order. Each one is usable on its own.

| # | Piece | Gives | Spec |
| --- | --- | --- | --- |
| 1 | Scenarios and synthetic streams | Scripted and recorded timelines; a Hub that plays one instead of ESPN; stream pages instead of YouTube TV | [scenarios](2026-10-03-scenarios-design.md) |
| 2 | Game events and watchability | `GameEvent.diff`, `Watchability.score` with lulls and anticipation, tuned against scenarios | later |
| 3 | Director | `Director#decide`, the Hub service, overrides, pulls, the UI | later |
| 4 | Decision advisor | The Jev tiebreaker behind a port | later |

## Decisions

| Question | Decision |
| --- | --- |
| What the Director may do | Promote to the main tile and move audio with it; solo and unsolo; pull a slate game onto the Stage, benching the weakest. It never changes the layout or the split |
| Solo | When the top game reaches 75 and leads the next by 25, or every other on-stage game is in a lull. Ends when the moment resolves (score, turnover, change of possession, period end), the soloed game goes into a lull, another game comes within 10, or after 3 minutes |
| Anticipation | Inside `Watchability`: leading signals (crossing midfield in a one-score fourth quarter, goal to go, fourth and short, two-minute drill, overtime) raise a game's score before the payoff |
| Lull | Inferred: clock stopped with no new play for a while, a timeout just taken, end of a period, halftime, `delayed`. ESPN does not report commercials |
| Main tile | Promote the hottest non-lull game when it beats the current one by 15 and the current one has held 45 s; a lull in the current one skips the hold |
| Pulling in | Any live slate game whose channel availability is carried. It must score 60 and beat the weakest unprotected on-stage game by 20. That game goes to the bench; the newcomer takes its slot. A pull replaces a stream and never exceeds the source's stream budget. At most one pull per 90 s. Games in a lull are never pulled and are benched first |
| Overrides | A manual command on a game starts a 3-minute cooldown for that game (it follows the game); moving audio by hand cools audio. A pin locks a game until unpinned. While the main game is pinned or cooling, the Director does not promote over it or solo |
| On and off | Per Display, off by default. `H` and the command palette toggle it; a top-bar badge shows it, labelled "Chris Hansen Mode" |
| Visibility | A reason chip on the main tile when the Director acts ("UGA · 3rd & goal at the 8 · one-score, 2:10 Q4", with "Jev 71%" when the advisor decided), a lock mark on cooling and pinned tiles, and a collapsible log of recent decisions |
| Jev / Clef | A tiebreaker only: asked when the top two games are within 8 and both at least 50, with a 2 s timeout, its answer cached until either snapshot changes. Down, slow, or unconfigured, the higher score wins |
| Where it runs | The policy is pure, in `packages/domain`: `director.decide(stage, slate, now)` returns stage commands, decisions, and the next Director state. The Hub's Director service feeds it on every ingest and applies its commands through `StageSessions`, like any Remote. Not a general rule engine: user-defined Rules can be built on the same seam later |
| State | Pins, cooldowns, and the current solo live in the Hub's memory and reset on restart |
| Stale data | The Director holds while the newest snapshot is more than 30 s old |
| Fake streams | A Scenario source whose streams are a page of the web UI showing the game's live state over a moving test pattern, with a tone per game so audio focus can be heard |
| Scenario format | A typed builder over `GameSnapshot` timelines, plus slices cut from the ESPN recordings into the same format |

All numbers are named constants beside the code that uses them, tuned against scenarios.

## Glossary to add

Each lands in `CONTEXT.md` with the piece that introduces it.

| Term | Meaning | Piece |
| --- | --- | --- |
| **Scenario** | A timeline of game snapshots for several games, scripted or cut from a recording, that a Hub can play instead of a provider. | 1 |
| **Scenario time** | The clock a scenario plays on: from the Hub's start, at the scenario's speed. | 1 |
| **Lull** | A live game with nothing happening: a stoppage, a timeout, between periods, halftime, a delay. | 2 |
| **Pin** | A game the Director may not move until you unpin it. | 3 |
| **Cooldown** | The time after a manual command during which the Director leaves that game, or audio, alone. | 3 |
| **Director decision** | One thing the Director did or declined, with its reason. | 3 |
| **Decision advisor** | What the Director asks to break a near tie. | 4 |

## Testing

- Domain, test-first: `GameEvent.diff`, `Watchability`, and `Director#decide` through each named scenario, asserting
  the expected decision log (promote at 2:10, solo at 1:45, unsolo on the touchdown, pull at 0:50).
- Recorded slices check that `Watchability` ranks real big moments first.
- The Hub's Director service on the test clock, with the Scenario provider and fake advisors (slow, failing, fixed).
- A game-day checklist row: a scenario at 10× in the real shell.
