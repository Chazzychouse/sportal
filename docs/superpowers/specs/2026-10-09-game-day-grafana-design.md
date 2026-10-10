# Game-day Grafana dashboards

## Goal

Make Grafana useful during a game day: show every listed game at a glance, show the latest five plays for each game that has started, and open a focused dashboard for one game's complete history and diagnostics.

Game awareness is the primary job. Hub operations remain available without competing for the top of the game-day view.

## Dashboard architecture

The provisioned Sportal folder contains three dashboards.

### Game Day

`Game Day` is the default overview. It answers:

- How many games are live, upcoming, and over?
- What are the score, status, period, and clock of every listed game?
- Which live game's accepted snapshot is stale?
- What are the latest five plays in each game that has started?

It links each game to `Game Detail`. It links system-wide health to `Hub`.

### Game Detail

`Game Detail` is selected by the stable game id and displays the matchup as the variable text. Its URL is shareable and preserves the selected time range. It contains:

- the two scores, status, period, clock, and age of the last accepted snapshot;
- a scoring-only play timeline;
- the full play log in the selected range;
- snapshot age, recent play volume, and game-attributed warnings and errors;
- links back to `Game Day` and to `Hub`.

### Hub

The existing `Hub` dashboard remains the operational view for FastCast, polling, provider logs, warnings, and errors. Game-day panels move out of it rather than leaving two competing copies.

## Game Day layout

The dashboard defaults to the last 24 hours and refreshes every 10 seconds. Its league variable defaults to all leagues.

### Summary

The top row contains:

- live games;
- upcoming games;
- over games;
- the greatest accepted-snapshot age among live games.

Snapshot age is neutral through 30 seconds, amber above 30 seconds, and red above 60 seconds. It does not alarm on upcoming or over games.

A separate Hub-presence stat distinguishes an empty slate from an unavailable Hub.

### Games table

One row represents one listed game. Columns are:

- matchup, linked to `Game Detail`;
- league;
- away score;
- home score;
- status;
- period;
- clock;
- kickoff;
- accepted-snapshot age.

The default ordering is live, upcoming, then over; games within a group are ordered by kickoff. Grafana derives a hidden sort rank from `sportal_game_state` rather than changing that metric's established values.

A missing field displays `—` and does not remove the game's row.

### Recent plays by game

A repeated two-column panel grid follows the table. It includes live and over games, omitting upcoming games so they do not create empty cards. Each panel:

- is titled with the matchup;
- queries Loki by stable game id;
- shows the latest five play logs, newest first;
- links to `Game Detail` with the game id and dashboard time range;
- displays `No plays received` when the game has no play logs in the selected range.

The repeated variable uses the game id as its value and the matchup as its display text. Duplicate matchup text therefore cannot make queries or links collide.

## Game Detail layout

The dashboard defaults to the last 24 hours and refreshes every 10 seconds.

### Header

The header contains one stat for each score, one combined status area for period and clock, and the age of the last accepted snapshot. Non-live statuses use their domain spelling: scheduled, halftime, delayed, final, postponed, or canceled.

### Plays

The main row has:

- a narrow scoring timeline, newest first, filtering the existing play logs by `scoring="true"`;
- a wide full play log, newest first, filtering by game id.

Both panels use the dashboard time range. “Full” means every play log retained within that selected range, not an unbounded Loki query.

### Diagnostics

The diagnostics row contains:

- accepted-snapshot age;
- play logs received in the last 15 minutes;
- warning, error, fatal, or critical logs carrying the selected game id;
- a link to the system-wide `Hub` dashboard.

Feed-wide failures are not attributed to an individual game.

## Telemetry

### Current game values

`Director` already observes every `SlateChange.Progressed`. In addition to the existing `sportal_game_state` gauge, that observation updates these private gauges:

| Metric id | Value | Additional attributes |
| --- | --- | --- |
| `sportal_game_status` | Numeric mapping of `GameStatus` | none |
| `sportal_game_score` | Points | `side` (`away` or `home`), `team` (abbreviation) |
| `sportal_game_period` | Period number | none |
| `sportal_game_clock` | Seconds remaining | none |
| `sportal_game_kickoff` | Kickoff as Unix seconds | none |
| `sportal_game_updated_at` | Time the Director accepted the snapshot, as Unix seconds | none |

