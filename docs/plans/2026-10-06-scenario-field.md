# Scenario field — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry out `docs/specs/2026-10-06-scenario-field-design.md`. When this is done:

- Every scenario is ESPN feed frames played through `EspnDecode`, and every scenario has plays.
- The slate reaches the web with each game's recent plays.
- A minimal 2D field draws each play as it happens, on the scenario stream and on a live data tile.

**Architecture:** One branch, `scenario-field`, in `../sportal-scenario-field`, where the spec is written. Tasks run
in order, with one commit each, and every commit passes `pnpm check`. The tasks build in this order:

1. The domain: team colors, the ball spot, and recent plays.
2. Sending recent plays over the wire.
3. Writing scripts as ESPN frames.
4. Cutting the scenario path down to frames.
5. Giving written scripts plays.
6. Backfilling the FBS recordings.
7. The web.
8. The docs.

**Tech Stack:** Effect 4 (`effect`, `@effect/platform-node`), Vitest with `@effect/vitest`, React 19 with Tailwind, SVG,
Biome, dependency-cruiser, knip, pnpm workspaces.

## Global constraints

- **Read first.** Read `AGENTS.md`, `CONTEXT.md` and the spec before any task. Their rules apply to every line.
- **Effect 4 is newer than training data.** Before writing Effect code, read `node_modules/effect/ai-docs/src/index.md`
  and the example it points to for the API at hand. Copy the patterns of the file you are editing. Never write Effect
  from memory.
- **No bodies in this plan.** It gives signatures, behaviour and test cases. Each task names the existing code whose
  patterns to follow.
- **Testing:** `pnpm check` passes before every commit. Run one test file with `pnpm vitest run <path>`. Domain logic
  and provider encoding and decoding are written test-first. Existing tests keep their assertions, and only their
  setup changes, unless a step says otherwise.
- **knip:** no export lives only for its tests (`knip --production`). `Test*.ts` files are outside knip's production
  project.
- **Glossary:** every new exported type name gets its `CONTEXT.md` row in the same commit.
- **Services:** a service is yielded where it is used. Nothing indexes `X["Service"]`.
- **States:** states are tagged unions, never boolean flags. Use Effect abstractions over hand-rolled loops, `Map`
  mutation or `throw`. Do not hand-map a payload with `...(x === undefined ? {} : …)` spreads where a schema can do
  the work.
- **Comments:** doc comments on major exports. Inline comments only for a non-obvious why.
- **TypeScript:** no `any`, non-null assertions, enums, default exports, or casts outside decoding.
- **Commits:** every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **The main checkout:** never edit `../sportal`. The user runs the app from it.

## Setup

- [ ] `cd ../sportal-scenario-field && pnpm install --frozen-lockfile --prefer-offline`
- [ ] Commit the spec and this plan if they are not committed yet:
  `docs: scenario field spec and plan`.
- [ ] `pnpm check` should pass.

## File map

| File | Task | Change |
|---|---|---|
| `packages/domain/src/Team.ts` | 1 | + `color`, `alternateColor` |
| `apps/hub/src/provider/espn/EspnEvent.ts` | 1, 3 | reads the colors; exports its raw event schema for the writer (3) |
| `packages/domain/src/Game.ts` | 2 | + `BallSpot`, `GameSnapshot#spotOf` |
| `packages/domain/src/RecentPlays.ts` | 3 | new: the schema of each game's last ten plays |
| `packages/domain/src/LiveGames.ts` | 3 | + `recentPlays(leagues)` |
| `apps/hub/src/Slate.ts` | 3 | publishes `{ games, recentPlays }` |
| `apps/hub/src/StageSessions.ts`, `apps/hub/src/hub-server/HubServer.ts`, `apps/hub/src/HubMode.test.ts` | 3 | read `.games` |
| `packages/api/src/LiveMessage.ts` | 3 | `SlateChanged` + `recentPlays` |
| `apps/web/src/hub/LiveStream.ts` | 3 | keeps `recentPlays` |
| `apps/hub/src/scenario/ScenarioScript.ts` | 4 | new: the written form, moved from `Scenario.ts`, plus plays |
| `apps/hub/src/provider/espn/EspnScript.ts` | 4 | new: a script written as ESPN frames |
| `apps/hub/src/provider/espn/EspnPlay.ts` | 4 | exports its raw entity schema for the writer |
| `apps/hub/src/scenario/Scenario.ts` | 5 | becomes `{ name, frames }`; `RecordedScenario.ts` is deleted |
| `apps/hub/src/scenario/RecordedScenarios.ts` → `Scenarios.ts` | 5 | the catalogue: recorded and written; + `ScenarioDuplicate` |
| `apps/hub/src/scenario/written/Scenarios.ts` → `Scripts.ts` | 5 | the scripts by name |
| `apps/hub/src/scenario/ScenarioProvider.ts` | 5 | frames only; `decoder` goes |
| `apps/hub/src/HubMode.ts` | 5 | `EspnDecode.layer` for every scenario |
| `apps/hub/src/provider/snapshot/*` → `apps/hub/src/TestSnapshotFeed.ts` | 5 | test-only |
| `apps/hub/src/scenario/written/*.ts` | 6 | plays on every ball move |
| `spikes/backfill-plays/` (gitignored) and `fixtures/scenarios/*.frames.jsonl.gz` (11 FBS) | 7 | backfilled |
| `apps/web/src/game/Field.tsx`, `apps/web/src/ScenarioStrip.tsx` | 8 | new |
| `apps/web/src/ScenarioStream.tsx`, `apps/web/src/stage/TileBody.tsx` | 8 | use the field |
| `CONTEXT.md`, `docs/technical-spec.md`, `docs/game-day-checklist.md`, `AGENTS.md` | each task, 9 | rows and docs |

