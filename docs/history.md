# Sportal — History

What shipped, in order. Each plan and design below was deleted from the tree once its piece was built; read one with
`git show <commit>:<path>`, or `git checkout <commit>` and open it under `docs/plans/` and `docs/specs/`. The commit is the last one that touched
the piece's files, so they are there as they ended. Decisions that outlived their piece are in `docs/adr/`.

## Shipped pieces

Most pieces went straight onto `main`; the two merge commits are named.

| Date | Piece | Merge | Read its plan and design at |
| --- | --- | --- | --- |
| 2026-10-03 | The thin vertical slice: a live NFL and FBS slate from ESPN, a click puts a game in a tile, and the shell plays it on YouTube TV |  | `ae87429`: `2026-10-03-thin-vertical-slice.md` |
| 2026-10-03 | One-command dev: `pnpm dev` starts the Hub, the web dev server, and the shell together |  | `cccb29b`: `2026-10-03-one-command-dev.md` |
| 2026-10-03 | Stage control: the Hub owns the Stage; layouts, commands, hotkeys, and the tile views in the shell |  | `dde8e7a`: `2026-10-03-stage-control.md`, `2026-10-03-stage-control-design.md` |
| 2026-10-03 | The slate drawer, then the slate strip under the Stage that superseded it |  | `a51bd95`: `2026-10-03-slate-drawer.md`, `2026-10-03-slate-drawer-design.md`, `2026-10-03-slate-strip-design.md` |
| 2026-10-03 | The phone Remote |  | `7f4d189`: `2026-10-03-phone-remote-design.md` |
| 2026-10-03 | Learned channels: the user picks a network's channel once and the Hub remembers it |  | `32b4d9a`: `2026-10-03-learned-channels.md`, `2026-10-03-learned-channels-design.md` |
| 2026-10-03 | Guide-matched channels: the source's own guide says where each game airs |  | `daeede3`: `2026-10-03-guide-matched-channels.md`, `2026-10-03-guide-matched-channels-design.md` |
| 2026-10-03 | Guide direct read: the guide read with its own request, replacing a hidden guide view |  | `daeede3`: `2026-10-03-guide-direct-read.md`, `2026-10-03-guide-direct-read-design.md` |
| 2026-10-03 | Scenarios and synthetic streams: written timelines the Hub plays in place of ESPN and YouTube TV |  | `03a0d32`: `2026-10-03-scenarios.md`, `2026-10-03-scenarios-design.md` |
| 2026-10-03 | Game events and watchability: a score, its lulls, and why, on the strip |  | `ca334fd`: `2026-10-03-watchability.md`, `2026-10-03-watchability-design.md` |
| 2026-10-04 | Hub foundations: one config, a composition root, health, and a clean stop |  | `c934199`: `2026-10-04-hub-foundations.md`, `2026-10-04-hub-foundations-design.md` |
| 2026-10-04 | Mouse filter: provider players never see the pointer, except the interacting tile |  | `dad30cb`: `2026-10-04-mouse-filter.md`, `2026-10-04-mouse-filter-design.md` |
| 2026-10-04 | Telemetry: traces, logs, and metrics over OTLP, and a local Grafana |  | `3e0a423`: `2026-10-04-telemetry.md`, `2026-10-04-telemetry-design.md` |
| 2026-10-04 | Game actors: each game an `effect/cluster` entity (replaced by the fold, 2026-10-06; ADR 0006, superseded by ADR 0009) |  | `31bf3a9`: `2026-10-04-game-actors.md`, `2026-10-04-game-actors-design.md` |
| 2026-10-04 | One "live": every part of Sportal answers whether a game is live the same way |  | `4beb8b7`: `2026-10-04-one-live.md` |
| 2026-10-04 | The slate over the game actors |  | `aa0377b`: `2026-10-04-slate.md`, `2026-10-04-slate-design.md` |
| 2026-10-04 | The Display module: a Display's local state and rules, in one pure module |  | `befc5fe`: `2026-10-04-display.md`, `2026-10-04-display-design.md` |
| 2026-10-05 | Recorded game days: nineteen scenarios cut from two recorded days, and the overtime fix |  | `ecb600b`: `2026-10-05-recorded-days.md`, `2026-10-05-recorded-days-design.md` |
| 2026-10-05 | FastCast: ESPN's push feed as the live feed, with its dashboard row | `28e138a` | `0a16b35`: `2026-10-05-fastcast.md`, `2026-10-05-fastcast-design.md` |
| 2026-10-05 | The feed log and one fold: every frame logged raw, and the game actors replaced (ADRs 0008 and 0009) | `e0285b7` | `7b85bd0`: `2026-10-05-feed-log.md`, `2026-10-05-feed-log-design.md` |
| 2026-10-06 | One path from feed to fold: one Provider port with its polling as a Schedule, decode quiet with Ingest telling only what is live, FastCast's checkpoint retry as a Schedule, scenarios as providers through the real Ingest with recorded scenarios as raw frames, and Watchability removed | `d77ab7b` | The goal package `goals/hub-one-path/` (`goal.md`, `facts.md`, `plan.md`) |
| 2026-10-06 | Services yielded where they are used: the Provider port split from its Decoder with its member types named (`Polling`, `LiveFeed`), FastCast a service, Ingest's leagues and the scenario clock's speed read from HubConfig, and the shell's address and window as services | `3f1d158` | `2026-10-06-di-cleanup.md`, `2026-10-06-di-cleanup-design.md` |
| 2026-10-06 | Guide-only channels: the source's guide is the only answer to where a game airs, with **no guide** while none is fresh; the hand-picked lineup, its store, the picking tile and the shell's guide views removed | `64275af` | `2026-10-06-guide-only.md`, `2026-10-06-guide-only-design.md` |
| 2026-10-06 | TypeScript 7 with the Effect language service: `@effect/tsgo` patches `tsc` so its diagnostics fail `pnpm check` and show in the editor (Zed through `.zed/settings.json`), dependency-cruiser on a private TypeScript 6, and what the diagnostics flagged fixed | `b936381` | `2026-10-06-ts7.md`, `2026-10-06-ts7-design.md` |
| 2026-10-06 | The fold follows the feed log: the Hub's live games replay the day and take each appended frame themselves, deciding the replay boundary by `seq`; `Decoded` one per frame, so every frame moves the watermark and an undecodable poll no longer stalls polling; one telling by `Following`; the push takes the live games' `LiveFeedDemand` and reconnects on its provider's Schedule; Provider and Decoder separate layers paired by HubMode; one snapshot feed for written scenarios and tests | `9b5ae57` | `2026-10-06-fold-follows-log.md`, `2026-10-06-fold-follows-log-design.md` |
| 2026-10-07 | Scenario field: every scenario plays as ESPN feed frames through ESPN's decode, written ones from a scenario script, so every scenario has plays; the snapshot feed is test-only; the FBS recordings backfilled with plays from ESPN's game summaries; tries, returns, interceptions, fumbles and the end of regulation decode as themselves; teams carry their colors; the slate carries each game's recent plays; a 2D field draws the ball and each play on the scenario stream and a live data tile | `354694a` | `2026-10-06-scenario-field.md`, `2026-10-06-scenario-field-design.md` |
| 2026-10-07 | The corpus: the poll and the push in separate roles, a covered game holding a poll ahead of it for `fallbackAfter` in place of the tie rule, the fold renamed the slate and returning its game events and observations apart, each event kind said once, typed corpus days built from the feed log or backfilled from ESPN's finished games, `corpus build`, `run` and `backfill` on virtual time (ADR 0010) | `be8cd35` | `817fc6a`: `2026-10-07-corpus.md`, `2026-10-07-corpus-design.md` |
| 2026-10-08 | Scenario days: every game day the feed log recorded plays as a scenario by its date; a scenario's frames stream; a scenario's feed log is always in memory (`SPORTAL_SCENARIO_FEED_LOG` gone); the corpus, the archive and ESPN's summary decode removed (ADR 0011); the 2026-10-03 and 2026-10-04 recordings imported into the dev feed log once | `2f42fde` | `2026-10-07-scenario-days.md`, `2026-10-07-scenario-days-design.md` |
| 2026-10-08 | Simplify: no persistence for now (the feed log, SQLite, Ingest, the data directory and replay on restart removed); the provider decodes its own frames (`Provider.decoded`); the slate takes each frame as it arrives, with `Acknowledgement`, hold and fallback, staleness, the timer, slate and decode observations, `Decoded` and game events removed; `BoardTelemetry` and the decode, feed log and slate metrics removed, and the Live games dashboard with them; scenarios are recordings only (ADR 0012) |  | ADR 0012 |