Every series also carries the stable attributes `game`, `league`, and `matchup`. Status, score, period, clock, and timestamps are metric values, never attributes. A changing game value therefore updates an existing series instead of creating a new one.

The status mapping is exhaustive and compile-checked:

| Status | Value |
| --- | ---: |
| scheduled | 1 |
| live | 2 |
| halftime | 3 |
| delayed | 4 |
| final | 5 |
| postponed | 6 |
| canceled | 7 |

`Director` reads time through Effect's `Clock` when setting `sportal_game_updated_at`. When a game is delisted, it removes every current-game gauge series for that game, as it already does for `sportal_game_state`.

### Hub presence

A private `sportal_hub_up` gauge is set to 1 while the Hub telemetry registry is active. Its presence lets Grafana distinguish:

- Hub metric present and no game-state series: no games listed;
- Hub metric absent after Prometheus staleness: Hub unavailable.

A graceful stop may set it to 0 before telemetry flushes, but absence remains the crash/unreachable signal.

### Play logs

No new play metric is added. `SlateChange.Played` continues producing one structured Info log with:

- `game`;
- `league`;
- `matchup`;
- `play`;
- `scoring`.

Loki supplies the recent-five grid, full play log, scoring timeline, and recent play volume.

### Data flow

```text
Provider delivery
  -> Slate change
     -> Progressed -> Director current-game gauges -> OTLP -> Prometheus
     -> Played     -> Director structured play log -> OTLP -> Loki

Prometheus + Loki
  -> Game Day
  -> Game Detail
```

## Variables and links

- `league` is multi-select and includes All.
- `game` uses a Prometheus query result with a named-capture regex so its value is the stable game id and its text is the matchup.
- The Game Day repeated grid includes only values whose current progress is live or over.
- Data links pass `var-game`, `${__from}`, and `${__to}`.
- Dashboard links preserve the current range and 10-second refresh where Grafana supports it.

All dashboards use native Grafana panels and transformations. The design introduces no panel plugin.

## Empty, stale, and failure behavior

- **Hub unavailable:** show a prominent unavailable state; do not render it as zero games.
- **No games listed:** show `No games currently listed` while Hub presence remains healthy.
- **Stale live game:** retain its last accepted values and color snapshot age amber above 30 seconds and red above 60 seconds.
- **No plays yet:** omit upcoming games from the play grid; show `No plays received` for a live or over game with no logs in range.
- **Missing metric:** preserve the table row and render that field as `—`.
- **Delisted game:** remove it from Game Day. A previously opened detail URL shows `Game is no longer listed`; historical play logs remain visible within the selected range.
- **Duplicate matchup:** query and link by game id.
- **Game warning absent:** say that no game-attributed warnings were found; do not substitute feed-wide errors.

## Verification

### Director tests

Tests prove that:

- one progressed game updates status, both scores, period, clock, kickoff, and accepted-at gauges;
- a later snapshot replaces gauge values without creating labels from changing values;
- each status maps to its documented value;
- delisting removes all current-game series;
- the Hub-presence gauge is registered;
- existing play logging behavior remains unchanged.

Effect's test clock controls accepted-at assertions.

### Dashboard validation

Automated checks prove that:

- every dashboard file is valid JSON;
- dashboard and panel ids are unique;
- every PromQL expression is accepted by the local Prometheus API;
- every LogQL expression is accepted by the local Loki API;
- game links contain the stable game id and preserve the time range;
- repeated panels use the game id as the value and matchup as visible text.

### Behavioral fixtures

Dashboard queries and transformations are exercised against upcoming, live, halftime, delayed, final, postponed, and canceled game snapshots. Checks also cover no games, no plays, stale data, missing fields, duplicate matchup text, and delisting.

### Live smoke test

During live games, verify:

- scores, status, period, and clock update within the 10-second dashboard cadence;
- the play grid remains limited to five entries per game;
- the table and card links open the correct stable game id;
- Game Detail shows complete and scoring-only play logs;
- stale thresholds do not fire during normal live updates;
- Hub-wide failures remain on the Hub dashboard.

Because offline scenarios are not currently built, this live check remains a short manual checklist.

## Out of scope

- Grafana alerts or external notifications;
- custom Grafana panel plugins;
- changing the domain or API wire format;
- retaining game metrics after delisting;
- rebuilding offline scenario playback;
- deriving drives, statistics, or win-probability charts;
- attributing feed-wide FastCast or polling failures to one game.