---

### Task 1: Team colors

`feat(espn): teams carry their colors`

**Files:** `packages/domain/src/Team.ts`, `apps/hub/src/provider/espn/EspnEvent.ts` (`EspnEvent.ts:35-42`, the team
struct), `EspnEvent.test.ts` (or the test that covers `fbs-scoreboard-live.json` today:
`rg -l fbs-scoreboard-live apps/hub/src`), `CONTEXT.md`.

**Interfaces:**
- Produces: `Team.color?: string` and `Team.alternateColor?: string`, each six hex digits without `#`, as ESPN sends
  them.

- [ ] **Test first.** In the test that decodes `fixtures/fbs-scoreboard-live.json`:
  - The first event's home team has the `color` and `alternateColor` that the fixture's JSON gives for it. Read them
    from the file with `jq` and write them into the test as literals.
  - A competitor whose team has no `color` decodes with both fields `undefined`. Build that event from the fixture
    with the colors removed.
- [ ] Run it and see it fail.
- [ ] Add both fields to `Team` as `Schema.optional(Schema.String)`. Read both in the ESPN team struct as optional
  fields, mapped onto `Team` the way `logo` is mapped today.
- [ ] Run it and see it pass. Then run `pnpm check`. `decoded-snapshots.json` or other golden fixtures may now carry
  colors: regenerate them only through the script or test that owns them, and confirm only `color` and
  `alternateColor` changed.
- [ ] Add a `CONTEXT.md` row for **Team colors**. Commit.

### Task 2: Ball spot

`feat(domain): a spot's ball spot on the field`

**Files:** `packages/domain/src/Game.ts`, `packages/domain/src/Game.test.ts`, `CONTEXT.md`.

**Interfaces:**
- Produces, in `Game.ts`:
  ```ts
  /** Where a spot is on the field: yards from the home goal line (0–100), and the way its team is going. */
  export type BallSpot = { readonly yards: number; readonly toward: "home" | "away" }
  // on GameSnapshot:
  spotOf(spot: { readonly team?: TeamId | undefined; readonly yardsToEndzone?: number | undefined }): Option.Option<BallSpot>
  ```
  `Situation` gives `{ team: possession, yardsToEndzone: yardLine }`, and a `Play`'s `start` and `end` already have
  this shape.

- [ ] **Test first** in `Game.test.ts`, with a `TestGame.snapshot` whose home and away teams are known:

  | Case | Expected |
  |---|---|
  | home, 75 to go | `Some({ yards: 25, toward: "away" })` |
  | away, 75 to go | `Some({ yards: 75, toward: "home" })` |
  | home, 1 to go | `{ yards: 99, toward: "away" }` |
  | away, 1 to go | `{ yards: 1, toward: "home" }` |
  | home, 99 to go | `{ yards: 1, toward: "away" }` |
  | no team | `None` |
  | a team in neither side | `None` |
  | no `yardsToEndzone` | `None` |
