# Scenario field — design

Status: approved in brainstorming, 2026-10-06. One unit of work: one branch, `scenario-field`, in
`../sportal-scenario-field`.

While a scenario plays, each game's stream is `ScenarioStream` (`apps/web/src/ScenarioStream.tsx`). It shows a
moving test pattern with a scorebug of text over it. This work draws each game on a minimal 2D football field and
animates its plays as they happen. To get there, three things change underneath:

1. **One type of scenario.** Today there are three. A written scenario plays game snapshots through the snapshot
   feed. A recorded NFL scenario plays ESPN polls and FastCast game topics, which carry plays. A recorded FBS
   scenario plays ESPN polls only, because it was recorded before FastCast. After this work, every scenario is ESPN
   feed frames played through `EspnDecode`, and every scenario has plays.
2. **Plays reach the web.** The Hub folds plays into `LiveGame.plays`. Today the web sees only game snapshots.
3. **The field.** It is drawn on the scenario stream page, and on a live data tile in place of the reason it has no
   stream.

## Decisions

- **A scenario is a name and its ESPN feed frames.** Written scenarios are still written in TypeScript as a
  timeline of changes. An ESPN writer turns that timeline into frames. Nothing plays a scenario as game snapshots.
- **The snapshot feed becomes test-only.** Hub tests use snapshot frames as a short way to deliver a listing or plays
  (Ingest, LiveGames, the replay tests, Slate, GameHistory, HubServer, ScenarioProvider). Rewriting them to ESPN
  frames would add work without adding coverage. `SnapshotProvider` and `SnapshotDecode` move into the test harness.
  The `"snapshot"` feed literal and its FeedLog migration (`2_allow_snapshot_feed`) stay, because existing databases
  have rows with it.
- **The FBS recordings are backfilled.** ESPN's game summary
  (`site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=<id>`) lists every play with its
  `wallclock`, its start and end spots, and its yardage. A one-off script adds play frames to each FBS recording at
  the time each play happened. The NFL recordings already carry plays and are not touched.
- **The field draws plays, never snapshot differences.** A game with no plays yet shows the field without
  animation. Scenarios always have plays, and on game days FastCast sends them for current games.
- **Team colors are decoded.** `Team` gains ESPN's `color` and `alternateColor`. Teams without them use a neutral
  home and away color. Written scenarios' teams have no colors.
- **Fixed orientation.** Home's end zone is on the right and away's on the left. Teams do not switch ends at the
  quarter.

## Target shape

### Domain

**`Team.ts`:** `Team` gains `color` and `alternateColor`, both `Schema.optional(Schema.String)`. Each is a
six-digit hex value without `#`, as ESPN sends it.

**`Game.ts`:** `GameSnapshot` gains one method that turns a spot into a **ball spot**:

```ts
/** Where `spot` is on the field: yards from the home goal line (0–100), and the way its team is going. */
spotOf(spot: { readonly team?: TeamId; readonly yardsToEndzone?: number }): Option.Option<BallSpot>
```

- **Home team:** `yards = 100 - yardsToEndzone` and `toward = "away"`.
- **Away team:** `yards = yardsToEndzone` and `toward = "home"`.
- **No team, a team that plays in neither side, or no `yardsToEndzone`:** `None`.

`BallSpot` is `{ readonly yards: number; readonly toward: "home" | "away" }`, named and exported beside
`GameSnapshot`, because both the web and tests use it. The current spot is
`game.spotOf({ team: situation.possession, yardsToEndzone: situation.yardLine })`. A play's spots are
`game.spotOf(play.start)` and `game.spotOf(play.end)`.

**`LiveGames.ts`:** a sibling of `slate(leagues)` returns `recentPlays(leagues)`: for each game on the slate, its
last ten plays in `Play.order`. A game with no plays is left out.

### API — `packages/api/src/LiveMessage.ts`

`SlateChanged` gains `recentPlays: Schema.Record(GameId, Schema.Array(Play))`. `Slate.ts` builds it from the same
fold as the slate, under the same 250 ms debounce, so snapshots and plays always arrive together. A reconnect gets
both. `Play` is already a `Schema.Class`, so no new type is needed.

