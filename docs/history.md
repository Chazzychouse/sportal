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
| CI | Local only for now; the Lefthook hooks are the gate |
| First slice | Thin vertical |
| Record the FBS feed of 2026-10-03 before approval | Yes |
| Layout standard | Accepted, with files as no junk drawer: main behaviour first, no scattered incidental interfaces, no helper pile at the top |