- [ ] Run it and see it fail. Implement `spotOf` as a method beside `eventsSince`. Run it and see it pass.
- [ ] Add a `CONTEXT.md` row for **Ball spot**. Commit.

### Task 3: Recent plays reach the web

`feat: the slate carries each game's recent plays`

**Files:**
- `packages/domain/src/RecentPlays.ts` (new)
- `packages/domain/src/LiveGames.ts`, `LiveGames.test.ts`
- `apps/hub/src/Slate.ts`, `Slate.test.ts`
- `apps/hub/src/StageSessions.ts`, `apps/hub/src/hub-server/HubServer.ts`, `HubServer.test.ts`
- `apps/hub/src/HubMode.test.ts`
- `packages/api/src/LiveMessage.ts`
- `apps/web/src/hub/LiveStream.ts`
- `CONTEXT.md`

**Interfaces:**
- Produces, in `packages/domain/src/RecentPlays.ts`:
  ```ts
  /** Each game's last ten plays, in `Play.order`, sent with the slate. A game with no plays is not a key. */
  export const RecentPlays = Schema.Record(GameId, Schema.Array(Play))
  export type RecentPlays = typeof RecentPlays.Type
  ```
- Produces, on `LiveGames` in the domain: `recentPlays(leagues: ReadonlyArray<LeagueId>): RecentPlays`. It holds the
  games `slate(leagues)` lists that have plays in `live`, each with its last ten.
- Produces, on `Slate`: the published value is
  `{ readonly games: ReadonlyArray<GameSnapshot>; readonly recentPlays: RecentPlays }`, written inline in the
  service's type. Both `latest` and `changes` carry it.
- Produces, in `LiveMessage`:
  `SlateChanged { slate: Array<GameSnapshot>, recentPlays: RecentPlays }`.
- Produces, in the web: `Live.recentPlays: RecentPlays`, starting as `{}`, so `useLive()` has it.

- [ ] **Test first** in `LiveGames.test.ts`, using the existing fold helpers (`TestGame.polled`, `TestGame.play`) and
  following the Plays delivery test around `LiveGames.ts:165`:
  - A game with 12 plays gives its last 10 in sequence order.
  - A game with 3 plays gives all 3.
  - A listed game with no plays is not a key.
  - A league that is not asked for is not included.
- [ ] Run it, see it fail, implement it, and see it pass. Add a row for **Recent plays**.
- [ ] **Test first** in `Slate.test.ts`: after a listing and a Plays delivery (`TestFeed.delivered`), `latest` has the
  game in `games` and its plays in `recentPlays`. Change existing Slate assertions from `latest` to `latest.games`.
- [ ] Change `Slate` to publish the pair from one `folded`. Update `StageSessions.ts:24`, `HubMode.test.ts:16` and
  `HubServer.ts:107` to read `games`. `HubServer.ts:107` maps the pair to
  `{ _tag: "SlateChanged", slate: games, recentPlays }`.
- [ ] Add `recentPlays` to `SlateChanged`. In `HubServer.test.ts`, the live stream test also asserts that
  `recentPlays` is on the first message.
- [ ] Web: `LiveStream.ts` `received` keeps `recentPlays` beside `slate`, and the initial `Live` has `{}`.
- [ ] `pnpm check`, then commit.

### Task 4: A scenario script, written as ESPN frames

`feat(hub): a scenario script is written as ESPN feed frames`

This task adds the writer next to today's path and does not wire it in yet. Task 5 switches to it.

**Files:**
- `apps/hub/src/scenario/ScenarioScript.ts` (new)
- `apps/hub/src/provider/espn/EspnScript.ts` (new), with `EspnScript.test.ts`
- `apps/hub/src/provider/espn/EspnEvent.ts`, `EspnPlay.ts`: export their raw schemas
- `apps/hub/src/scenario/Scenario.ts`: `build` and `Change` move out
- `CONTEXT.md`