### Hub — one scenario path

- **`scenario/Scenario.ts`:** this file holds the one scenario type. `Scenario` is `{ name, frames: FeedFrame[] }`,
  which is today's `RecordedScenario`, renamed. `origin()` stays. `RecordedScenario.ts` is deleted.
- **The written form:** written scenarios keep `games` with a `timeline` of `[offset, Change]`. That form gets its own
  name and glossary row, **Scenario script**, and its own module. `Change` gains `play?: { kind: PlayKind; yards:
  number; text?: string }`, the play that made this change:
  - The play's start is the ball before the change. Its end is the ball after.
  - Its period, clock and score come from the game after the change.
  - Its team is the team that had the ball at the start.
  - Its text, when the change does not give one, is written from the kind and yards ("Rush for 4 yards").
  - `lastPlay` defaults to the play's text.
- **`provider/espn/EspnScript.ts`:** the writer. It turns a scenario script into a `Scenario` of ESPN frames:
  - At every offset, one `poll` frame per league, holding that league's ESPN scoreboard: event, status,
    competitors, situation, and colors when the team has them.
  - Per game, one game-topic `checkpoint` frame with no plays (`mid` 0). It goes 1 ms after the first poll that lists
    the game, so the fold never drops plays for a game it does not know yet.
  - For each change with a play, one game-topic `message` frame at that offset. It holds an `add` patch at
    `/entities/plays/<id>`, with the `mid` one more than the topic's last.

  Play ids and sequence numbers are increasing integers per game. The writer lives beside the decoder it feeds
  because it names ESPN.
- **`scenario/RecordedScenarios.ts` becomes `scenario/Scenarios.ts`, the catalogue of every scenario.** It reads
  the recorded files and adds the written scripts as `EspnScript` writes them. `written/Scenarios.ts` becomes
  `written/Scripts.ts`. A name that is both recorded and written stops the Hub at startup, with a
  `ScenarioDuplicate` error beside `ScenarioUnknown`.
- **`scenario/ScenarioProvider.ts`:** only the frames path is left: polls replayed at their offsets, and pushes
  streamed at theirs. `feedOf` and the written branch go. Its `decoder({ written, recorded })` goes, and `HubMode`
  provides `EspnDecode.layer` to every scenario.
- **The five written scenarios** keep their names, and gain plays on the changes that move the ball. The timings
  in `docs/game-day-checklist.md` ("RED ZONE ~12s, final ~22s at 10x") must still hold for `two-minute-drill-tie`.
- **`provider/snapshot/`** moves into the test harness, under `TestFeed.ts`'s ownership, and is no longer imported
  by production code.

### Hub — ESPN team colors

`EspnEvent.ts` reads `color` and `alternateColor` when they are present and passes them to `Team`.

### Backfill — `spikes/backfill-plays/`

This is a one-off Effect script. The committed result is the rewritten `fixtures/scenarios/*.frames.jsonl.gz`. For
each recording whose frames have no game topics:

1. Find the games from its poll frames, and the window from its first frame to its last.
2. Fetch each game's ESPN summary and flatten `drives.previous[].plays[]`, plus the current drive if there is one.
3. Insert one game-topic `checkpoint` frame per game, 1 ms after the first poll that lists it. It holds the plays
   whose `wallclock` is before the window, at `mid` 0.
4. Insert one `message` frame per play inside the window, at its `wallclock` and in sequence order. A play that
   shares a second with the one before it goes 1 ms after it. Each message holds an `add` patch, with `mid`s
   numbered in order per topic.
5. Rewrite the file with the frames merged by `receivedAt`. Check that it decodes with no dropped deliveries and
   no skipped plays before writing.

The summary's play entity has the same fields as FastCast's (`sequenceNumber`, `type`, `start`/`end` with
`yardsToEndzone` and `team.id`). The script maps `team.id` to the `$key` the decoder reads, or extends
`EspnPlay.ts` to read either.

### Web

