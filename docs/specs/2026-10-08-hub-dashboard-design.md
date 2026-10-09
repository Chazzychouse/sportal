# Hub dashboard: dead panels out, FastCast in

Branch `dashboard` (worktree `../sportal-dashboard`). Touches `telemetry/dashboards/hub.json`,
`apps/hub/src/provider/espn/FastCast.ts` (+ its test) and the docs that name metrics. The Twitch source work does
not touch either file.

## What is wrong today

Checked against the local LGTM (`localhost:3000`) on 2026-10-08, with a Hub that ran 18:33–19:16.

| Panel | State | Why |
|---|---|---|
| Games | works | `sportal_game_state` |
| Hub log volume by level | works | |
| Recent warnings and errors | works | |
| Poll duration | works | `sportal_poll_duration` |
| Provider errors by league | "No data" on a clean run | no `or vector(0)`; the counter is only created on the first error |
| **Poll traces** | **dead** | filters on `resource.sportal.mode="$mode"`: neither the `mode` resource attribute nor a `$mode` variable exists since HubMode went into `main.ts` |
| **Take traces** | **dead**, and noise even if fixed | same `$mode` filter; one ~50 µs `Director.take` span per frame, so a table of them shows nothing useful |
| Connected | works | |
| Errors by reason | "No data" on a clean run | no `or vector(0)` |
| Checkpoint failures | works (zero) | |
| Connects in range | works | |
| Live feed logs | works, but thin | FastCast logs once per connect, plus one line per game topic followed or left; nothing else |

There are 31 `sportal_*` metric names in Prometheus, but only 6 are still emitted. The other 25 (`sportal_snapshots`,
`sportal_live_feed_messages`, `sportal_watchability`, `sportal_lull`, the game-actor ones…) belong to code that has since
been removed. No panel reads them, so they only clutter the metrics browser until retention drops them.

## Why FastCast is a blind spot

FastCast reports only the socket's lifecycle: a connected gauge, connects, failures by reason, and checkpoint
failures. From the dashboard you cannot tell:

1. **Whether push is flowing.** A connected socket that delivers no patches looks the same as a healthy one, until
   the 45 s silence timeout fires. Nothing counts messages. (`sportal_live_feed_messages` used to, but it went with the
   feed-log rewrite.)
2. **What it follows.** Following and leaving a game topic is only a log line, so you cannot see "3 game topics
   followed" over time.
3. **When a document resets.** `FollowAgain` (a missed message, or a patch that will not apply) is a Warning log line,
   but nothing counts it, so you cannot see a rate of them.
4. **How slow checkpoints are.** A checkpoint can hang for up to 20 s before it times out, and nothing measures how
   long they take.

`FastCast.connect` is a single ~300 ms span covering the handshake. No span or metric covers the stream after that.

## Change

### New FastCast metrics

Each is a private const at the end of `FastCast.ts`, with a description, as the existing four are.

| Metric | Kind | Attributes | Updated in |
|---|---|---|---|
| `sportal_live_feed_received` | counter | `op` (`C` `S` `H` `P` `R` `I` `B`, or `unknown` when the envelope does not decode); `league` when the topic has an owner | `framed`, once per socket text |
| `sportal_live_feed_topics` | gauge | — | `steered`'s caller, set to `followed.length` (game topics; the league scoreboards are always followed); set to 0 in `connect`'s finalizer, beside `connected` |
| `sportal_live_feed_steers` | counter | `steer`: `Follow`, `Leave`, `FollowAgain` | `steer`, once per steer |
| `sportal_checkpoint_duration` | timer | — | `checkpoint`, by `Effect.trackDuration`, over the load and the decode |

The new counter is `sportal_live_feed_received`, not the old name `sportal_live_feed_messages`. A Hub on an older branch
was still writing the old series at 01:09 today, so reusing the name would mix two meanings in one series.

### Plays in the logs

Today nothing in Grafana shows what happened in a game: plays reach the slate, but nothing logs or measures them.
After this change, each play a take adds is one Info log, and the dashboard's Plays row reads those logs.