**Interfaces:**
- Produces, in `ScenarioScript.ts`:
  ```ts
  /** A written scenario before it is written as frames: each offset's slate, and the plays run at that offset. */
  export class ScenarioScript extends Data.Class<{
    readonly name: string
    readonly origin: DateTime.Utc                       // 2026-10-03T16:00Z, as `Scenario.build` has it today
    readonly steps: ReadonlyArray<{
      readonly at: number                                // ms after origin, ascending, the first 0
      readonly slate: ReadonlyArray<GameSnapshot>
      readonly plays: ReadonlyArray<{ readonly game: GameId; readonly play: Play }>
    }>
  }> {
    static build(name: string, games: ReadonlyArray<{ /* today's `Scenario.build` game shape, unchanged */ }>): ScenarioScript
  }
  ```
  - `Change` moves here with `Scenario.build`'s helpers (`initial`, `millisOf`, `changed`, `situationOf`). It gains
    `play?: { readonly kind: PlayKind; readonly yards: number; readonly text?: string }`.
  - A change with a `play` yields one `Play` for its game at that step:
    - `id` is `<game id>-<n>` and `sequence` is `n`, counting from 1 per game.
    - `period`, `clock` and both scores come from the game after the change.
    - `team` is the possession before the change.
    - `start` is `{ team, yardsToEndzone, down, distance }` from the ball before the change. `end` comes from the
      ball after it. With `ball: null` after the change, `end` has only `team`.
    - `scoring` is whether the score changed.
    - `text` is `change.play.text`, or else a sentence of kind and yards, such as "Rush for 4 yards" or "Pass
      complete for 12 yards".
  - A change with a `play` and no `lastPlay` uses the play's text as `lastPlay`.
  - `ScenarioScript` is a `Data.Class` because it never crosses the wire.