- **`apps/web/src/game/Field.tsx`:** `Field` takes `{ game: GameSnapshot; plays: ReadonlyArray<Play> }` and draws
  one SVG with a viewBox of 120 × 53.3 yards.
  - **The field:** both end zones in their team's color (or neutral), yard lines every 5 yards, and numbers
    every 10.
  - **From the situation's ball spot:**
    - the line of scrimmage;
    - the first-down line at `distance` in the direction of play, which is not drawn when it is goal to go;
    - a red-zone tint on the 20 yards in front of the goal being attacked;
    - the ball, in the color of the team with the ball.
  - **With no ball spot:** no ball and no lines, and the field is dimmed.
  - **Plays:** `Field` keeps the last sequence it drew in a ref. On first render, it marks everything as drawn and
    animates nothing. Each newer play is drawn in order, about 0.6 s each, from `spotOf(play.start)` to
    `spotOf(play.end)`. A burst of plays queues, and the ball settles on the situation's spot when the queue is
    empty.

    | Play | Arrow |
    |---|---|
    | rush | straight |
    | pass | arc |
    | incompletion | dotted arc that returns to the start |
    | sack, or negative yards | red |
    | penalty | dashed |
    | kickoff, punt, field goal | high arc |
    | scoring | the end zone flashes in the scoring team's color |
    | the team at the end differs from the team at the start | the ball changes color |

    A play without both spots, such as a timeout or the end of a period, is skipped. This is plain SVG with CSS
    transitions, and no animation library.
- **`apps/web/src/ScenarioStream.tsx`:** keeps its tone and its waiting states. `Scorebug` goes. The page is a
  column: `ScenarioStrip` (teams, scores, possession, status, down and distance or "GOAL"), then `Field` with the
  last play as a caption, then a thin band of the moving color bars.
- **`apps/web/src/stage/TileBody.tsx`:** a `DataTile` whose game is live and has a ball spot shows `Field` under
  its scoreboard, in place of its reason. Otherwise it shows the reason, as today.
- **`hub/LiveStream.ts`:** keeps `recentPlays` from `SlateChanged` beside the slate, and `useLive` exposes it.

### Glossary — `CONTEXT.md`

- **Ball spot:** where a spot is on the field: yards from the home goal line, and the way its team is going.
- **Team colors:** a team's primary and alternate colors, as the provider sends them.
- **Scenario script:** a written scenario before it is written as frames: games and a timeline of changes, some
  with a play.
- **Scenario duplicate:** a scenario name that is both recorded and written; `ScenarioDuplicate` in code.
- **Recent plays:** the last ten plays of each game on the slate, sent with it.
- **Scenario:** updated. It is a name and feed frames, recorded or written from a script, and it always plays
  through the ESPN decoder.

## Testing

Written test-first:

- **`Game.test.ts`:** `spotOf` for home, away, no team, a foreign team, no yards, and both goal lines.
- **`EspnScript.test.ts`:** a script with two games, a score and plays is written as frames. Decoded through
  `EspnDecode` and folded, it gives the snapshots and plays the script describes. Mids are consecutive, and every
  checkpoint follows its game's first poll.
- **`EspnEvent` decoding:** colors from `fixtures/fbs-scoreboard-live.json`, and a team without them.
- **`LiveGames.test.ts`:** `recentPlays` keeps the last ten in order, and leaves out games with no plays.
- **`Scenarios.test.ts`:** every scenario, written and recorded, decodes and folds with no dropped deliveries, and
  every football scenario has plays.
- **The existing `ScenarioProvider`, `main`, `Telemetry`, `HubMode` and `HubConfig` tests** pass with
  `two-minute-drill-tie` written as frames.

Checked by eye: `pnpm dev:golden` (backfilled FBS, with colors), a recorded NFL scenario, and
`three-red-zones-at-once` (written, neutral colors). `pnpm check` passes.

## Out of scope

- Drives as a concept: drawing a whole drive, or a drive summary.
- Teams switching ends at the quarter.
- Recording FBS FastCast on game days, which already happens since FastCast was merged.
