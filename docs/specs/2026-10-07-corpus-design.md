# Corpus — design

Status: designed in brainstorming, 2026-10-07; for Plannotator annotation before the plan.

The Director (`docs/specs/2026-10-03-director-design.md`, pieces 2–3) is next. It must be iterated on and, later,
regression-tested against days and days of real games, extremely quickly: change a rule, rerun hundreds of days in
seconds, see what moved. Today that cannot be done:

- The only way to replay a day is through the live path: ESPN-shaped frames, the stateful FastCast decode, and the
  Hub's timer. Every run would parse gzip'd ESPN JSON again.
- There are two recorded days. Capture alone grows that by one football weekend a week.
- The push and the poll compete to write one game's snapshot, settled by a tie rule ("the push wins a tie", ADR 0007's
  work). The rule is a consequence of the design, not something wanted: the poll should update what changes less often
  and fall back when the push is late, and say so explicitly.

This spec gives the poll and the push separate roles, with one explicit fallback rule between them; renames the fold
for what it is, the **slate**; and adds a **corpus**: typed days, captured by the Hub or backfilled from ESPN's
archive, that a runner plays through the slate on virtual time.

## Scope

- **In:** the domain's `LiveGames` (becoming `Slate`), `LiveGame`, `GameEvent`, `Play.eventsSince`,
  `GameSnapshot#eventsSince`'s callers; the Hub's `LiveGames` and `Slate` services (becoming one `Slate`),
  `LiveGamesTelemetry`, `DecodeTelemetry`, `GameHistory`'s reading of the slate, `Provider.ts`'s `Notice`,
  `EspnDecode`, `FastCastDocument`, `TestFeed`; a new corpus (format, build, run) and backfill (fetch, archive,
  synthesis) with their CLI; `HubConfig`'s corpus directory; ADR 0010; `CONTEXT.md`; `docs/history.md`; the game-day
  checklist.
- **Behaviour changes**, each its own `feat:` or `fix:` commit: the tie rule goes and the held snapshot replaces it;
  a fallback snapshot produces state events; four events move from plays to snapshots (see Events).
- **Out:** comparing runs, goldens beyond tests, and anything the Director needs beyond the slate's output (designed
  with the Director); a lag model with jitter or calibration; MLB in the corpus (`PlayKind` is football; the backfill
  works for the leagues the decoders support); separate raw logs per feed.

## Shape

```
capture          raw                         corpus (typed, rebuilt)            run
───────          ───                         ───────────────────────            ───
poll ──┐                                     days/<day>/poll.ndjson.gz ──┐
       ├─► feed log (frames, as today) ─build─►                          ├─► Slate ─► game events (+ observations)
push ──┘                                     days/<day>/push.ndjson.gz ──┘   (pure, virtual time)
backfill ─► archive (ESPN responses) ─synthesize─► the same two files
```

- **One pure `Slate`** is the only thing that combines the two feeds. The live Hub runs it on each frame as decoded;
  `corpus run` runs it over corpus days. Same code, same order (arrival instant, then `seq`), so a corpus day plays
  as the Hub played it live.
- **The feeds are separate in role.** The push gives live games' snapshots and plays. The poll gives listings: the
  slate, upcoming and final games, broadcasts. It changes a game the push covers only through a held snapshot.
  A corpus day stores the two as separate typed files.
- **The raw stays.** The feed log is unchanged: the Hub's capture store, what the live path follows, what restart
  replays, what scenarios run on, and what captured corpus days are built from. Backfill keeps ESPN's responses as
  fetched in its archive. A corpus day is a build product of one or the other, rebuilt when a decoder or the format
  changes; nothing is migrated.

## The slate

The domain's `LiveGames` (`packages/domain/src/LiveGames.ts`) becomes **`Slate`** (`packages/domain/src/Slate.ts`):
each league's last listing and every current game's live game, taken from push and poll deliveries in arrival order,
and the instant it has ticked to. It stays pure: no I/O, no clock; its now is always an input's arrival instant.

Its reads drop the repeated name: `slate(leagues)` becomes `games(leagues)`, and today's `games()` (every game,
listed or not) becomes `everyGame()`. `recentPlays`, `earliestDue`, `take`, and `tick` keep their names.

`take` and `tick` return the next slate and two lists, split by reader:

```ts
take(frame: { deliveries; at; seq }): Effect<{ next: Slate; events: ReadonlyArray<GameEvent>; observations: ReadonlyArray<SlateObservation> }>
tick(now): Effect<{ next: Slate; events: ReadonlyArray<GameEvent>; observations: ReadonlyArray<SlateObservation> }>
```