- Produces, in `EspnScript.ts`:
  ```ts
  /** `script` as the frames ESPN would have sent: scoreboard polls, and each game's play-by-play topic. */
  export function framesOf(script: ScenarioScript): ReadonlyArray<FeedFrame>
  ```
  The frames are in `receivedAt` order:
  - **Polls:** at every step, one `{ feed: "poll", channel: league, kind: "response" }` frame per league on the slate.
    Its body is `{ events }` with one event per game, built as `EspnEvent`'s raw (encoded) event type. The fields are
    those the decoder reads (see `EspnEvent.ts:13-69,146-154`):
    - status, as the decoder maps each `GameStatus` back;
    - competitors, with team, score, `curatedRank` and colors;
    - `geoBroadcasts`;
    - situation, with `yardLine` turned back to count from the home goal.
  - **Checkpoints:** per game, one `{ feed: "fastcast", channel: "gp-football-<nfl|college-football>-<id>", kind:
    "checkpoint", sourceId: 0 }` frame 1 ms after the first poll that lists it. Its body is `{ entities: { plays: {} } }`.
    Use `FastCastMessage.ts:165-180` for the topic name.
  - **Plays:** per play, one `{ kind: "message", sourceId: mid, sentAt }` frame on its game's topic, 2 ms after its
    step's poll. Its body is `{ op: "P", tc, mid, pl: JSON.stringify({ ts, pl: [{ op: "add", path:
    "/entities/plays/<id>", value: <EspnPlay raw entity> }] }) }`, with `mid` 1, 2, 3 … per topic. The entity's
    `sequenceNumber` is a string, its teams are `{ $key }` with the league prefix removed, and its `type.id` is the
    first id in `EspnPlay`'s `kinds` table for the play's kind.

  Encode each body with its raw schema (`Schema.encodeSync` of the exported raw struct, then `JSON.stringify`). That
  way the compiler checks the shape the decoder reads.

- [ ] **Test first** in `EspnScript.test.ts`, with a two-game script (one NFL, one FBS). One game scores on a play,
  one has a rush, a sack, a punt and a turnover, and one goes final:
  - **Round trip.** Fold every frame up to each step through `TestFeed.liveGames(frames, { decoder:
    EspnDecode.layer })`. Its `slate(LeagueId.literals)` equals that step's `slate`, and each game's `plays` equal
    the script's plays so far. Compare with `Equal.equals` or field by field.
  - Mids are 1, 2, 3 … per topic.
  - Every checkpoint is after its game's first poll and before its first play.
  - No frame decodes to a `Dropped` fold report or a skipped-play notice.
- [ ] **Test first** in a new `ScenarioScript.test.ts`:
  - A change with `play: { kind: "rush", yards: 4 }` and a ball moved from 75 to 71 gives a play with start
    `yardsToEndzone` 75 and end 71, team home, and text "Rush for 4 yards".
  - A play that changes possession has a start team that differs from its end team.
  - A scoring play is `scoring: true`, with the new scores.
  - A step with no play has `plays: []`.
- [ ] Run them and see them fail. Move `build` into `ScenarioScript` and add plays. Export `EspnEvent`'s and
  `EspnPlay`'s raw schemas, named for what they are (`EspnEvent.Raw`, `EspnPlay.Entity`), and write `framesOf`. Run
  them and see them pass.
- [ ] Keep `Scenario.build` working for now by delegating to `ScenarioScript.build` and mapping `steps` to `frames`.
  Task 5 removes it.
- [ ] Add a `CONTEXT.md` row for **Scenario script**. Commit.

### Task 5: One scenario path

`refactor(hub): every scenario plays as ESPN frames; the snapshot feed is test-only`

**Files:**
- `apps/hub/src/scenario/Scenario.ts`; `RecordedScenario.ts` (deleted)
- `apps/hub/src/scenario/RecordedScenarios.ts` → `Scenarios.ts`, `RecordedScenarios.test.ts` → `Scenarios.test.ts`
- `apps/hub/src/scenario/written/Scenarios.ts` → `Scripts.ts`, `written/Scenarios.test.ts` → `written/Scripts.test.ts`
- `apps/hub/src/scenario/ScenarioProvider.ts` and its test
- `apps/hub/src/HubMode.ts`
- `apps/hub/src/provider/snapshot/*` → `apps/hub/src/TestSnapshotFeed.ts`
- `apps/hub/src/TestFeed.ts` and every test importing `provider/snapshot/` (`rg -l provider/snapshot apps/hub/src`)
- `CONTEXT.md`, `AGENTS.md` (the `SPORTAL_SCENARIO` paragraph)

**Interfaces:**
- Produces, in `Scenario.ts`:
  `export class Scenario extends Data.Class<{ name: string; frames: ReadonlyArray<FeedFrame> }>`, with `origin()`. This
  is today's `RecordedScenario`, renamed. `slateAt` and `build` go.
- Produces, in `scenario/Scenarios.ts`: the service `Scenarios`, which is today's `RecordedScenarios` renamed.
  - `names` lists the recorded and the written, sorted.
  - `load(name): Effect<Scenario, ScenarioUnknown | ScenarioUnreadable>` gives a written one as
    `new Scenario({ name, frames: EspnScript.framesOf(script) })`.
  - `ScenarioDuplicate { name }` is a tagged error raised by `names` and `load` when a recorded file and a script share
    a name.
  - `Scenarios.in(folder)` and `Scenarios.layer` keep today's signatures.

  The scenario folder takes ESPN's writer as a dependency. That is allowed because only `HubMode.ts` and tests
  name providers, and `Scenarios.layer` is only provided in `HubMode.ts`. If the dependency-cruiser rules reject
  `scenario/` importing `provider/espn/`, `HubMode.ts` passes `Scenarios.in(folder, written)` the written scenarios
  instead, already as `Scenario`s.
- Produces, in `written/Scripts.ts`: `scripts: ReadonlyMap<string, ScenarioScript>`.
- Produces, in `ScenarioProvider.ts`: `layer: Layer<Provider, ScenarioUnknown | ScenarioUnreadable | ScenarioDuplicate,
  HubConfig | Scenarios>`. It is today's `recorded`, with `playedRecorded` unchanged. `decoder`, `feedOf` and
  `writtenNamed` go.
- `HubMode.scripted` provides `EspnDecode.layer` directly.
- Produces, in `TestSnapshotFeed.ts`: today's `SnapshotPayload`, `SnapshotProvider.layer` and `SnapshotDecode.layer`,
  in one test file, with the same exports used by `TestFeed.ts` and the tests. Their tests
  (`SnapshotDecode.test.ts`, `SnapshotProvider.test.ts`) merge into `TestSnapshotFeed.test.ts`. The `"snapshot"`
  literal in `Frame.ts` and FeedLog migration `2_allow_snapshot_feed` stay.

- [ ] **Test first** in `scenario/Scenarios.test.ts`:
  - `names` holds every recorded file and all five scripts.
  - `load("two-minute-drill-tie")` gives frames whose first is a poll.
  - A folder holding `two-minute-drill-tie.frames.jsonl.gz` fails `ScenarioDuplicate`.
  - The `ScenarioUnknown` message lists both kinds.
- [ ] **Test first** in `written/Scripts.test.ts`: port each assertion of today's `written/Scenarios.test.ts` and keep
  its numbers. The helper `at(script, seconds)` folds `EspnScript.framesOf(script)` up to that time through
  `TestFeed.liveGames(…, { decoder: EspnDecode.layer })` and reads the slate, in place of `slateAt`.
- [ ] Run them and see them fail. Rename, move and delete as listed. Point `ScenarioProvider.test.ts` written cases at
  the frames path: keep each test's assertion, and change only how the scenario is provided.
- [ ] Run `pnpm check`. knip must report nothing under `provider/snapshot`, because the folder is gone.
  dependency-cruiser must pass.
- [ ] Update the **Scenario** row and add **Scenario duplicate** in `CONTEXT.md`. Update `AGENTS.md`'s scenario
  paragraph: every scenario plays through ESPN's decode. Commit.

### Task 6: Written scripts run plays

`feat(scenarios): written scenarios run their plays`

**Files:** `apps/hub/src/scenario/written/*.ts` and `written/Scripts.test.ts`.

- [ ] **Test first** in `Scripts.test.ts`:
  - Every change in every script that moves the ball for the same team, or turns it over, has a `play`.
  - `two-minute-drill-tie` has its red zone at 2:00 and its final at 3:40. These are unchanged, and
    `docs/game-day-checklist.md` relies on them.
- [ ] Run it and see it fail. Add a `play` to each such change:
  - the kind that fits the existing `lastPlay` text when there is one ("Interception" is `interception`, "Punt" is
    `punt`, "Field goal is good" is `fieldGoal`);
  - otherwise `rush` or `pass`, with the yards the ball moved;
  - a sack where the ball goes back.

  Offsets, clocks, scores and balls are not changed.
- [ ] Run it and see it pass. Run `pnpm check`. Commit.

### Task 7: Backfill the FBS recordings

`fix(fixtures): FBS recorded scenarios carry their plays, from ESPN's game summaries`

**Files:** `spikes/backfill-plays/backfill.ts`, which is gitignored and not committed. The 11 FBS
`fixtures/scenarios/*.frames.jsonl.gz` that have no `fastcast` frames are rewritten. A new check goes in
`scenario/Scenarios.test.ts`.

**Interfaces:** none exported. The script is run once with `node spikes/backfill-plays/backfill.ts`. Node strips the types itself, and
the repo's imports already carry `.ts` extensions. It uses the Hub's own `FeedFrame`, `Gzip` and
`EspnPlay.Entity` through relative imports, and Effect's `FileSystem` and `HttpClient`.

- [ ] **Test first** in `scenario/Scenarios.test.ts`. Every football scenario, written and recorded, folded whole
  through `EspnDecode` with `TestFeed.liveGames`:
  - has at least one game with plays;
  - produces no `Dropped` fold report.

  This fails now for the 11 FBS files.
- [ ] First confirm the summary's play entity. Fetch one game, for example `401856819` from `crowded-fourth-quarter`.
  Check which of `EspnPlay.Entity`'s required fields it has: `id`, `sequenceNumber`, `type`, `text`, `period.number`,
  `clock.displayValue`, `statYardage`, `scoringPlay`, `homeScore`, `awayScore`, `start` and `end`. Also check that its
  teams are `{ id }`, not `{ $key }`. The script maps each summary play onto `EspnPlay.Entity`'s encoded shape:
  `team.id` becomes `$key`, and nothing else changes.
- [ ] Write the script. For each recording with no `fastcast` frames:
  1. Read the frames.
  2. Collect the game ids and leagues from the poll bodies, and the window from the first `receivedAt` to the last.
  3. Fetch `site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=<id>`, once per game, at
     most one request per second.
  4. Flatten `drives.previous[].plays[]` with `drives.current.plays[]`, and dedupe by id.
  5. Per game, add a checkpoint frame 1 ms after its first poll. It holds the plays with `wallclock` before the
     window, at `sourceId` 0.
  6. Add one message per play inside the window at its `wallclock`. Plays that share a second are spread 1 ms apart
     in sequence order. The body has the same shape as `EspnScript`'s, with mids 1, 2, 3 … per topic.
  7. Merge all frames by `receivedAt`. Check that the merged frames fold with no `Dropped` report and no skipped
     plays, and only then write the file.
- [ ] Run it. Spot-check `crowded-fourth-quarter`: the number of plays inside the window matches the summary's
  count for that wallclock range.
- [ ] Run the test and see it pass. Run `pnpm check`. Run `pnpm dev:golden` long enough to see `/api/live` carry
  `recentPlays` for an FBS game (`curl -N localhost:4400/api/live | head -c 4000`).
- [ ] Commit the 11 fixtures.

### Task 8: The field

`feat(web): a 2D field draws each play, on the scenario stream and a live data tile`

**Files:**
- `apps/web/src/game/Field.tsx` (new)
- `apps/web/src/ScenarioStrip.tsx` (new)
- `apps/web/src/ScenarioStream.tsx`
- `apps/web/src/stage/TileBody.tsx`
- `apps/web/src/stage/StageView.tsx`, if it has to pass plays down

**Interfaces:**
- Produces:
  `export function Field(props: { game: GameSnapshot; plays: ReadonlyArray<Play>; className?: string })`, one SVG.
- Produces: `export function ScenarioStrip(props: { game: GameSnapshot })`.
- `ScenarioStream` and `TileBody` read `useLive().recentPlays[game.id] ?? []`.

**Drawing:** the spec's Web section is the contract. In short:
- **The SVG:** the viewBox is `0 0 120 53.3`, and x is yards from the left end line. Away's end zone is 0–10, home's
  is 110–120, and a ball spot's `yards` maps to `x = 10 + yards`.
- **Colors:** an end zone is `#<color>` from its team, or a neutral token for home and for away.
- **Lines:** yard lines every 5 yards and numbers every 10.
- **The situation:** from `game.spotOf({ team: possession, yardsToEndzone: yardLine })`, draw the line of scrimmage,
  the first-down line, the red-zone tint and the ball.
- **No ball spot:** the field is dimmed, with no ball.

**Play animation state:** a `Data.taggedEnum`, kept with `useReducer`:

```ts
type Drawing = Data.TaggedEnum<{
  Settled: { readonly last: number }                                     // last play sequence drawn
  Drawing: { readonly play: Play; readonly queued: ReadonlyArray<Play>; readonly last: number }
}>
```

The transitions are:

| From | Event | To |
|---|---|---|
| first render | — | `Settled { last: max sequence }`, which draws nothing old |
| `Settled` | new plays arrive | `Drawing` the first, with the rest queued |
| `Drawing` | new plays arrive | append them to `queued` |
| `Drawing` | the arrow's animation ends (`onAnimationEnd`) | the next queued play, or `Settled` |

A play without both spots is skipped as it is dequeued. The arrow style per kind follows the spec's table:
straight, arc, dotted return, red, dashed, high arc, end-zone flash, ball color flip. Animate it with CSS keyframes
on `stroke-dashoffset`, about 0.6 s.

- [ ] Write `ScenarioStrip` from the current `Scorebug` markup. Write `Field`. Lay out `ScenarioStream` as the spec
  describes: the strip, then the field with the last play as a caption, then a band of the color bars about 3vmin
  tall, keeping `scenario-pan`. Delete `Scorebug`.
- [ ] In `TileBody`, a `DataTile` whose game is `live` and has a ball spot shows `<Field>` under the scoreboard in
  place of `noStream(...)`. Otherwise nothing changes.
- [ ] `pnpm check`.
- [ ] **Checked by eye.** Ask the user to run these from this worktree, because agent-launched Electron misreports
  rendering on this machine:
  - `pnpm dev:golden`: an FBS recording, backfilled, with colors.
  - `SPORTAL_SCENARIO=q3-red-zone-pileup SPORTAL_SCENARIO_SPEED=10 pnpm dev`: NFL.
  - `SPORTAL_SCENARIO=three-red-zones-at-once SPORTAL_SCENARIO_SPEED=10 pnpm dev`: written, with neutral colors.

  Each should show arrows that follow the plays, a dimmed field at halftime and final, and end-zone flashes on
  scores. In a plain browser, the agent can screenshot `localhost:4401/scenario-stream/<game id>` with Claude in
  Chrome.
- [ ] Commit.

### Task 9: Docs

`docs: the scenario field, one scenario path, recent plays`

- [ ] In `docs/technical-spec.md`:
  - Scenarios are ESPN frames, written or recorded.
  - The snapshot feed is test-only.
  - `SlateChanged` carries `recentPlays`.
  - The web draws the field.
- [ ] `docs/game-day-checklist.md`: the `two-minute-drill-tie` timings still hold. Add a check that the field
  animates plays on a live data tile.
- [ ] Check the `CONTEXT.md` rows added in tasks 1–5 against the code's final names.
- [ ] `pnpm check`. Commit.
- [ ] Run `plannotator review` on the branch.