Also built, with no plan of its own: the game-day checklist (`docs/game-day-checklist.md`) and the decision records.

## Spikes

Throwaway code outside the workspace; the finding was kept as a decision record and recorded fixtures.

| Spike | Question | Result |
| --- | --- | --- |
| Feed fidelity | Is the free ESPN feed fresh and rich enough, and where does FBS coverage fall short? | Done. The FBS slate of 2026-10-03 and the NFL day of 2026-10-04 were recorded and became the fixtures; ADR 0007 records what the feeds carry |
| Shell playback | Can the Widevine Electron build sign in and play several YouTube TV channels in separate views? | Done: it can, with one persistent session; ADR 0002 |
| Stream budget | What happens at the concurrent-stream limit? | Not run. The budget is unknown and not enforced (ADR 0002) |
| Channel mapping | Can a broadcast be turned into a YouTube TV address by hand? | Replaced: the user picks channels once, then the source's guide supplies them (learned and guide-matched channels, above) |

## Build order

The thin vertical slice came first: a minimal NFL and FBS slate with live scores, where clicking a game plays it in a tile in the shell. It touched every boundary once, and was widened by the pieces above. Next are the Director, follows, presets, and the spoiler shield (`docs/specs/2026-10-03-director-design.md`, `docs/product-plan.md`).

## Early decisions

| Question | Decision |
| --- | --- |
| Language shape | Effect TypeScript end to end (ADR 0001) |
| CI | Local only at first; GitHub Actions from 2026-10-15 (`docs/release.md`) |
| First slice | Thin vertical |
| Record the FBS feed of 2026-10-03 before approval | Yes |
| Layout standard | Accepted, with files as no junk drawer: main behaviour first, no scattered incidental interfaces, no helper pile at the top |
