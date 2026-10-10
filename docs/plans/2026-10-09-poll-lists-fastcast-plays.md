# The Poll Lists, FastCast Plays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each game's FastCast topic its only live feed and the site poll a slow listing, removing FastCast scoreboard topics.

**Architecture:** The site scoreboard poll keeps listing every game (teams, kickoff, broadcasts) every 15 minutes. FastCast follows only game topics (`gp-…`). Their document keeps the game package's `header.competitions[0]` and `entities.plays`. `EspnState` turns a game change into the game's `Plays` and a `Snapshot`: the listed game advanced by the header (status, clock, scores, timeouts, possession), with its situation read from the latest play. The fold, `Provider`, `Delivery`, Slate and Director don't change.

**Tech Stack:** Effect 4, TypeScript (tsgo), Vitest with `@effect/vitest`, pnpm workspaces.

**Spec:** `docs/specs/2026-10-09-poll-lists-fastcast-plays-design.md`. **Baseline:** `2b96397` on branch `poll-lists-fastcast-plays`.

## Global Constraints

- Read `AGENTS.md` before writing code; its module shapes, spellings and test rules apply to every task.
- Effect 4 is newer than training data: read `apps/hub/node_modules/effect/AGENTS.md` and `ai-docs/src/index.md` before writing Effect code.
- Every exported type name is a term in `CONTEXT.md`; a new one adds its glossary row in the same commit.
- Tests: one behaviour per test, `should …` descriptions, arrange/act/assert, beside the file as `Name.test.ts`, against recorded fixtures.
- `pnpm check` passes before every commit (biome, typecheck, depcruise + knip, vitest). Stage only the task's files.
- Unchanged: `Provider`, `Delivery`, `Slate.ts`, `Game.ts`, the Director, the web, FastCast's socket and recovery, the one fold (ADR 0014), retention after polls only.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Fixtures (already committed with this plan)

Recorded live on 2026-10-09/10 from ESPN, in `apps/hub/src/provider/espn/fixtures/`:

| File | What it is |
|---|---|
| `fbs-scoreboard-2026-10-10T0012Z.json` | The FBS site scoreboard at 00:12Z, trimmed to two events: FSU @ LOU `401858254` (live, Q2 4:37, LOU 7 – FSU 14) and IOWA @ WASH `401858487` (scheduled, 01:00Z). |
| `fbs-gp-checkpoint-2026-10-10T0022Z.json` | FSU @ LOU's game topic checkpoint at mid 386, trimmed to `{ header: { competitions: [c0] }, entities: { plays } }`. Q2 3:20, 14–14, LOU (home, `97`) `timeoutsUsed` 0, FSU (away, `52`) 1, neither has possession; 66 plays, the latest (sequence 67) a LOU rushing TD whose `end` has `down: -1`. |
| `fbs-gp-messages-2026-10-10T0022Z.jsonl` | The 59 socket texts after it (mids 387–445, contiguous), one JSON string a line, untrimmed: they patch the header, plays, boxscore and odds. After them: Q2 0:44, 14–14, both `timeoutsUsed` 1, FSU has possession; the latest play (`401858254336`, a pass incompletion) ends 4th & 12, `yardsToEndzone` 42, team `52`. |
| `fbs-gp-pregame-2026-10-10T0022Z.json` | IOWA @ WASH's checkpoint 38 min before kickoff, trimmed as above: `STATUS_SCHEDULED`, no `period`, no `displayClock`, no `score` or `timeoutsUsed`, no plays. |

## File map

| File | Change |
|---|---|
| `apps/hub/src/provider/espn/Topic.ts` | One case: `Data.Class` `Topic { league, game }`, with `tc()` and `static fromTc(tc)` |
| `apps/hub/src/provider/espn/FastCastMessage.ts` | Patch paths are plain JSON Pointers; `Checkpoint` is one schema keeping header and plays |
| `apps/hub/src/provider/espn/FastCastDocuments.ts` | Game documents only; keeps patches inside header or plays; `DocumentChange.Game` carries `header` |
| `apps/hub/src/provider/espn/EspnPayload.ts` | `FastCastEvent` goes; `GameHeader` wire schema added |
| `apps/hub/src/provider/espn/EspnEvent.ts` | `PushedEvent` and `Moved` go; `statusOf`, `scoreOf` exported |
| `apps/hub/src/provider/espn/EspnHeader.ts` (new) | `EspnHeader(league)`: a header read as what it moves |
| `packages/domain/src/Situation.ts` | `static after(play, side)` |
| `apps/hub/src/provider/espn/EspnState.ts` | No scoreboard branch, no push-behind; game change → `Plays` and `Snapshot`; two-way poll interval |
| `apps/hub/src/provider/espn/EspnProvider.ts` | Doc comment; `pollInterval(league)` |
| `apps/hub/src/provider/espn/FastCast.ts`, `TestEspn.ts` | Follow the `Topic` and `Checkpoint` changes |
| `telemetry/dashboards/hub.json` | Push-behind panel removed |
| Docs | ADR 0016, ADR 0014 status, `CONTEXT.md`, `docs/technical-spec.md`, `docs/game-day-checklist.md`, the spec's open checks |

---

### Task 1: Game topics only

Removes scoreboard topics end to end. After this task the poll still runs at its live cadence and is the only source of
snapshots; game topics still give plays. Nothing new is delivered yet.

**Files:**
- Modify: `apps/hub/src/provider/espn/Topic.ts`, `Topic.test.ts`
- Modify: `apps/hub/src/provider/espn/FastCastMessage.ts`, `FastCastMessage.test.ts`
- Modify: `apps/hub/src/provider/espn/FastCastDocuments.ts`
- Modify: `apps/hub/src/provider/espn/FastCast.ts`, `FastCast.test.ts`
- Modify: `apps/hub/src/provider/espn/EspnState.ts`, `EspnState.test.ts`
- Modify: `apps/hub/src/provider/espn/EspnEvent.ts`, `EspnEvent.test.ts`, `EspnPayload.ts`
- Modify: `apps/hub/src/provider/espn/EspnProvider.test.ts`, `TestEspn.ts`
- Modify: `apps/hub/src/provider/espn/fixtures/decoded-snapshots.json`
- Delete: `apps/hub/src/provider/espn/fixtures/nfl-fastcast-checkpoint-2026-10-04T1752Z.json`, `nfl-fastcast-messages-2026-10-04T1752Z.jsonl` (only if no test still reads them after the rewrite, see Step 7)
- Modify: `telemetry/dashboards/hub.json`

**Interfaces:**
- Produces: `class Topic extends Data.Class<{ readonly league: LeagueId; readonly game: GameId }>` with `tc(): string` and `static fromTc(tc: string): Option.Option<Topic>`.
- Produces: `FastCastMessage.Patch` paths and `from` are `string` JSON Pointers; `FastCastMessage.Checkpoint: Schema` (no argument) decoding a game package's text to `Schema.Json` `{ header: { competitions: [c0] }, entities: { plays } }`.
- Produces: `DocumentChange = Data.TaggedEnum<{ Game: { league; game; header: Option.Option<Schema.Json>; plays: Readonly<Record<string, Schema.Json>>; touched: Option.Option<ReadonlyArray<string>> }; Reset: { topic: Topic; detail: string } }>`.

- [ ] **Step 1: Rewrite `Topic.test.ts` for one case**

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Option } from "effect"
import { Topic } from "./Topic.ts"

describe("Topic#tc", () => {
  it.each([
    ["nfl", "401872971", "gp-football-nfl-401872971"],
    ["fbs", "401858254", "gp-football-college-football-401858254"]
  ] as const)("should name %s game %s's package topic", (league, game, expected) => {
    const topic = new Topic({ league, game: GameId.make(game) })

    const tc = topic.tc()

    assert.strictEqual(tc, expected)
  })
})