- **`GameEvent`** is now the stamped event: `{ game: GameId, at: DateTime.Utc, what: GameEventKind }`, a
  `Schema.Class`. Today's tagged union is renamed **`GameEventKind`** (as `PlayKind` names a play's). `Play.eventsSince`
  and `GameSnapshot#eventsSince` return kinds; the slate stamps them. The Director and `corpus run` read events.
- **`SlateObservation`** replaces `FoldReport`, for telemetry only: `Took` (outcome `taken`, `behind`, `held`,
  `fellBack`; `kept` goes), `Started`, `Changed`, `Stopped`, `Dropped`, `Raised`. `Happened` goes: it is `events`.
- Decode's `Notice` (`apps/hub/src/provider/Provider.ts`) becomes **`DecodeObservation`**, same cases; `Decoded`'s
  `notices` becomes `observations`.

### The Hub's slate

The Hub's `LiveGames` service (follows the feed log, decodes, replays the day at startup, runs the timer, `changes`,
`events`, `demand`, `through`) and its `Slate` service (the games and recent plays, debounced 250 ms, for the live
stream) become **one Hub service, `Slate`** (`apps/hub/src/Slate.ts`), with `published` and `latest published` beside
the members `LiveGames` has today. One concept, one service; no `Fold` alias to tell two `LiveGames` apart.
`LiveGamesTelemetry.ts` becomes `SlateTelemetry.ts`.

## Merge rules

### Live game state

`LiveGameState` gains `Holding`:

```
            poll ahead, covered                 push at or past held
  Live ───────────────────────────► Holding ─────────────────────────► Live (from push)
   ▲                                  │  ▲
   │        deadline: held applies    │  │ poll further ahead: held replaced, same deadline
   └──────────────────────────────────┘  └─┘
            (Live, from poll)
```

```ts
type LiveGameState = Data.TaggedEnum<{
  Upcoming: {}
  Live: { updatedAt: DateTime.Utc }
  /** Live, followed by the push, with a poll snapshot ahead of it held until `until`. */
  Holding: { updatedAt: DateTime.Utc; held: GameSnapshot; until: DateTime.Utc }
  Stale: { updatedAt: DateTime.Utc }
  Over: {}
}>
```

A game is **covered** when it is `Live` or `Holding` and its snapshot came from the push (`LiveGame.from`). A snapshot
is **ahead** of another when it is later in game time (`GameSnapshot.gameTime`), or at the same game time with a
different score or status.

### A poll snapshot (a listing's game, or a `Snapshot` from `poll`)

| The game | The poll is | Then |
| --- | --- | --- |
| not covered (upcoming, over, stale, polled only) | not behind | applies, as today |
| not covered | behind | ignored |
| covered, `Live` | behind | ignored |
| covered, `Live` | equal | `updatedAt` refreshed only |
| covered, `Live` | ahead | `Holding`, `until` = `at` + `fallbackAfter` |
| `Holding` | ahead of `held` | `held` replaced, `until` kept |
| `Holding` | otherwise | `updatedAt` refreshed if equal to the snapshot, else ignored |

`fallbackAfter` is 15 s, a named constant beside `LiveGame`: the push leads the scoreboard on most plays (ADR 0007),
so a poll ahead of it means the push is stuck. The corpus is what tunes it later. Whether the push is connected is
not an input: a dropped push is a stuck one, and the hold covers it, `fallbackAfter` later.

### A push snapshot

Applies unless behind, as today. On a `Holding` game, a push snapshot not behind `held` applies and the game is
`Live` again; `held` is dropped. A push behind `held` but not behind the game's snapshot applies and the game keeps
holding.

### Time

`tick` at `until`: `held` applies as a poll snapshot if it is still ahead (it is: anything that caught it up left
`Holding`), and the game is `Live` from the poll; observation `Took` with outcome `fellBack`. `LiveGame.dueAfter`
gives `until` for a `Holding` game (it is always before going stale), so `earliestDue` includes it and the runner jumps
straight to it.

### Plays

As today: a `Plays` delivery replaces a held game's plays; plays for a game the slate does not hold are `Dropped`.
Plays never change the game's snapshot.

### Events

Each event kind has one origin, so nothing needs de-duplicating:

- **State events come only from the game's snapshot changing**, whichever feed changed it
  (`snapshot.eventsSince(previous)`): `ScoreChanged`, `PossessionChanged`, `Turnover`, `EnteredRedZone`,
  `ReachedScoringRange`, `GoalToGo`, `FourthDown`, `TimeoutTaken`, `PeriodEnded`, `WentToHalftime`, `WentFinal`,
  `TwoMinuteDrill`, `Overtime`. The score changes once, so `ScoreChanged` is said once, whether a fallback or the push
  moved it first.
- **Play events come only from plays:** `Played`, `BigPlay`, `Sack`. `Play.eventsSince` gives only these three.
- `LiveGame`'s `fromPlays` set goes.

Changes in behaviour:

- No poll can flicker a score back after a PAT: a covered game takes a poll only ahead and only after `fallbackAfter`.
- A fallback snapshot says its state events. Today a game with plays drops a snapshot's `ScoreChanged`, so a stalled
  push hides scores.
- `Turnover`, `TimeoutTaken`, `PeriodEnded`, `FourthDown` now come from snapshots, not plays. A snapshot's turnover is
  a possession change with an interception or fumble in its last play's text (`GameSnapshot#eventsSince`, as today).

## The corpus

### Layout

`HubConfig.corpusDir` (`SPORTAL_CORPUS_DIR`, default `<dataDir>/corpus`). A day is a game day in the local zone, from
the same day start the slate replays from.

```
<corpus>/
  days/<YYYY-MM-DD>/
    day.json          { kind: "captured" | "backfilled", format, leagues, games, built }
    poll.ndjson.gz
    push.ndjson.gz
  archive/<league>/scoreboard/<YYYY-MM-DD>.json.gz
  archive/<league>/summary/<gameId>.json.gz
```

### Corpus input

Each line is `{ seq, at, input }`, `input` a **`CorpusInput`** (a `Schema.TaggedUnion`):

| File | Case | Means |
| --- | --- | --- |
| poll | `ListingChanged { league, games }` | a poll of `league` whose listing differs from its last |
| poll | `ListingUnchanged { league }` | a poll of `league` with the same listing as its last; still refreshes `updatedAt` |
| push | `Snapshot { snapshot }` | a pushed game snapshot |
| push | `PlaysChanged { game, upserts, removed }` | a game's plays changed: plays added or changed, ids removed |

Reading a day merges the two files by `(at, seq)` and turns inputs back into the deliveries the slate takes:
`ListingUnchanged` into its league's last listing, `PlaysChanged` into the game's whole list. So a run hands the slate
exactly what the live decode did, and a college day does not store sixty snapshots every ten seconds.

`CorpusInput.format` is a named constant. A day built to another format does not load: `CorpusDayUnreadable`, saying
to rebuild it.

### `corpus build`

`corpus build <date> | --from <date> --to <date> | --all`, for captured and backfilled days alike:

- **Captured:** the day's frames from the feed log, through the real `Decoder`, the `Decoded` deliveries split by feed
  into the two files. Listings become `ListingChanged` or `ListingUnchanged` against the league's last.
- **Backfilled:** synthesized from the archive (below).
- `day.json` is written last: a crashed build reads as missing, and building again is idempotent.
- A day the feed log or archive does not have is reported, not a failure of the command. A decode defect fails that
  day's build; a typed day is never written from a partial decode.

### `corpus run`

`corpus run <date> | --from <date> --to <date>`:

- Reads each day and plays it through the slate on **virtual time**: before each input, every due instant up to its
  `at` is ticked; after the last, the slate ticks to the day's end. A plain fold: no `Clock`, no sleeps, no scheduler.
- Days run concurrently on worker threads, one day to a worker.
- What it runs is a **subject**: a pure step over each take or tick's output. This spec's only subject is the slate's
  events themselves; the Director is the next. A day's run is its events in order.
- Out of scope: comparing runs, and any output format beyond that.
- Speed is measured, not promised: the plan measures the 2026-10-04 NFL day on one worker.

## Backfill

### Sources

Checked against ESPN, 2026-10-07:

- The site scoreboard the Hub polls takes `?dates=YYYYMMDD` for a past day.
- The site **summary** (`/apis/site/v2/sports/football/<league>/summary?event=<id>`) of a finished game has, in one
  request, every play with its `wallclock` (160 of 160 on a 2023 FBS game, 2023 NFL alike), `winprobability` by play
  id, the header, the box score, and the broadcasts. Its plays carry `start.team.id` and `end.team.id`, not refs.
- The core-API plays carry `wallclock` too, but page and give each play's probability as another request; not used.

### `corpus backfill`

`corpus backfill --league nfl|fbs --from <date> --to <date>`:

1. **Fetch** into the archive: each date's scoreboard, then each final game's summary. Resumable and idempotent: an
   archived file is never fetched again. Rate-limited and retried by Schedules on the archive's port. A postponed or
   canceled game, or one whose plays lack wallclocks, is skipped and logged.
2. **Build** each date as a backfilled day (`corpus build` does the same from the archive alone).

### Synthesis

- **Plays:** `EspnSummary` (in `provider/espn/`) reads a summary's plays as `Play`s, sharing `EspnPlay`'s kind table
  and spot rules; team from `start.team.id`, win probability from `winprobability` by play id.
- **Push file:** each game's scoreboard snapshot (status scheduled) at kickoff less 30 minutes; then, for each play at
  `wallclock + pushLag`, a `PlaysChanged` and a `Snapshot` read from the play: period, clock, scores, situation from
  its end spot, timeouts counted from the half's timeout plays, `halftime` after period 2 ends, `final` after the last
  play.
- **Poll file:** a poll every 10 s from the first kickoff less 30 minutes until the last game is final; each game in
  the listing as it stood after its last play with `wallclock + pollLag` at or before the poll.
- **Lag model:** `pushLag` 28 s and `pollLag` 41 s, ADR 0007's medians, named constants beside the synthesis.

A backfilled day lacks broadcasts as they changed during the day (the scoreboard's are used throughout), any push
stall (the fallback never fires on one), and ESPN's real publishing delays. Captured days are for those.

## Errors

- `CorpusDayUnreadable`: a day's files missing, `day.json` absent or invalid, a line that does not decode, or a format
  not current. `corpus run` reports the day and runs the rest.
- `ArchiveFetchFailed`: a fetch failed after its retry Schedule. Backfill logs it, lists it in its summary, and goes
  on; the next run fetches it, since the file is still missing.

## Telemetry

The live Hub's slate telemetry stays as the fold's is, renamed. `Took`'s outcomes gain `held` and `fellBack`, and a
counter `sportal_poll_fallbacks` by league counts fallbacks, so a game day shows them in Grafana. The corpus commands
log a summary (days, inputs, time); they export nothing.

## Testing

Domain first, test-first:

- **`LiveGame` / `Slate`:** a covered game's poll ahead holds, then applies at `until`; the push catching up ends the
  hold; a poll further ahead keeps `until`; an equal poll refreshes `updatedAt`; an uncovered game takes a poll at
  once; `ScoreChanged` is said once when a fallback and then the push reach a score; play events only from plays,
  state events only from snapshot changes; `earliestDue` includes `until`.
- **`CorpusInput`:** round-trips; `PlaysChanged` and `ListingUnchanged` read back to exactly the deliveries they were
  built from.
- **Build, live equals run:** the 2026-10-04 NFL recording's frames through the live path (as a recorded scenario,
  through Ingest, the in-memory feed log, and the Hub's slate) and through `corpus build` then `corpus run` give the
  same events. The corpus's proof.
- **Synthesis:** a fixture archive (one recorded scoreboard and summary in `fixtures/`) synthesizes a backfilled day,
  against a committed golden of its two files.
- **Run:** a day run twice gives the same events; a hold with no input after it still falls back at `until`.
- **Fetch:** against recorded responses with a fake HTTP client: an archived file is not fetched again; a failure
  leaves the file missing.

## Documentation

- **ADR 0010, "The poll falls back to the push; corpus days are built from the raw":** the held snapshot replacing the
  tie rule, the corpus as a build product of the feed log and the archive. Amends 0008 (the truth is the feed log and
  the archive) and 0009 (the fold is the slate).
- **`CONTEXT.md`:** **Slate** redefined as the domain's slate; **Live games** and **Fold report** removed; **Notice**
  becomes **Decode observation**; added: **Slate observation**, **Game event** (stamped) and **Game event kind**,
  **Covered**, **Held snapshot**, **Fallback**, **Corpus**, **Corpus day**, **Captured day**, **Backfilled day**,
  **Corpus input**, **Archive**, **Lag model**, **Corpus run**, **Subject**. "Fold" leaves the prose.
- **`docs/history.md`** and the **game-day checklist**: a row to watch `sportal_poll_fallbacks` on a live day.

## Delivery

One branch, `corpus`, in the worktree `../sportal-corpus`, each plan phase a commit passing `pnpm check`, then
`plannotator review`, then one merge to main. The `mlb-postseason` branch touches the same fold and decode; whichever
merges second rebases onto the other.