- **Domain:** a `Game#playsAfter(earlier: Game): ReadonlyArray<Play>` method gives the plays this game has that
  `earlier` lacks, matched by id and in this game's order. `playsTaken` replaces a game's whole list of plays, so
  comparing ids is the only way to tell which plays are new. A play the feed corrects keeps its id, so it is not
  logged again.
- **Director:** after the gauge update, each take logs every new play:
  `Director: NE at BUF Q2 4:20 <play text>`. The log is annotated with `game`, `league`, `matchup`, `play` (the play's
  tag, for example `Rush`) and `scoring`. A game the take did not change is skipped. A game new to the slate counts as
  having had no plays, so after a Hub restart the first take logs the whole game so far: a burst of up to ~180 lines
  per live game, once.
- Period 5 and later print as `Q5`. Naming overtime properly is left for later.

### Dashboard (`hub.json`), top to bottom

Same uid, same title. The refresh stays at 30 s and the range at 30 min.

**Top: the Hub at a glance** (stat row, h 4)
Connected · Game topics followed · Push messages / min (`sum(increase(sportal_live_feed_received_total{op=~"P|R"}[1m]))`) ·
Polls / 15 min · Feed failures in range (live feed errors + checkpoint failures) · Provider errors in range. Each counter
has `or vector(0)`. Connected and "Push messages / min" turn red at 0, but only while a game is live
(`max(sportal_game_state_ratio) == 2`). Otherwise 0 is normal, and they stay grey.

**Games** (table, unchanged)

**Plays** (row)
A `matchup` variable lists the values of `label_values(sportal_game_state_ratio, matchup)`, multi-select with All.
- Plays (logs, w 16): `{service_name="sportal-hub"} | play=~".+" | matchup=~"$matchup"`, newest first.
- Scoring plays (logs, w 8): the same query plus `| scoring="true"`.

**Live feed** (row)
- Messages by op (timeseries, stacked rate): you can see patches, heartbeats and checkpoints flowing.
- Patches by league (timeseries).
- Topics followed (timeseries of the gauge), with steers as bars on the same panel: Follow / Leave / FollowAgain.
- Checkpoint duration p50 / p95 (timeseries), with checkpoint failures as points.
- Feed errors by reason (timeseries, `or vector(0)`).
- FastCast logs (logs): `|= "FastCast"` only. Today the regex also pulls in EspnProvider and EspnDecoder, which belong
  in the Poll row.

**Poll** (row)
- Poll duration p50 / p95 (unchanged).
- Provider errors by league (`or vector(0)`).
- Poll traces (table): the `$mode` filter removed, which makes it work again.
- Provider logs (logs): `|~ "EspnProvider|EspnDecoder"`.

**Hub** (row, collapsed)
- Log volume by level · Recent warnings and errors (unchanged, moved down).

**Removed:** Take traces (see the table above). Connects in range becomes a stat on the top row only if there is room.
Otherwise the Feed failures stat covers reconnects, since every reconnect follows a failure.

### Docs

- `docs/technical-spec.md`: wherever it lists FastCast's behaviour or its failure table, name the four new metrics
  beside the existing ones.
- `CONTEXT.md`: no new terms. *Steer* is a private type, and the metric names are not exported types.

### Tests

`FastCast.test.ts` already drives FastCast with `TestTelemetry`'s registry snapshot (check how it does). For each new
metric, one test that the metric moves:
- a `P` text counts one `sportal_live_feed_received{op="P",league=…}`;
- following a game topic sets `sportal_live_feed_topics` to 1, and leaving it sets it back to 0;
- a reset document counts one `sportal_live_feed_steers{steer="FollowAgain"}`;
- a loaded checkpoint records one `sportal_checkpoint_duration` sample.

The dashboard is checked by hand: run `pnpm dev` during a live game (TNF tonight) and confirm each panel has data.
Agent-launched runs are fine here, since this is not a GPU question.

## Not doing

- Not removing the stale series from the TSDB (`pnpm telemetry:down -v` would also wipe logs and traces). They expire.
- No play counter (`sportal_plays`). The play logs already give play volume, through `count_over_time`.
- No push-vs-poll share panel. It needs a counter on the decoder or the Director, and it can come later if the
  push-message rate turns out not to be enough.
- No alerts.