describe("Topic.fromTc", () => {
  it("should read a package topic as its game", () => {
    const topic = Topic.fromTc("gp-football-college-football-401858254")

    assert.deepStrictEqual(topic, Option.some(new Topic({ league: "fbs", game: GameId.make("401858254") })))
  })

  it.each([
    ["a package topic without a game", "gp-football-nfl-"],
    ["a scoreboard topic", "event-football-nfl"],
    ["another sport's package topic", "gp-basketball-nba-401"]
  ])("should read no topic from %s", (_name, tc) => {
    const topic = Topic.fromTc(tc)

    assert.isTrue(Option.isNone(topic))
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run apps/hub/src/provider/espn/Topic.test.ts`
Expected: FAIL. `Topic` has no constructor taking `{ league, game }` and no `fromTc`.

- [ ] **Step 3: Rewrite `Topic.ts`**

```ts
import { GameId } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Array as Arr, Data, Option } from "effect"

/** A FastCast game topic: one game's package, which carries its header and its plays. */
export class Topic extends Data.Class<{ readonly league: LeagueId; readonly game: GameId }> {
  /** The topic FastCast's `tc` names, when it is a game's. */
  static fromTc(tc: string): Option.Option<Topic> {
    return Arr.findFirst(LeagueId.literals, (league) => {
      const prefix = prefixOf(league)
      return tc.startsWith(prefix) && tc.length > prefix.length
        ? Option.some(new Topic({ league, game: GameId.make(tc.slice(prefix.length)) }))
        : Option.none()
    })
  }

  /** This topic as FastCast's `tc` names it. */
  tc(): string {
    return `${prefixOf(this.league)}${this.game}`
  }
}

function prefixOf(league: LeagueId): string {
  return league === "nfl" ? "gp-football-nfl-" : "gp-football-college-football-"
}
```

Run: `pnpm vitest run apps/hub/src/provider/espn/Topic.test.ts`. Expected: PASS.

- [ ] **Step 4: Plain pointer paths and one checkpoint schema in `FastCastMessage.ts`**

Replace `EventPath` and the `Patch` union:

```ts
/** One JSON Patch operation on a game topic's document; its paths are JSON Pointers into ESPN's game package. */
export const Patch = Schema.Union([
  Schema.Struct({ op: Schema.Literals(["add", "replace"]), path: Schema.String, value: Schema.Json }),
  Schema.Struct({ op: Schema.Literal("remove"), path: Schema.String }),
  Schema.Struct({ op: Schema.Literals(["copy", "move"]), path: Schema.String, from: Schema.String })
])
```

Replace `Checkpoint(topic)`, `ScoreboardCheckpoint` and `GameCheckpoint` with one schema, and drop the `Topic` import:

```ts
/**
 * A game topic's whole document, ESPN's game package, as a checkpoint URL serves it, read as only what the Hub keeps:
 * its header's competition and its plays.
 */
export const Checkpoint = Schema.fromJsonString(
  Schema.Struct({
    header: Schema.optional(Schema.Struct({ competitions: Schema.optional(Schema.Array(Schema.Json)) })),
    entities: Schema.optional(
      Schema.Struct({ plays: Schema.optional(Schema.Record(Schema.String, Schema.Json)) })
    )
  })
).pipe(
  Schema.decodeTo(Schema.Json, {
    decode: SchemaGetter.transform((body): Schema.Json => {
      const competition = body.header?.competitions?.[0]
      return {
        header: { competitions: competition === undefined ? [] : [competition] },
        entities: { plays: body.entities?.plays ?? {} }
      }
    }),
    encode: SchemaGetter.forbidden(() => "A checkpoint is never sent back")
  })
)
```

In `FastCastMessage.test.ts`, change the helper's `tc: "event-football-nfl"` (line 56) to `tc: "gp-football-nfl-401872971"`. Any assertion on a decoded path's `{ uid, pointer }` becomes the plain pointer string.

- [ ] **Step 5: Game documents only in `FastCastDocuments.ts`**

Apply these changes:

1. Class doc: `Each FastCast game topic's document: waiting for its checkpoint, or synced as of a message. A document is the game package's header competition, at gameHeader, and its plays by id, at gamePlays.`
2. `advance` doc: `The documents after frame, and what it changed: a game topic's header and all its plays, by id, with the ids of the plays touched (every one, on a checkpoint or a patch of the plays whole), when either changed.` Keep the rest of the paragraph.
3. `DocumentChange`: delete `Scoreboard`; `Game` becomes:

```ts
  Game: {
    readonly league: LeagueId
    readonly game: GameId
    readonly header: Option.Option<Schema.Json>
    readonly plays: Readonly<Record<string, Schema.Json>>
    readonly touched: Option.Option<ReadonlyArray<string>>
  }
```

4. Constants and `changeOf`:

```ts
/** Where a game topic's header competition is in its document. */
const gameHeader = "/header/competitions/0"

/** Where a game topic's plays are in its document. */
const gamePlays = "/entities/plays"

/** What a game topic's document says: its header and its whole list of plays, with the plays `touched` names. */
function changeOf(topic: Topic, document: Schema.Json, touched: Option.Option<ReadonlyArray<string>>): DocumentChange {
  return DocumentChange.Game({
    league: topic.league,
    game: topic.game,
    header: valueAt(document, tokens(gameHeader)),
    plays: objectAt(document, tokens(gamePlays)),
    touched
  })
}
```

5. In `moved`: `const patches = message.op === "I" ? [] : relevant(message.pl)`; the reduce calls `patched(patchedSoFar, patch)`; `const touched = playsTouched(patches)`.
6. `relevant`, `playsTouched`, `patched`, `described`:

```ts
/** Only the patches inside the header competition or the plays: the rest of ESPN's game package is not kept. */
function relevant(
  patches: ReadonlyArray<typeof FastCastMessage.Patch.Type>
): ReadonlyArray<typeof FastCastMessage.Patch.Type> {
  const kept = (pointer: string) => isWithin(pointer, gameHeader) || isWithin(pointer, gamePlays)
  return patches.filter((patch) => kept(patch.path) && (!("from" in patch) || kept(patch.from)))
}

function isWithin(pointer: string, root: string): boolean {
  return pointer === root || pointer.startsWith(`${root}/`)
}

/** The play ids `patches` touch, at their path or their `from`; none when one patches the plays whole. */
function playsTouched(
  patches: ReadonlyArray<typeof FastCastMessage.Patch.Type>
): Option.Option<ReadonlyArray<string>> {
  const pointers = patches
    .flatMap((patch) => ("from" in patch ? [patch.path, patch.from] : [patch.path]))
    .filter((pointer) => isWithin(pointer, gamePlays))
  if (pointers.includes(gamePlays)) return Option.none()

  return Option.some(Arr.dedupe(pointers.flatMap((pointer) => Option.toArray(Arr.get(tokens(pointer), 2)))))
}

/**
 * The document with `patch` applied. `JsonPatch` has no `copy` or `move`: a copy is an add of the value read at `from`,
 * a move a remove of `from` then that add.
 */
function patched(document: Schema.Json, patch: typeof FastCastMessage.Patch.Type): Effect.Effect<Schema.Json, string> {
  if ("from" in patch) {
    return Option.match(valueAt(document, tokens(patch.from)), {
      onNone: () => Effect.fail(`${described(patch)}: nothing at ${patch.from}`),
      onSome: (value) =>
        applied(
          document,
          [
            ...(patch.op === "move" ? [{ op: "remove" as const, path: patch.from }] : []),
            { op: "add", path: patch.path, value }
          ],
          patch
        )
    })
  }
  if (patch.op === "remove") return applied(document, [{ op: "remove", path: patch.path }], patch)

  return applied(document, [{ op: patch.op, path: patch.path, value: patch.value }], patch)
}

function described(patch: typeof FastCastMessage.Patch.Type): string {
  return `${patch.op} at ${patch.path}`
}
```

The `playsTouched` filter fixes a latent bug: a header pointer such as `/header/competitions/0/status` has token 2 `"0"`, which the old code would have counted as a play id once header patches are kept.

- [ ] **Step 6: Follow the changes in `FastCast.ts`, `TestEspn.ts`, `EspnPayload.ts`, `EspnEvent.ts`, `EspnState.ts`**

- `FastCast.ts`: `tcOf(topic)` → `topic.tc()`; `topicOf(tc)` → `Topic.fromTc(tc)`; import `{ Topic }` (a value now); `checkpoint(topic, url)` decodes with `Schema.decodeEffect(FastCastMessage.Checkpoint)(body)`. The `stopped` log message: `"FastCast: the live feed stopped; only the poll reaches the slate until the Hub restarts"` stays.
- `TestEspn.ts`: `topicOf` → `Topic.fromTc`; `FastCastMessage.Checkpoint(checkpointTopic)` → `FastCastMessage.Checkpoint`.
- `EspnPayload.ts`: delete `FastCastEvent`. Change the `EspnStatus` and `EspnSituation` doc comments from "as both feeds spell it" to "as the site scoreboard spells it".
- `EspnEvent.ts`: delete `PushedEvent`, `Moved`, `moved`, and the `FastCastEvent` import.
- `EspnState.ts`:
  - imports: drop `PushedEvent`, `Metric`, `Topic` stays (class), `tcOf` goes.
  - class doc: `What ESPN has said, every frame folded in once: each game topic's document, and each league's listed games, as its last poll showed them. Which snapshot wins is the Slate's rule, not the state's.`
  - `take` doc: delete the scoreboard sentence (`A scoreboard topic's change … is not delivered.`).
  - `wanted`: no scoreboards:

```ts
  /**
   * What FastCast follows at `now`: the topic of each listed game live or kicking off within
   * `GameSnapshot.kickoffWindow`, each with whether its document is synced.
   */
  wanted(now: DateTime.Utc): Wanted {
    const topics = this.games()
      .filter((game) => game.isLiveOrKicksOffWithin(GameSnapshot.kickoffWindow, now))
      .map((game) => new Topic({ league: game.league, game: game.id }))
    return HashMap.fromIterable(
      topics.map((topic) => [topic, this.documents.isSynced(topic) ? "Synced" : "AwaitingCheckpoint"] as const)
    )
  }
```

  - `wanted` no longer takes `leagues`. Follow it in `retained` (`this.wanted(now)`, `const games = new Set([...HashMap.keys(wanted)].map((topic) => topic.game))`), in `EspnProvider.ts` `wantedOf` (`state.wanted(now)`; drop its `leagues` parameter), and in `take` (`next.retained(now)`; `take(frame)` keeps its `leagues` parameter only if something else still needs it. If nothing does, drop it and follow every caller: `EspnProvider.takeFrame`, `TestEspn.decodedFrames`, `TestEspn.stateAfter`, and `EspnState.test.ts`).
  - `pushed`: delete the `Scoreboard` branch. `Reset` logs `${topic.tc()}`.
  - delete `movesOf`, `pushBehind`, `movedForward`, `decodePushed`, `decodePushedOf`, `pushesBehind`; `annotationsOf` uses `Option.map(topic, (each) => each.tc())` and `topic.tc()`.
  - The `Game` branch is unchanged in this task: it ignores `header`.
- `telemetry/dashboards/hub.json`: delete the whole panel whose target expr is `sum by (league) (increase(sportal_push_behind_listing_total[$__rate_interval])) or vector(0)`, and close the gap in the `gridPos` `y` of the panels below it if the layout leaves a hole (check that the JSON still parses: `node -e "JSON.parse(require('fs').readFileSync('telemetry/dashboards/hub.json','utf8'))"`).

- [ ] **Step 7: Rewrite the tests that used scoreboard topics**

Run `pnpm typecheck` and fix every test that no longer compiles, as follows. In the commit body, list each removed or rewritten test name with what replaced it (or "removed: scoreboard topics are gone").

- `FastCast.test.ts`: the topic under test becomes `new Topic({ league: "nfl", game: GameId.make("401872971") })`, tc `gp-football-nfl-401872971`, everywhere `event-football-nfl` and `scoreboard` appear. `checkpointDocument` decodes the move recording's checkpoint body (`fixtures/nfl-gp-move-2026-10-04.json`, `checkpoint.body`, stringified) with `FastCastMessage.Checkpoint`. Delete `RecordedScoreboard` and `recordedEvents`; a test that asserted on recorded scoreboard events asserts on the decoded game document instead (`entities.plays` keys). Every test keeps its name and its behaviour; only the topic and document change.
- `EspnProvider.test.ts` (lines ~339, ~427, ~463, ~480): checkpoint frames and `Wanted` entries use a game topic of a game live in the listing the test polls; the test at ~480 that expected `[Topic.Scoreboard({ league: "fbs" }), "AwaitingCheckpoint"]` now expects only game topics.
- `EspnEvent.test.ts`: delete the `PushedEvent` tests.
- `EspnState.test.ts`:
  - Delete (removed with scoreboard topics): "should push a snapshot of every listed game on a checkpoint, advanced to its listed game"; "should end each live game where the scoreboard had it, after the checkpoint and every message"; "should orient the yard line for the team with the ball, keeping possession where the scoreboard drops it"; "should deliver no pushed game a listing lacks"; "should count a push behind its listed game by its league"; "should log a push behind its listed game at Info, with its game"; "should count no push that moves its listed game forward"; "should touch no metric but the count of pushes behind their listed game"; "should move a listed game forward in its listing on a push"; "should list a poll's games as it shows them, even one a push moved past it"; "should deliver a poll's own games in its listing, whatever a push moved forward"; "should change nothing when removing a whole event the document does not have"; "should give a scoreboard checkpoint each pushed game's Snapshot"; "should want each league's scoreboard topic, waiting for its checkpoint, before any frame"; "should not want the topic of a game a push shows over"; "should want no game's topic a push shows before any poll lists it". (The last three come back in Task 3 on game topics where they still apply.)
  - "the recorded feeds decode to the same games" / "should decode each listing and push": keep only the two polls. Cut the fixture: `node -e` script that reads `fixtures/decoded-snapshots.json`, keeps `deliveries` from frames 1 and 2 only (drop entries whose `frame` is 3), deletes `checkpointEvents`, and writes it back. Rename the test "should decode each listing". Delete "should read each checkpoint event as what it moves".
  - Convert to the game topic `gp-football-nfl-401872971` and the move recording (`moveRecordingFrames()`), keeping the test name and assertion: "should add the value read at a copy's source" (copy a play field, e.g. `/entities/plays/<id>/text` from one recorded play to another), "should send only the topic that missed a message back to waiting for a checkpoint" (two game topics: the move recording's and `gp-football-nfl-401872966` from a `checkpoint(...)` of `plays("…")`), "should give nothing and fail nothing for a patch or an idle message before any checkpoint", "should send a topic back to waiting for a checkpoint when a patch will not apply" (a replace at `/entities/plays/no-such-play/text`), "should reset a synced topic on a message that does not decode" (op `test` at `/entities/plays`), "should log a topic that lost its document at Warning, with why and its topic", the `it.effect.each` reset cases, "should reset no topic that was never synced", "should sync a waiting topic on the next checkpoint that decodes", "should keep the other games and the scoreboard decoding after a gap on one game's topic" (rename: "should keep the other games decoding after a gap on one game's topic"), "should give a message that changes no document no deliveries", "should give a frame that resets its topic no deliveries", "should give one array of deliveries per frame".
  - Delete the helpers only scoreboard tests used: `synced`, `beforeAnyCheckpoint` (rebuild it on the game topic if a converted test needs it), `neAtBufFinal`, `scoreReplaced`, `unapplicablePatch`, `undecodablePatch`, `checkpointEvents`, `lastPushed`, `inPlay`, `recorded`, `socketTexts`, `checkpointBody`, `ariAtNyg`, `neAtBuf`. Keep `poll`, `checkpoint` (now `Schema.decodeSync(FastCastMessage.Checkpoint)`), `message`, `topicNamed` (`Option.getOrThrow(Topic.fromTc(tc))`), `playsMessage`, `plays`, `tags`, `playIds`, `moveRecordingFrames`.
  - `lostBetween` maps `(topic) => topic.tc()`.
- When no test reads `nfl-fastcast-checkpoint-2026-10-04T1752Z.json` or `nfl-fastcast-messages-2026-10-04T1752Z.jsonl` (`grep -rn "fastcast-checkpoint-2026-10-04\|fastcast-messages-2026-10-04" apps`), `git rm` them.

- [ ] **Step 8: Run everything**

Run: `pnpm check`
Expected: PASS. Then `grep -rn "Scoreboard\b\|PushedEvent\|FastCastEvent\|push_behind\|tcOf\|topicOf" apps telemetry` lists nothing but `EspnPayload.ts`'s site `Scoreboard`, `EspnProvider.ts`'s `scoreboardUrl`, and their tests.

- [ ] **Step 9: Commit**

```bash
git add apps/hub/src/provider/espn telemetry/dashboards/hub.json
git commit -m "refactor: follow only FastCast game topics

Scoreboard topics, pushed events and push-behind counting go; the poll
is the only source of snapshots until game headers are read.

<old test name → new test name / removed, one per line>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Read a game's header and its situation

**Files:**
- Modify: `apps/hub/src/provider/espn/EspnPayload.ts`
- Modify: `apps/hub/src/provider/espn/EspnEvent.ts` (export `statusOf`, `scoreOf`)
- Create: `apps/hub/src/provider/espn/EspnHeader.ts`, `EspnHeader.test.ts`
- Modify: `packages/domain/src/Situation.ts`, `packages/domain/src/Situation.test.ts` (create the test file if it doesn't exist)
- Modify: `CONTEXT.md` (an **ESPN header** row, beside **ESPN event**)

**Interfaces:**
- Consumes: the fixtures above.
- Produces: `EspnHeader(league: LeagueId)`: a `Schema` decoding a header competition (`Schema.Json`) to `{ status: GameStatus; period: number; clock: string; homeScore: number; awayScore: number; homeTimeouts: number; awayTimeouts: number; possession?: TeamId | undefined }`.
- Produces: `Situation.after(play: Play, side: { readonly possession?: TeamId | undefined; readonly homeTimeouts: number; readonly awayTimeouts: number }): Situation`.

- [ ] **Step 1: Write the failing header tests**

`apps/hub/src/provider/espn/EspnHeader.test.ts`:

```ts
import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { EspnHeader } from "./EspnHeader.ts"

// Recorded 2026-10-10 00:22Z: FSU at LOU live in the second quarter, IOWA at WASH 38 minutes before kickoff.
const headerOf = (name: string) =>
  Schema.decodeSync(
    Schema.fromJsonString(Schema.Struct({ header: Schema.Struct({ competitions: Schema.Tuple([Schema.Json]) }) }))
  )(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")).header.competitions[0]
const live = headerOf("fbs-gp-checkpoint-2026-10-10T0022Z")
const pregame = headerOf("fbs-gp-pregame-2026-10-10T0022Z")

const decodeFbs = Schema.decodeUnknownEffect(EspnHeader("fbs"))

describe("EspnHeader", () => {
  it.effect("should read a live header's status, period, clock and scores", () =>
    Effect.gen(function* () {
      const moved = yield* decodeFbs(live)

      assert.deepStrictEqual(
        { status: moved.status, period: moved.period, clock: moved.clock, home: moved.homeScore, away: moved.awayScore },
        { status: "live", period: 2, clock: "3:20", home: 14, away: 14 }
      )
    })
  )

  it.effect("should read each side's timeouts left as three a half less those used", () =>
    Effect.gen(function* () {
      const moved = yield* decodeFbs(live)

      assert.deepStrictEqual([moved.homeTimeouts, moved.awayTimeouts], [3, 2])
    })
  )

  it.effect("should read no team with the ball when neither side has possession", () =>
    Effect.gen(function* () {
      const moved = yield* decodeFbs(live)

      assert.isUndefined(moved.possession)
    })
  )

  it.effect("should read the side with possession as its league's team", () =>
    Effect.gen(function* () {
      const withBall = patchedCompetitor(live, 1, { possession: true })

      const moved = yield* decodeFbs(withBall)

      assert.strictEqual(moved.possession, "fbs:52")
    })
  )

  it.effect("should read a header before kickoff as scheduled, period 0, clock 0:00, no score, all timeouts", () =>
    Effect.gen(function* () {
      const moved = yield* decodeFbs(pregame)

      assert.deepStrictEqual(
        {
          status: moved.status,
          period: moved.period,
          clock: moved.clock,
          home: moved.homeScore,
          away: moved.awayScore,
          timeouts: [moved.homeTimeouts, moved.awayTimeouts]
        },
        { status: "scheduled", period: 0, clock: "0:00", home: 0, away: 0, timeouts: [3, 3] }
      )
    })
  )

  it.effect("should not decode a header without a home side", () =>
    Effect.gen(function* () {
      const awayOnly = { ...asObject(live), competitors: [asArray(asObject(live).competitors)[1]] }

      const result = yield* Effect.result(decodeFbs(awayOnly))

      assert.strictEqual(result._tag, "Failure")
    })
  )
})

function asObject(json: Schema.Json): { readonly [key: string]: Schema.Json } {
  return Schema.decodeSync(Schema.Record(Schema.String, Schema.Json))(json)
}

function asArray(json: Schema.Json | undefined): ReadonlyArray<Schema.Json> {
  return Schema.decodeSync(Schema.Array(Schema.Json))(json)
}

/** `header` with competitor `index`'s fields replaced by `fields`. */
function patchedCompetitor(header: Schema.Json, index: number, fields: object): Schema.Json {
  const competitors = asArray(asObject(header).competitors).map((competitor, at) =>
    at === index ? { ...asObject(competitor), ...fields } : competitor
  )
  return { ...asObject(header), competitors }
}
```

Run: `pnpm vitest run apps/hub/src/provider/espn/EspnHeader.test.ts`. Expected: FAIL, `./EspnHeader.ts` does not exist.

- [ ] **Step 2: Add the wire schema to `EspnPayload.ts`**

Append:

```ts
/**
 * A game package's `header.competitions[0]`: its status (no period or clock before kickoff) and each side's score,
 * timeouts used this half, and whether it has the ball.
 */
export const GameHeader = Schema.Struct({
  status: Schema.Struct({
    period: Schema.optional(Schema.Int),
    displayClock: Schema.optional(Schema.String),
    type: EspnStatus.fields.type
  }),
  competitors: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      homeAway: Schema.Literals(["home", "away"]),
      score: Schema.optional(Schema.String),
      timeoutsUsed: Schema.optional(Schema.Int),
      possession: Schema.optional(Schema.Boolean)
    })
  )
})
```

- [ ] **Step 3: Export `statusOf` and `scoreOf` from `EspnEvent.ts`**

Change `function scoreOf` and `function statusOf` to `export function`, each with a one-line doc comment (`/** A side's score: digits, or nothing before kickoff, which reads as 0. */`, `/** The domain status ESPN's status type says: by its name when the table knows it, else by its state. */`). Leave them where they are.

- [ ] **Step 4: Write `EspnHeader.ts`**

```ts
import { GameStatus } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { TeamId } from "@sportal/domain/Team"
import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect"
import { scoreOf, statusOf, teamId } from "./EspnEvent.ts"
import { GameHeader } from "./EspnPayload.ts"

/**
 * A game package's header competition, read as what it moves of a `league` game: its status, period, clock and scores,
 * each side's timeouts left this half, and the team with the ball, if one has it. Before kickoff it has no period or
 * clock, which read as 0 and "0:00". A header without a home and an away side does not decode.
 */
export function EspnHeader(league: LeagueId) {
  return GameHeader.pipe(
    Schema.decodeTo(Schema.toType(HeaderMoves), {
      decode: SchemaGetter.transformEffect((header) => moves(league, header)),
      encode: SchemaGetter.forbidden(() => "A header's moves cannot be encoded back to an ESPN header")
    })
  )
}

const HeaderMoves = Schema.Struct({
  status: GameStatus,
  period: Schema.Int,
  clock: Schema.String,
  homeScore: Schema.Int,
  awayScore: Schema.Int,
  homeTimeouts: Schema.Int,
  awayTimeouts: Schema.Int,
  possession: Schema.optional(TeamId)
})

const moves = Effect.fnUntraced(function* (league: LeagueId, header: typeof GameHeader.Type) {
  const home = header.competitors.find((competitor) => competitor.homeAway === "home")
  const away = header.competitors.find((competitor) => competitor.homeAway === "away")
  if (home === undefined || away === undefined) {
    return yield* Effect.fail(
      new SchemaIssue.InvalidValue({ message: "A header needs a home and an away side" }, header)
    )
  }

  const withBall = header.competitors.find((competitor) => competitor.possession === true)
  return {
    status: statusOf(header.status.type),
    period: header.status.period ?? 0,
    clock: header.status.displayClock ?? "0:00",
    homeScore: scoreOf(home.score),
    awayScore: scoreOf(away.score),
    homeTimeouts: timeoutsLeft(home.timeoutsUsed),
    awayTimeouts: timeoutsLeft(away.timeoutsUsed),
    ...(withBall === undefined ? {} : { possession: teamId(league, withBall.id) })
  }
})

// Each side has three timeouts a half; ESPN counts those used this half.
function timeoutsLeft(used: number | undefined): number {
  return Math.max(0, 3 - (used ?? 0))
}
```

Run: `pnpm vitest run apps/hub/src/provider/espn/EspnHeader.test.ts`. Expected: PASS.

- [ ] **Step 5: Confirm the timeouts rule against the halftime recording**

The planner's recorder (`/tmp/claude-1000/-home-chazzy-development-projects-sportal/c18ac9cc-dd55-4986-9b66-2a5c5ef8b2e0/scratchpad/record.mjs`, output `/tmp/claude-1000/-home-chazzy-development-projects-sportal/c18ac9cc-dd55-4986-9b66-2a5c5ef8b2e0/scratchpad/rec/messages.jsonl`) recorded FSU @ LOU through halftime. Find the `timeoutsUsed` patches on `gp-football-college-football-401858254` and the period they fall in:

```bash
python3 - <<'EOF'
import json,zlib,base64
period=None
for line in open('/tmp/claude-1000/-home-chazzy-development-projects-sportal/c18ac9cc-dd55-4986-9b66-2a5c5ef8b2e0/scratchpad/rec/messages.jsonl'):
    m=json.loads(json.loads(line)['text'])
    if m.get('tc')!='gp-football-college-football-401858254' or m.get('op') not in ('P','R'): continue
    pl=json.loads(m['pl'])['pl']
    if isinstance(pl,str): pl=json.loads(zlib.decompress(base64.b64decode(pl)))
    for p in pl:
        if p['path']=='/header/competitions/0/status/period': period=p['value']
        if 'timeoutsUsed' in p['path']: print(m['mid'], 'period', period, p['path'], p.get('value'))
EOF
```

Expected: both sides' `timeoutsUsed` go back to 0 when the period becomes 3. If they don't (ESPN counts the game, not the half), change `timeoutsLeft` and its comment to what the recording shows, and change the test name and expected values to match. If the recording is gone, leave the rule as is and record "unverified" in the spec's open check 1 (Task 4).

- [ ] **Step 6: Write the failing `Situation.after` tests**

In `packages/domain/src/Situation.test.ts` (create it if missing; use `TestGame.ts`'s play builder if `packages/domain` has one, otherwise decode a `Play` literal with `Schema.decodeUnknownSync(Play)`, as `Play.test.ts` does):

```ts
describe("Situation.after", () => {
  it("should read the down, distance and ball from the play's end, for the team with the ball", () => {
    const play = rushEndingAt({ team: "fbs:52", down: 4, distance: 12, yardsToEndzone: 42 })

    const situation = Situation.after(play, { possession: TeamId.make("fbs:52"), homeTimeouts: 2, awayTimeouts: 2 })

    assert.deepStrictEqual(
      [situation.possession, situation.down, situation.distance, situation.yardLine],
      ["fbs:52", 4, 12, 42]
    )
  })

  it("should turn the ball round when the other team has it after the play", () => {
    const play = rushEndingAt({ team: "fbs:52", yardsToEndzone: 42 })

    const situation = Situation.after(play, { possession: TeamId.make("fbs:97"), homeTimeouts: 3, awayTimeouts: 3 })

    assert.strictEqual(situation.yardLine, 58)
  })

  it("should place no ball when no team has it", () => {
    const play = rushEndingAt({ team: "fbs:97", yardsToEndzone: 0 })

    const situation = Situation.after(play, { homeTimeouts: 3, awayTimeouts: 2 })

    assert.deepStrictEqual([situation.possession, situation.yardLine], [undefined, undefined])
  })

  it("should carry the play's text and each side's timeouts", () => {
    const play = rushEndingAt({ team: "fbs:52", yardsToEndzone: 42 })

    const situation = Situation.after(play, { homeTimeouts: 1, awayTimeouts: 2 })

    assert.deepStrictEqual([situation.lastPlay, situation.homeTimeouts, situation.awayTimeouts], [play.text, 1, 2])
  })
})
```

`rushEndingAt(end)` builds a `Rush` play (`_tag: "Rush"`, `touchdown: false`, `yards: 3`, any id, sequence 1, period 2, clock "3:20", text "a rush", scoring false, scores 0, `start: { team: end.team }`, `end`), decoded through `Play` so its team ids are `TeamId`s. Put it at the bottom of the test file.

Run: `pnpm vitest run packages/domain/src/Situation.test.ts`. Expected: FAIL, `Situation.after` does not exist.

- [ ] **Step 7: Write `Situation.after`**

In `packages/domain/src/Situation.ts`, import `type { Play } from "./Play.ts"`, and add as the class's first static:

```ts
  /**
   * The situation after `play`: its end's down and distance, the ball for the team `side` says has it (none when no team
   * has it), the play's text, and each side's timeouts left.
   */
  static after(
    play: Play,
    side: { readonly possession?: TeamId | undefined; readonly homeTimeouts: number; readonly awayTimeouts: number }
  ): Situation {
    const { end } = play
    const yardLine =
      side.possession === undefined || end.team === undefined || end.yardsToEndzone === undefined
        ? undefined
        : end.team === side.possession
          ? end.yardsToEndzone
          : 100 - end.yardsToEndzone
    return new Situation({
      ...(side.possession === undefined ? {} : { possession: side.possession }),
      ...(end.down === undefined ? {} : { down: end.down }),
      ...(end.distance === undefined ? {} : { distance: end.distance }),
      ...(yardLine === undefined ? {} : { yardLine }),
      homeTimeouts: side.homeTimeouts,
      awayTimeouts: side.awayTimeouts,
      lastPlay: play.text
    })
  }
```

If `Play`'s exported type is not the union of every case (check `packages/domain/src/Play.ts`), use the type that is (`typeof Play.Type`).

Run: `pnpm vitest run packages/domain/src/Situation.test.ts`. Expected: PASS.

- [ ] **Step 8: Glossary**

In `CONTEXT.md`, under **ESPN event**, add:

`| **ESPN header** | A game package's header competition, read as what it moves: status, period, clock, scores, each side's timeouts left this half, and the team with the ball (`EspnHeader` in code). Before kickoff it has no period or clock. | game header, gp header |`

Change **ESPN event** to drop the FastCast clause: `The site scoreboard's event, read as a GameSnapshot (`EspnEvent` in code).`

- [ ] **Step 9: Run and commit**

Run: `pnpm check`. Expected: PASS (knip may flag `EspnHeader` as unused in production until Task 3; if it does, do Task 3 before committing and commit both together).

```bash
git add apps/hub/src/provider/espn/EspnPayload.ts apps/hub/src/provider/espn/EspnEvent.ts \
  apps/hub/src/provider/espn/EspnHeader.ts apps/hub/src/provider/espn/EspnHeader.test.ts \
  packages/domain/src/Situation.ts packages/domain/src/Situation.test.ts CONTEXT.md
git commit -m "feat: read a FastCast game header and the situation after a play

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: A game topic delivers its game's snapshot

**Files:**
- Modify: `apps/hub/src/provider/espn/EspnState.ts`, `EspnState.test.ts`

**Interfaces:**
- Consumes: `DocumentChange.Game` with `header` (Task 1), `EspnHeader(league)` and `Situation.after` (Task 2).
- Produces: on each game change, `Plays` when `touched` is none or names a play, then `Snapshot` when a listing has the game and its header decodes; the listing's game moved to that snapshot.

- [ ] **Step 1: Write the failing tests**

Add to `EspnState.test.ts`, in a new `describe("a game's header", …)` inside `describe("EspnState#take")`. Fixture constants at the top of the file:

```ts
// Recorded 2026-10-10: the FBS scoreboard at 00:12Z with FSU at LOU live and IOWA at WASH ahead; FSU at LOU's game
// topic checkpoint at mid 386 and the 59 socket texts after it; IOWA at WASH's checkpoint before kickoff.
const fbsListing = fixture("fbs-scoreboard-2026-10-10T0012Z.json")
const fsuAtLou = "gp-football-college-football-401858254"
const iowaAtWash = "gp-football-college-football-401858487"
const fsuAtLouCheckpoint = JSON.parse(fixture("fbs-gp-checkpoint-2026-10-10T0022Z.json"))
const iowaAtWashCheckpoint = JSON.parse(fixture("fbs-gp-pregame-2026-10-10T0022Z.json"))
const fsuAtLouTexts = Schema.decodeSync(Schema.Array(Schema.fromJsonString(Schema.String)))(
  fixture("fbs-gp-messages-2026-10-10T0022Z.jsonl").trim().split("\n")
)
```

Helpers at the bottom:

```ts
/** FSU at LOU's recorded socket texts after its checkpoint, as FastCast frames them. */
function fsuAtLouMessages(): ReadonlyArray<Frame> {
  return fsuAtLouTexts.map((body) => {
    const envelope = decodeEnvelope(body)
    const framed = Option.getOrThrow(Option.flatMap(envelope, decodeFramed))
    return Frame.Pushed({
      topic: Topic.fromTc(fsuAtLou),
      mid: "mid" in framed ? Option.some(framed.mid) : Option.none(),
      envelope
    })
  })
}

/** The last `Snapshot` of `game` among `deliveries`. */
function lastSnapshotOf(deliveries: ReadonlyArray<{ readonly delivery: Delivery }>, game: string) {
  return deliveries
    .flatMap(({ delivery }) => (Delivery.$is("Snapshot")(delivery) && delivery.snapshot.id === game ? [delivery.snapshot] : []))
    .at(-1)
}
```

Tests:

```ts
  describe("a game's header", () => {
    it.effect("should deliver a listed game's snapshot from its checkpoint's header", () =>
      Effect.gen(function* () {
        const frames = [poll("fbs", fbsListing), checkpoint(fsuAtLou, 386, fsuAtLouCheckpoint)]

        const deliveries = yield* decoded(frames)

        const snapshot = lastSnapshotOf(deliveries, "401858254")
        assert.deepStrictEqual(
          [snapshot?.status, snapshot?.period, snapshot?.clock, snapshot?.home.score, snapshot?.away.score],
          ["live", 2, "3:20", 14, 14]
        )
      })
    )

    it.effect("should keep the listed game's teams, kickoff and broadcasts", () =>
      Effect.gen(function* () {
        const frames = [poll("fbs", fbsListing), checkpoint(fsuAtLou, 386, fsuAtLouCheckpoint)]

        const deliveries = yield* decoded(frames)

        const listed = deliveries.flatMap(({ delivery }) =>
          Delivery.$is("Listing")(delivery) ? delivery.games.filter((game) => game.id === "401858254") : []
        )[0]
        const snapshot = lastSnapshotOf(deliveries, "401858254")
        assert.deepStrictEqual(
          [snapshot?.home.team, snapshot?.away.team, snapshot?.kickoff, snapshot?.broadcasts],
          [listed?.home.team, listed?.away.team, listed?.kickoff, listed?.broadcasts]
        )
      })
    )

    it.effect("should read the situation from the latest play after every recorded message", () =>
      Effect.gen(function* () {
        const frames = [poll("fbs", fbsListing), checkpoint(fsuAtLou, 386, fsuAtLouCheckpoint), ...fsuAtLouMessages()]

        const deliveries = yield* decoded(frames)

        const snapshot = lastSnapshotOf(deliveries, "401858254")
        assert.deepStrictEqual(
          {
            clock: snapshot?.clock,
            possession: snapshot?.situation?.possession,
            down: snapshot?.situation?.down,
            distance: snapshot?.situation?.distance,
            yardLine: snapshot?.situation?.yardLine,
            timeouts: [snapshot?.situation?.homeTimeouts, snapshot?.situation?.awayTimeouts]
          },
          { clock: "0:44", possession: "fbs:52", down: 4, distance: 12, yardLine: 42, timeouts: [2, 2] }
        )
      })
    )

    it.effect("should give a game before kickoff no situation", () =>
      Effect.gen(function* () {
        const frames = [poll("fbs", fbsListing), checkpoint(iowaAtWash, 89, iowaAtWashCheckpoint)]

        const deliveries = yield* decoded(frames)

        const snapshot = lastSnapshotOf(deliveries, "401858487")
        assert.deepStrictEqual([snapshot?.status, snapshot?.situation], ["scheduled", undefined])
      })
    )

    it.effect("should deliver only a snapshot for a message that changes only the header", () =>
      Effect.gen(function* () {
        const clockTick = message(fsuAtLou, 387, [
          { op: "replace", path: "/header/competitions/0/status/displayClock", value: "3:10" }
        ])
        const frames = [poll("fbs", fbsListing), checkpoint(fsuAtLou, 386, fsuAtLouCheckpoint), clockTick]

        const deliveries = yield* decoded(frames)

        const last = deliveries.filter(({ frame }) => frame === 3)
        assert.deepStrictEqual(tags(last), ["Snapshot"])
        assert.strictEqual(lastSnapshotOf(last, "401858254")?.clock, "3:10")
      })
    )

    it.effect("should deliver no snapshot of a game no listing has, but still its plays", () =>
      Effect.gen(function* () {
        const deliveries = yield* decoded([checkpoint(fsuAtLou, 386, fsuAtLouCheckpoint)])

        assert.deepStrictEqual(tags(deliveries), ["Plays"])
      })
    )

    it.effect("should stop wanting a game's topic once its header shows it over", () =>
      Effect.gen(function* () {
        const over = message(fsuAtLou, 387, [
          {
            op: "replace",
            path: "/header/competitions/0/status/type",
            value: { name: "STATUS_FINAL", state: "post" }
          }
        ])
        const state = yield* stateAfter([poll("fbs", fbsListing), checkpoint(fsuAtLou, 386, fsuAtLouCheckpoint), over])

        const wanted = state.wanted(DateTime.makeUnsafe("2026-10-10T00:30:00Z"))

        assert.isFalse(HashMap.has(wanted, Option.getOrThrow(Topic.fromTc(fsuAtLou))))
      })
    )
  })
```

`stateAfter` is `TestEspn.stateAfter` (already imported). If Task 1 kept a `leagues` argument on `take`/`wanted`, pass `LeagueId.literals`.

Run: `pnpm vitest run apps/hub/src/provider/espn/EspnState.test.ts -t "a game's header"`
Expected: FAIL. No `Snapshot` deliveries; "only a snapshot" gets `["Plays"]`.

- [ ] **Step 2: Implement the game branch**

In `EspnState.ts`, the `Game` branch of `pushed` becomes `Game: (change) => gameChanged(advanced, change)`, and below `pushed`:

```ts
/**
 * A game topic's change: the game's whole list of plays, when the change touched one, then its snapshot, when a
 * listing has the game and its header decodes: the listed game advanced to what the header moves, with the situation
 * after its latest play while it is live. The listing's game moves to that snapshot, so `wanted` follows its status.
 */
const gameChanged = Effect.fnUntraced(function* (
  state: EspnState,
  { league, game, header, plays, touched }: Data.TaggedEnum.Value<DocumentChange, "Game">
) {
  const byId = yield* playsAfter(state, game, league, plays, touched)

  const list = [...HashMap.values(byId)].toSorted(Play.order)
  const withPlays = new EspnState({ ...state, plays: HashMap.set(state.plays, game, byId) })
  const playsChanged = Option.match(touched, { onNone: () => true, onSome: (ids) => ids.length > 0 })
  const playsDelivered = playsChanged ? [Delivery.Plays({ game, plays: list })] : []

  const snapshot = yield* snapshotOf(withPlays, league, game, header, list)
  if (Option.isNone(snapshot)) return [withPlays, playsDelivered] as const

  const listing = withPlays.listing(league).map((each) => (each.id === game ? snapshot.value : each))
  const next = new EspnState({ ...withPlays, listings: HashMap.set(withPlays.listings, league, listing) })
  return [next, [...playsDelivered, Delivery.Snapshot({ snapshot: snapshot.value })]] as const
})

/** Game `game`'s listed snapshot advanced to what `header` moves; none when no listing has it or it does not decode. */
const snapshotOf = Effect.fnUntraced(function* (
  state: EspnState,
  league: LeagueId,
  game: GameId,
  header: Option.Option<Schema.Json>,
  plays: ReadonlyArray<Play>
) {
  const listed = Arr.findFirst(state.listing(league), (each) => each.id === game)
  if (Option.isNone(listed) || Option.isNone(header)) return Option.none<GameSnapshot>()

  const moved = yield* Effect.option(decodeHeader[league](header.value))
  if (Option.isNone(moved)) return Option.none<GameSnapshot>()

  const latest = Arr.last(plays)
  const situation =
    moved.value.status === "live" ? Option.map(latest, (play) => Situation.after(play, moved.value)) : Option.none()
  return Option.some(listed.value.advancedTo({ ...moved.value, situation: Option.getOrUndefined(situation) }))
})
```

Imports: `Situation` from `@sportal/domain/Situation`, `EspnHeader` from `./EspnHeader.ts`. Codecs at the bottom, beside the others:

```ts
const decodeHeader: { readonly [L in LeagueId]: ReturnType<typeof decodeHeaderOf> } = {
  nfl: decodeHeaderOf("nfl"),
  fbs: decodeHeaderOf("fbs")
}

function decodeHeaderOf(league: LeagueId) {
  return Schema.decodeUnknownEffect(EspnHeader(league))
}
```

Update the comment above the codecs: `// Each league's decode, built once: a site event, a game header, and a play entity.`

Update `take`'s doc: `A game topic's change is a Plays of the game's whole list, in Play.order, when it touched a play, then a Snapshot of the game, when a listing has it: its listed game advanced to what its header moves, with the situation after its latest play while it is live.`

Run: `pnpm vitest run apps/hub/src/provider/espn/EspnState.test.ts`. Expected: PASS. Tests from Task 1 that asserted exact deliveries of a game change may now see `Plays` missing on header-only messages or an added `Snapshot`; correct only those that are wrong because of this rule, and name each in the commit body.

- [ ] **Step 3: Run and commit**

Run: `pnpm check`. Expected: PASS.

```bash
git add apps/hub/src/provider/espn/EspnState.ts apps/hub/src/provider/espn/EspnState.test.ts
git commit -m "feat: deliver a game's snapshot from its FastCast header

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The poll lists every 15 minutes; docs

**Files:**
- Modify: `apps/hub/src/provider/espn/EspnState.ts` (`pollInterval`), `EspnState.test.ts` (`failedPolls` block)
- Modify: `apps/hub/src/provider/espn/EspnProvider.ts`, `EspnProvider.test.ts`
- Create: `docs/adr/0016-the-poll-lists-fastcast-plays.md`
- Modify: `docs/adr/0014-one-espn-fold.md` (status line), `CONTEXT.md`, `docs/technical-spec.md`, `docs/game-day-checklist.md`, `docs/specs/2026-10-09-poll-lists-fastcast-plays-design.md`

**Interfaces:**
- Produces: `EspnState#pollInterval(league: LeagueId): Duration.Duration`: 30 s while `league`'s last poll failed or didn't decode, else 15 minutes.

- [ ] **Step 1: Rewrite the cadence tests in `EspnProvider.test.ts`**

Delete: "should poll every 10 seconds while a game is live"; "should poll every 10 seconds while the only game is delayed in the second quarter"; the kickoff-window minute test(s) between them and "every 15 minutes otherwise"; "should poll every 15 minutes when a game delayed before kickoff is more than 30 minutes away"; "should poll a league with a live game every 10 seconds while the other league fails"; the test at ~239 with the same `polledOver(["10 seconds", …], { nfl: live, fbs: down })`; "should poll a league with no live game every 15 minutes while the other league's game is live"; "should poll every 10 seconds after a league fails during its own live game"; "should poll every 10 seconds after its own live game's scoreboard does not decode".

Add, using the file's `polledOver` helper and fixtures:

```ts
  it.effect("should poll every 15 minutes while a game is live", () =>
    Effect.gen(function* () {
      const polled = yield* polledOver("15 minutes", { fbs: live })

      assert.strictEqual(polled.fbs, 2)
    })
  )

  it.effect("should poll again 30 seconds after a poll that failed, during a live game", () =>
    Effect.gen(function* () {
      const polled = yield* polledOver(["15 minutes", "30 seconds"], { fbs: [live, down, live] })

      assert.strictEqual(polled.fbs, 3)
    })
  )

  it.effect("should poll again 30 seconds after a scoreboard that does not decode", () =>
    Effect.gen(function* () {
      const polled = yield* polledOver(["15 minutes", "30 seconds"], { fbs: [live, "not json", live] })

      assert.strictEqual(polled.fbs, 3)
    })
  )
```

Match the helper's real argument and result shapes (read `polledOver` at the bottom of the file); the expected counts above assume it counts the first poll at time 0. Keep "should poll every 15 minutes otherwise" as it is.

Run: `pnpm vitest run apps/hub/src/provider/espn/EspnProvider.test.ts`. Expected: FAIL on the 15-minute live test (it polls every 10 s).

- [ ] **Step 2: Two-way interval**

```ts
  /**
   * How long `league` waits after its latest poll has been taken: 15 minutes, since the poll only lists games and each
   * game's FastCast topic carries it live; 30 seconds while its last poll failed or did not decode, so its scoreboard is
   * read again soon.
   */
  pollInterval(league: LeagueId): Duration.Duration {
    return HashSet.has(this.failedPolls, league) ? Duration.seconds(30) : Duration.minutes(15)
  }
```

In `EspnProvider.ts`: `next.pollInterval(league.value)`, drop the now-unused `now` in `takeFrame` if nothing else reads it. Rewrite the layer's doc comment:

```ts
/**
 * ESPN as the provider: the site scoreboard of each league `HubConfig` names, polled for its listing of games, and
 * FastCast pushing each listed game's topic while it is live or within 30 minutes of kickoff, every frame folded, in
 * the order it arrives, into one `EspnState` by one fold. Each league polls every 15 minutes, and 30 seconds after a
 * poll that failed or did not decode. A poll's request and body read are bounded to 20 seconds; a poll that fails or
 * times out is logged and is a `PollFailed` frame. FastCast keeps no document of a topic it no longer follows. Each
 * run of `deliveries` polls and follows on its own.
 */
```

In `EspnState.test.ts`, "should distinguish a successful empty listing from a failed poll" calls `pollInterval("nfl")`; expect 30 s for the failed state and 15 minutes for the empty listing.

Run: `pnpm vitest run apps/hub/src/provider/espn`. Expected: PASS.

- [ ] **Step 3: ADR 0016**

`docs/adr/0016-the-poll-lists-fastcast-plays.md`, in the shape of `0014-one-espn-fold.md` (read it first):

- **Context:** two live feeds said the same facts; the college scoreboard topic carries only ranked games (19 of 58 on 2026-10-09, missing a live unranked game); the game topic carries status, scores, timeouts, possession and plays.
- **Decision:** the site poll lists games every 15 minutes (30 s after a failure); FastCast follows only game topics, live or within 30 minutes of kickoff, and is each game's only live feed; a game's snapshot is its listed game advanced by its header, with the situation after its latest play.
- **Consequences:** a game's live state depends on FastCast; while the socket is down, scores stop until it reconnects and re-checkpoints (the 15-minute listing still moves them); no push-behind metric; one event decoder; ADR 0014's one fold stands.

Change ADR 0014's status line to add `Refined by 0016 (the poll lists, FastCast plays).`

- [ ] **Step 4: Glossary, technical spec, checklist, spec**

- `CONTEXT.md`: **ESPN state** becomes `Everything ESPN has said, each frame folded in once: each game topic's document, each league's listed games, as its last poll listed them and each game's header since, and which leagues' last poll failed or did not decode (a successful empty listing is normal); EspnState in apps/hub/src/provider/espn/EspnState.ts. Its take gives each frame's deliveries and, after a poll, keeps only the topics still wanted; its pollInterval is each league's wait after a poll: 15 minutes, or 30 seconds after one that failed.` **Document change** becomes `What a frame changed of the game topic documents: a game's header and its whole list of plays, or a topic sent back to waiting for its checkpoint (Reset); DocumentChange in code, beside FastCastDocuments.` Check every other row that says "scoreboard topic" (`grep -n "scoreboard topic\|PushedEvent" CONTEXT.md`) and correct it.
- `docs/technical-spec.md`: correct the line that mentions scoreboard topics or the live poll cadence (`grep -n "Scoreboard\|10 s\|10 seconds\|scoreboard topic" docs/technical-spec.md`) to the design above.
- `docs/game-day-checklist.md`: row 45 records the answer: `Confirmed 2026-10-09 on FSU @ LOU: gp-football-college-football-<id> subscribes and checkpoints with plays.` Any row about the scoreboard topic, push-behind panel, or 10-second poll is rewritten or removed (`grep -n "push\|scoreboard\|10 s" docs/game-day-checklist.md`). Add two rows after the last: "A game's clock and score on the strip move within seconds of ESPN's gamecast, with the Hub polling every 15 minutes" and "A game that ends shows Final within a minute, and its topic is dropped".
- The spec's open checks: 1 (timeouts) records Task 2 Step 5's result; 2 records "pre → in" if the recording shows it (`grep` the recorder's output for IOWA @ WASH's `status/type` patches after 01:00Z); 3 records whether FSU @ LOU's topic pushed `STATUS_FINAL`; 4 and 5 stay open unless the recording settles them. Also change §3's "It's only sent when the advanced snapshot differs from the listed game's" to "It's sent on every header or play change; the Slate drops one equal to the game's (`Game#snapshotTaken`)."

- [ ] **Step 5: Run and commit**

Run: `pnpm check`. Expected: PASS.

```bash
git add apps/hub/src/provider/espn docs CONTEXT.md
git commit -m "feat: poll ESPN only for its listing, every 15 minutes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: See it live

Not a code task. Needs a live game (Saturday 2026-10-10 has college games from 16:00Z).

- [ ] **Step 1:** Ask the user to run `pnpm dev` (agent-launched Electron misreports on this machine) with a live game on.
- [ ] **Step 2:** With them, check: the live game's score and clock move within seconds; its plays strip fills from kickoff; the Hub logs show `FastCast: connected`, subscriptions only to `gp-…` topics, no `lost its document` warnings in a quiet stretch; the site scoreboard is fetched every 15 minutes (Hub logs or network).
- [ ] **Step 3:** Record what was seen in `docs/game-day-checklist.md`'s new rows and commit.

---

## Self-review

- Spec coverage: §1 poll cadence → Task 4; §2 no scoreboard topics, `Topic` one case → Task 1; §3 header + plays document, `DocumentChange.Game` with header → Task 1, header decoder → Task 2, snapshot → Task 3; §4 unchanged parts → Global Constraints; docs and tests → Tasks 1–4; open checks → Task 2 Step 5, Task 4 Step 4, Task 5.
- Spec deviation: §3 said a `Snapshot` is sent only when it differs from the listed game's. This plan sends it on every header or play change and lets the Slate drop an equal one (`Game#snapshotTaken` returns the game itself on `Equal.equals`), which is simpler and already tested. Task 4 Step 4 updates the spec to say so.
- Types: `Topic.fromTc`/`tc()` (Task 1) are used in Tasks 1 and 3; `DocumentChange.Game.header: Option.Option<Schema.Json>` (Task 1) is read in Task 3; `EspnHeader(league)` output fields (Task 2) match `GameSnapshot#advancedTo`'s input plus `homeTimeouts`, `awayTimeouts` and `possession`, which `Situation.after`'s `side` reads.
