# FastCast Follows Game Topics Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove FastCast scoreboard topics so the site poll is each game's status and score and FastCast is only each game's plays.

**Architecture:** A deletion. FastCast follows only game topics (`gp-…`), as it already does for plays. Everything the scoreboard topic needed goes: its `Topic` case, uid-prefixed patch paths, its checkpoint schema, its half of `FastCastDocuments`, `PushedEvent`/`FastCastEvent`, `EspnState`'s `movedForward` and push-behind metric, and the dashboard panel. The poll, its cadence, the fold, `Provider`, `Delivery` and the Slate don't change.

**Tech Stack:** Effect 4, TypeScript (tsgo), Vitest with `@effect/vitest`, pnpm workspaces.

**Spec:** `docs/specs/2026-10-09-poll-lists-fastcast-plays-design.md`. **Branch:** `poll-lists-fastcast-plays`, based on `feature/game-day-grafana` (385512d), which is about to merge to main; once it has, rebase onto main before merging this.

## Global Constraints

- Read `AGENTS.md` before writing code; its module shapes, spellings and test rules apply.
- Effect 4 is newer than training data: read `apps/hub/node_modules/effect/AGENTS.md` and `ai-docs/src/index.md` before writing Effect code.
- Every exported type name is a term in `CONTEXT.md`.
- Tests: one behaviour per test, `should …` descriptions, arrange/act/assert, against recorded fixtures.
- `pnpm check` passes before every commit. Stage only the task's files.
- This change adds no new behaviour and no new module. If a step seems to need new production code beyond what it shows, stop and ask.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Game topics only

**Files:**
- Modify: `apps/hub/src/provider/espn/Topic.ts`, `Topic.test.ts`
- Modify: `apps/hub/src/provider/espn/FastCastMessage.ts`, `FastCastMessage.test.ts`
- Modify: `apps/hub/src/provider/espn/FastCastDocuments.ts`
- Modify: `apps/hub/src/provider/espn/FastCast.ts`, `FastCast.test.ts`
- Modify: `apps/hub/src/provider/espn/EspnState.ts`, `EspnState.test.ts`
- Modify: `apps/hub/src/provider/espn/EspnEvent.ts`, `EspnEvent.test.ts`, `EspnPayload.ts`
- Modify: `apps/hub/src/provider/espn/EspnProvider.ts`, `EspnProvider.test.ts`, `TestEspn.ts`
- Modify: `apps/hub/src/provider/espn/fixtures/decoded-snapshots.json`
- Delete: `fixtures/nfl-fastcast-checkpoint-2026-10-04T1752Z.json`, `fixtures/nfl-fastcast-messages-2026-10-04T1752Z.jsonl` once nothing reads them
- Delete: `fixtures/fbs-gp-messages-2026-10-10T0022Z.jsonl`, `fixtures/fbs-gp-pregame-2026-10-10T0022Z.json`, `fixtures/fbs-scoreboard-2026-10-10T0012Z.json` (cut for the dropped header design; unused)
- Modify: `telemetry/dashboards/hub.json`

**Interfaces:**
- Produces: `class Topic extends Data.Class<{ readonly league: LeagueId; readonly game: GameId }>` with `tc(): string` and `static fromTc(tc: string): Option.Option<Topic>`.
- Produces: `FastCastMessage.Patch` paths and `from` are `string` JSON Pointers; `FastCastMessage.Checkpoint` is a schema (no argument).
- Produces: `DocumentChange = Data.TaggedEnum<{ Game: { league; game; plays; touched }; Reset: { topic; detail } }>`.

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

Run: `pnpm vitest run apps/hub/src/provider/espn/Topic.test.ts`. Expected: FAIL (no `{ league, game }` constructor, no `fromTc`).

- [ ] **Step 2: Rewrite `Topic.ts`**

```ts
import { GameId } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Array as Arr, Data, Option } from "effect"

/** A FastCast game topic: one game's package, which carries its plays. */
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

Run the test again. Expected: PASS.

- [ ] **Step 3: `FastCastMessage.ts`**

Delete `EventPath` and its comment. `Patch` becomes:

```ts
/** One JSON Patch operation on a game topic's document; its paths are JSON Pointers into ESPN's game package. */
export const Patch = Schema.Union([
  Schema.Struct({ op: Schema.Literals(["add", "replace"]), path: Schema.String, value: Schema.Json }),
  Schema.Struct({ op: Schema.Literal("remove"), path: Schema.String }),
  Schema.Struct({ op: Schema.Literals(["copy", "move"]), path: Schema.String, from: Schema.String })
])
```

Delete `Checkpoint(topic)` and `ScoreboardCheckpoint`; rename `GameCheckpoint` to `Checkpoint`, exported, keeping its body and doc comment. Drop the `Topic` import. In `FastCastMessage.test.ts`, the helper's `tc: "event-football-nfl"` becomes `"gp-football-nfl-401872971"`, and any assertion on a decoded path's `{ uid, pointer }` becomes the plain pointer string.

- [ ] **Step 4: `FastCastDocuments.ts`**

- Class doc: `Each FastCast game topic's document, its plays by id at gamePlays: waiting for its checkpoint, or synced as of a message.`
- `advance` doc: replace `a scoreboard topic's touched events (every event, on a checkpoint), or all of a game topic's plays` with `all of a game topic's plays`.
- `DocumentChange` doc: `What a frame changed: a game topic's plays, by id, with the ids it touched (every one, when none), or a topic sent back to waiting for a checkpoint, and why.` Delete its `Scoreboard` case.
- `changeOf`:

```ts
/** What a game topic's document says: its whole list of plays, with the ones `touched` names. */
function changeOf(topic: Topic, document: Schema.Json, touched: Option.Option<ReadonlyArray<string>>): DocumentChange {
  return DocumentChange.Game({
    league: topic.league,
    game: topic.game,
    plays: objectAt(document, tokens(gamePlays)),
    touched
  })
}
```

- `moved`: `relevant(message.pl)`; the reduce calls `patched(patchedSoFar, patch)`; `const touched = playsTouched(patches)`.
- `relevant`, `playsTouched`, `patched`, `described` become:

```ts
/** Only the patches inside the plays: the rest of ESPN's game package is not kept. */
function relevant(
  patches: ReadonlyArray<typeof FastCastMessage.Patch.Type>
): ReadonlyArray<typeof FastCastMessage.Patch.Type> {
  const inPlays = (pointer: string) => pointer === gamePlays || pointer.startsWith(`${gamePlays}/`)
  return patches.filter((patch) => inPlays(patch.path) && (!("from" in patch) || inPlays(patch.from)))
}

/** The play ids `patches` touch, at their path or their `from`; none when one patches the plays whole. */
function playsTouched(
  patches: ReadonlyArray<typeof FastCastMessage.Patch.Type>
): Option.Option<ReadonlyArray<string>> {
  const pointers = patches.flatMap((patch) => ("from" in patch ? [patch.path, patch.from] : [patch.path]))
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

- Drop `Record` from the effect import if nothing else uses it.

- [ ] **Step 5: Follow the changes elsewhere**

- `FastCast.ts`: `tcOf(topic)` → `topic.tc()`; `topicOf(tc)` → `Topic.fromTc(tc)`; import `{ Topic }` as a value; `checkpoint(topic, url)` decodes with `Schema.decodeEffect(FastCastMessage.Checkpoint)(body)`.
- `TestEspn.ts`: `topicOf` → `Topic.fromTc`; `FastCastMessage.Checkpoint(checkpointTopic)` → `FastCastMessage.Checkpoint`.
- `EspnPayload.ts`: delete `FastCastEvent`; `EspnStatus` and `EspnSituation` docs say "as the site scoreboard spells it".
- `EspnEvent.ts`: delete `PushedEvent`, `Moved`, `moved` and the `FastCastEvent` import.
- `EspnState.ts`:
  - Class doc: `What ESPN has said, every frame folded in once: each game topic's document, and each league's listed games, as its last poll showed them. Which snapshot wins is the Slate's rule, not the state's.`
  - `take` doc: delete the scoreboard sentence (`A scoreboard topic's change … is not delivered.`).
  - `wanted` lists game topics only; it no longer needs `leagues`:

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

  - `retained(now)`: `this.wanted(now)`, and `const games = new Set([...HashMap.keys(wanted)].map((topic) => topic.game))`.
  - `take`: if `leagues` is now unused, drop the parameter and follow every caller (`EspnProvider.takeFrame`, `TestEspn.decodedFrames`, `TestEspn.stateAfter`, `EspnState.test.ts`). `EspnProvider`'s `wantedOf` calls `state.wanted(now)` and drops its `leagues` parameter.
  - `pushed`: delete the `Scoreboard` branch; `Reset` logs `topic.tc()`.
  - Delete `movesOf`, `pushBehind`, `movedForward`, `decodePushed`, `decodePushedOf`, `pushesBehind`, and the `Metric`, `PushedEvent`, `tcOf` imports. `annotationsOf` uses `Option.map(topic, (each) => each.tc())` and `topic.tc()`. The codecs comment: `// Each league's decode, built once: a site event and a play entity.`
- `EspnProvider.ts` doc comment: `It tells FastCast to follow each listed game live or within 30 minutes of kickoff, …` (drop "every league's scoreboard topic and").
- `telemetry/dashboards/hub.json`: delete the panel whose target expr is `sum by (league) (increase(sportal_push_behind_listing_total[$__rate_interval])) or vector(0)`. If that leaves a gap, move the panels below it up by its `gridPos.h`. Check the JSON parses: `node -e "JSON.parse(require('fs').readFileSync('telemetry/dashboards/hub.json','utf8'))"`.

- [ ] **Step 6: Rewrite the tests that used scoreboard topics**

Run `pnpm typecheck` and fix every test that no longer compiles, as below. In the commit body, list each removed or rewritten test name and what replaced it (or "removed: scoreboard topics are gone").

- `FastCast.test.ts`: the topic under test becomes `new Topic({ league: "nfl", game: GameId.make("401872971") })`, tc `gp-football-nfl-401872971`, wherever `event-football-nfl` and `scoreboard` appear. `checkpointDocument` decodes the move recording's checkpoint (`fixtures/nfl-gp-move-2026-10-04.json`, `checkpoint.body` stringified) with `FastCastMessage.Checkpoint`. Delete `RecordedScoreboard` and `recordedEvents`; a test that compared recorded scoreboard events compares the decoded game document instead. Every test keeps its name and behaviour; only the topic and document change.
- `EspnProvider.test.ts` (~339, ~427, ~463, ~480): checkpoint frames and `Wanted` entries use a game topic of a game live in the listing the test polls; the test at ~480 expects only game topics.
- `EspnEvent.test.ts`: delete the `PushedEvent` tests.
- `EspnState.test.ts`:
  - Delete: "should push a snapshot of every listed game on a checkpoint, advanced to its listed game"; "should end each live game where the scoreboard had it, after the checkpoint and every message"; "should orient the yard line for the team with the ball, keeping possession where the scoreboard drops it"; "should deliver no pushed game a listing lacks"; "should count a push behind its listed game by its league"; "should log a push behind its listed game at Info, with its game"; "should count no push that moves its listed game forward"; "should touch no metric but the count of pushes behind their listed game"; "should move a listed game forward in its listing on a push"; "should list a poll's games as it shows them, even one a push moved past it"; "should deliver a poll's own games in its listing, whatever a push moved forward"; "should change nothing when removing a whole event the document does not have"; "should give a scoreboard checkpoint each pushed game's Snapshot"; "should read each checkpoint event as what it moves"; "should want each league's scoreboard topic, waiting for its checkpoint, before any frame"; "should not want the topic of a game a push shows over"; "should want no game's topic a push shows before any poll lists it".
  - "should decode each listing and push": keep only the two polls. Cut the fixture with a `node -e` script that keeps `deliveries` entries whose `frame` is 1 or 2, deletes `checkpointEvents`, and writes `decoded-snapshots.json` back. Rename the test "should decode each listing".
  - Move to the game topic `gp-football-nfl-401872971` and `moveRecordingFrames()`, keeping each name (except where noted) and assertion: "should add the value read at a copy's source" (copy one recorded play's `/text` onto another's); "should send only the topic that missed a message back to waiting for a checkpoint" (two game topics: the move recording's and `gp-football-nfl-401872966` from `checkpoint(…, { entities: { plays: plays(…) } })`); "should give nothing and fail nothing for a patch or an idle message before any checkpoint"; "should send a topic back to waiting for a checkpoint when a patch will not apply" (replace at `/entities/plays/no-such-play/text`); "should reset a synced topic on a message that does not decode" (op `test` at `/entities/plays`); "should log a topic that lost its document at Warning, with why and its topic"; the `it.effect.each` reset cases; "should reset no topic that was never synced"; "should sync a waiting topic on the next checkpoint that decodes"; "should keep the other games and the scoreboard decoding after a gap on one game's topic" → "should keep the other games decoding after a gap on one game's topic"; "should give a message that changes no document no deliveries"; "should give a frame that resets its topic no deliveries"; "should give one array of deliveries per frame".
  - Delete helpers only scoreboard tests used: `synced`, `beforeAnyCheckpoint` (rebuild on the game topic if a moved test needs it), `neAtBufFinal`, `scoreReplaced`, `unapplicablePatch`, `undecodablePatch`, `checkpointEvents`, `lastPushed`, `inPlay`, `recorded`, `socketTexts`, `checkpointBody`, `ariAtNyg`, `neAtBuf`. Keep `poll`, `checkpoint` (decoding with `FastCastMessage.Checkpoint`), `message`, `topicNamed` (`Option.getOrThrow(Topic.fromTc(tc))`), `playsMessage`, `plays`, `tags`, `playIds`, `moveRecordingFrames`. `lostBetween` maps `(topic) => topic.tc()`.
  - Add, in `describe("a game's plays")`:

```ts
    // Recorded 2026-10-10 00:22Z: FSU at LOU's game topic checkpoint, live in the second quarter.
    it.effect("should decode a recorded college game's plays", () =>
      Effect.gen(function* () {
        const document = JSON.parse(fixture("fbs-gp-checkpoint-2026-10-10T0022Z.json"))

        const deliveries = yield* decoded([checkpoint("gp-football-college-football-401858254", 386, document)])

        const [plays] = deliveries.map(playIds)
        assert.strictEqual(plays?.length, 66)
        assert.strictEqual(plays?.at(-1), "401858254288")
      })
    )
```

  If fewer than 66 decode, the test fails: report the play ids that didn't decode rather than changing the expected count.
- When `grep -rn "fastcast-checkpoint-2026-10-04\|fastcast-messages-2026-10-04" apps` finds nothing, `git rm` those two fixtures. `git rm` the three unused `fbs-` fixtures listed under Files.

- [ ] **Step 7: Run everything**

Run: `pnpm check`. Expected: PASS.
Run: `grep -rn "PushedEvent\|FastCastEvent\|push_behind\|tcOf\|topicOf\|Topic.Scoreboard\|Topic.Game" apps telemetry`. Expected: nothing.
Run: `git diff --stat feature/game-day-grafana -- apps telemetry` (or `main`, once that branch has merged). Expected: more lines deleted than added. Report the numbers.

- [ ] **Step 8: Commit**

```bash
git add -A apps/hub/src/provider/espn telemetry/dashboards/hub.json
git commit -m "refactor: follow only FastCast game topics

The poll is each game's status and score; FastCast is each game's
plays. Scoreboard topics, pushed-event decoding and push-behind
counting go.

<old test name → new test name / removed, one per line>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Docs

**Files:**
- Create: `docs/adr/0016-fastcast-follows-game-topics-only.md`
- Modify: `docs/adr/0014-one-espn-fold.md`, `CONTEXT.md`, `docs/technical-spec.md`, `docs/game-day-checklist.md`

- [ ] **Step 1: ADR 0016**, in the shape of `0014-one-espn-fold.md` (read it first):
  - **Context:** the poll and the FastCast scoreboard topic said the same facts; the college scoreboard topic carries only ranked games (19 of 58 on 2026-10-09, missing a live unranked game), so it couldn't replace the poll.
  - **Decision:** FastCast follows only game topics, for plays; the poll stays each game's listing, status and score, on its current cadence.
  - **Consequences:** a live score moves with the poll (about 10 s), plays by push; one event decoder; no push-behind metric or panel; ADR 0014's one fold stands. Reading each game topic's header could make it the live score feed later; not done, since it adds about as much code as this removes.
  - ADR 0014's status line gains `Refined by 0016 (FastCast follows game topics only).` and its push-behind sentences get "(removed by 0016)".
- [ ] **Step 2: `CONTEXT.md`**: **ESPN event** becomes `The site scoreboard's event, read as a GameSnapshot (EspnEvent in code).` **ESPN state**: `each FastCast topic's document` → `each game topic's document`; drop `and each push since`. **Document change**: `What a frame changed of the game topic documents: a game's whole list of plays, or a topic sent back to waiting for its checkpoint (Reset); DocumentChange in code, beside FastCastDocuments.` Fix any other row `grep -n "scoreboard topic\|PushedEvent\|push behind" CONTEXT.md` finds. The **Slate** row's example "a poll lagging a pushed score" is no longer possible (no score is pushed); drop that example.
- [ ] **Step 3: `docs/technical-spec.md`**: correct each line `grep -n "scoreboard topic\|event-football\|PushedEvent\|push" docs/technical-spec.md` finds about the scoreboard topic.
- [ ] **Step 4: `docs/game-day-checklist.md`**: row 45 records `Confirmed 2026-10-09 on FSU @ LOU: gp-football-college-football-<id> subscribes and checkpoints with its plays.` Remove or rewrite rows about the scoreboard topic or the push-behind panel (`grep -n "push\|scoreboard topic\|behind" docs/game-day-checklist.md`).
- [ ] **Step 5: Run and commit**

Run: `pnpm check`. Expected: PASS.

```bash
git add docs/adr CONTEXT.md docs/technical-spec.md docs/game-day-checklist.md
git commit -m "docs: record FastCast following game topics only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Listings are the only snapshots

Since Task 1 nothing in production delivers `Delivery.Snapshot`: the scoreboard topic was its only source. And
`Game#listed`'s tie rule ("a listing is a poll and the push wins a tie") now compares one poll with an earlier poll: it
keeps the older one whenever clock and score are unchanged, which between plays hides a new down, distance and ball.
Both go.

**Files:**
- Modify: `apps/hub/src/provider/Provider.ts`, `Provider.test.ts`
- Modify: `apps/hub/src/Slate.ts`, `Slate.test.ts`
- Modify: `packages/domain/src/Game.ts`, `Game.test.ts`
- Modify: `apps/hub/src/Director.test.ts`, `apps/hub/src/HubServer.test.ts`
- Modify: `CONTEXT.md` (**Delivery**, **Slate** rows)

**Interfaces:**
- Produces: `Delivery = Data.TaggedEnum<{ Listing: { league; games }; Plays: { game; plays } }>`.
- Produces: `Slate#take` relists each game with `Game#snapshotTaken` (unchanged rule: a snapshot equal to or behind the
  game's is ignored, except an over game takes one ahead of its end).

- [ ] **Step 1: Write the failing Slate test**

In `Slate.test.ts`, beside the other listing tests, using the file's `listed`, `listing`, `live` and `withBall` helpers
(read them first):

```ts
  it("should take a later listing at the same clock and score, for its new down and ball", () => {
    const slate = listed(withBall(live(one, "10:00"), 60))

    const next = slate.take([listing("fbs", [withBall(live(one, "10:00"), 45)])])[0]

    assert.strictEqual(next.games[0]?.snapshot.situation?.yardLine, 45)
  })
```

If `withBall` doesn't set `yardLine` this way, use whatever the file's helpers do to set the situation; the point is two
listings at the same game time and score that differ only in situation.

Run: `pnpm vitest run apps/hub/src/Slate.test.ts -t "same clock and score"`. Expected: FAIL (the tie rule keeps 60).

- [ ] **Step 2: Remove `Game#listed`, `GameSnapshot#tiesLive` and `Delivery.Snapshot`**

- `Slate.ts` `relisted`: `before.listed(snapshot)` → `before.snapshotTaken(snapshot)`. Delete the `Snapshot` branch of
  `take` and fix its doc comment (no "snapshot … of a listed game").
- `Game.ts`: delete `listed` and `tiesLive` with their doc comments.
- `Provider.ts`: delete the `Snapshot` case of `Delivery` and fix the doc comment.
- Run `pnpm typecheck` and follow every error.

- [ ] **Step 3: Rewrite the tests**

- `Game.test.ts`: delete the `listed` and `tiesLive` tests.
- `Slate.test.ts`: each test that delivered `snapshotOf(…)` delivers the same snapshot as a second `listing(…)` of its
  league instead, keeping its name and assertion when the behaviour still holds (ahead taken, behind ignored, over game
  takes one ahead of its end, equal changes nothing). Delete the tests that only existed for the push-wins-a-tie rule
  and "should take its deliveries in order, so a snapshot of a game just listed is taken". Delete `snapshotOf` if unused.
- `Director.test.ts`, `HubServer.test.ts`, `Provider.test.ts`: a fed `Delivery.Snapshot` becomes a `Delivery.Listing`
  of that game's league with the snapshot; a test about snapshot deliveries specifically is deleted.
- List each deleted or changed test in the commit body.

Run: `pnpm check`. Expected: PASS, including the Step 1 test.

- [ ] **Step 4: Glossary and commit**

`CONTEXT.md`: **Delivery** becomes `… what a frame said: a league's listing, or one game's whole list of plays.` **Slate**:
drop "push and" from "taken from … deliveries", and replace the tie sentence so it reads: a snapshot behind its game
(earlier in game time, or at the same game time with fewer points) is ignored, except that an over game takes one ahead
of its end. Check `grep -n "push wins\|tiesLive\|Game#listed\|Snapshot delivery" CONTEXT.md docs/technical-spec.md` finds nothing.

```bash
git add apps/hub/src packages/domain/src CONTEXT.md
git commit -m "refactor: listings are the only snapshots

Nothing delivers a Snapshot since scoreboard topics went; the
push-wins-a-tie rule now hid a later poll's down and ball.

<test changes, one per line>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The poll and the game topics run on their own

`EspnState` was one fold so the poll and FastCast, which said the same facts, stayed in order. They no longer overlap:
the poll gives `Listing`s, FastCast gives `Plays`. Split them.

**Target shape**

- **The poll, per league**, in `EspnProvider.ts`: a loop that polls, decodes the listing, emits `[Listing]` and writes
  the league's games to a `listings` ref, then waits by its own last good listing and whether this poll failed: 10 s
  while a game is live, a minute while one kicks off within `GameSnapshot.kickoffWindow`, 15 minutes otherwise, at most
  30 s after a poll that failed or did not decode. A failed or undecodable poll is logged, emits nothing, and keeps the
  last good listing. Its state (last good listing, failed) is local to the loop: no frame, no fold.
- **Decoding a listing**: `listed`, `gamesOf` and `decodeScoreboard` move from `EspnState.ts` to `EspnEvent.ts` as one
  exported `listingOf(league: LeagueId, body: string): Effect.Effect<ReadonlyArray<GameSnapshot>, Schema.SchemaError>`
  (an event that does not decode is skipped). `EspnProvider` and `TestEspn` use it.
- **The game topics**: `EspnState` becomes `GameTopics` (`git mv EspnState.ts GameTopics.ts`, same for the test): a
  `Data.Class<{ documents: FastCastDocuments; plays: HashMap<GameId, HashMap<string, Play>> }>` with
  `take(frame: Frame): Effect<readonly [GameTopics, ReadonlyArray<Delivery>]>` (the `pushed`/`playsAfter` logic,
  unchanged), `retained(kept: (topic: Topic) => boolean): GameTopics` (the old `retained`'s body), and
  `isSynced(topic)`. No listings, no `failedPolls`, no `pollInterval`, no `wanted`.
- **`Frame`** loses `Polled` and `PollFailed`: it is FastCast's frames only. `annotationsOf` loses its poll cases.
- **Wanted** (`wantedOf` in `EspnProvider.ts`): from the `listings` ref and a read-only view of the `GameTopics` fold,
  on each change of either and once a minute: the topic of each listed game live or within its kickoff window, with
  `isSynced`. Same rule as today's `EspnState#wanted`.
- **Retention**: the game-topics fold takes, merged with FastCast's frames, each change of `listings`, and on one keeps
  only the topics wanted at the clock's now (`retained`). So documents and plays are pruned after each listing, as they
  were after each poll. Model the fold's input as a private two-case union in `EspnProvider.ts`
  (`Data.TaggedEnum<{ Frame: { frame: Frame }; Listed: {} }>`), or simpler if Effect offers it.
- **`deliveries`**: `Stream.merge(polls, gameTopics)`. Order between the two no longer matters: they never carry the same
  facts, and the Slate drops plays of a game no listing has yet (the next `Plays` is the game's whole list).

**Invariants (these tests pass unchanged except for construction helpers):** every cadence and poll-failure test in
`EspnProvider.test.ts`; `Espn.test.ts`; `Source.test.ts`; `Director.test.ts`'s recorded-day tests; every plays, reset and
document test now in `GameTopics.test.ts`.

**Files:**
- Modify: `apps/hub/src/provider/espn/EspnProvider.ts`, `EspnProvider.test.ts`
- Move: `EspnState.ts` → `GameTopics.ts`, `EspnState.test.ts` → `GameTopics.test.ts`
- Modify: `apps/hub/src/provider/espn/EspnEvent.ts`, `EspnEvent.test.ts`, `Frame.ts`, `TestEspn.ts`
- Modify: tests that use `TestEspn.decodedFrames`/`stateAfter`/`recordedNeAtBuf` (`grep -rln "decodedFrames\|stateAfter\|recordedNeAtBuf" apps`)
- Modify: `CONTEXT.md` (**ESPN state** → **Game topics**; **Wanted topics**; any row naming `EspnState`, `Polled` or `PollFailed`)

**Interfaces:**
- Produces: `GameTopics` as above; `EspnEvent.listingOf(league, body)`; `Frame = Data.TaggedEnum<{ Pushed; Checkpoint }>`.
- Produces in `TestEspn.ts`: a recorded day replays as `ReadonlyArray<Recorded>` where `Recorded` is a poll body
  (`{ league, body }`) or a FastCast `Frame`; `decodedFrames` becomes `replayed(recorded)`: a poll through `listingOf`
  to `[Listing]` (nothing when it does not decode), a frame through `GameTopics#take`, with retention after each poll as
  the provider does. Keep one array of deliveries per recorded line, so the Director's recorded-day tests keep their
  shape.

- [ ] **Step 1: Move the listing decode** to `EspnEvent.listingOf`, with its tests moved from `EspnState.test.ts`
  ("should decode each listing", "should read a poll response as its league's listing", "should skip an event that does
  not decode, and list the rest") into `EspnEvent.test.ts`, asserting on `listingOf`'s result. Run them; commit nothing yet.
- [ ] **Step 2: Rename and shrink the fold**: `git mv` to `GameTopics`, remove everything poll-related, take the
  `EspnState#failedPolls`, poll-retention and `wanted` tests out of its test file (they move to `EspnProvider.test.ts`
  in Step 4 or are already covered there: check each by name and keep one test per behaviour). Rename log prefixes
  `EspnState:` → `GameTopics:`.
- [ ] **Step 3: Remove `Polled`/`PollFailed` from `Frame`** and follow every error.
- [ ] **Step 4: Rewrite `EspnProvider.layer`** to the target shape. Write its doc comment from the target shape. The
  `wanted` tests (live game wanted, from 30 minutes before kickoff, not a second earlier, synced shown as `Synced`, a
  reset topic shown waiting) become `EspnProvider.test.ts` tests through `FastCast.layerTest`'s `wanted` stream if they
  aren't there already; the retention tests ("should drop the document and plays of a game no longer wanted", "should
  keep the document of a topic still wanted") become `GameTopics.test.ts` tests on `retained`.
- [ ] **Step 5: Rework `TestEspn.ts`** as in Interfaces and follow its users.
- [ ] **Step 6: Glossary.** **Game topics**: `Each followed FastCast game topic's document and the plays decoded from it,
  each frame folded in once; GameTopics in apps/hub/src/provider/espn/GameTopics.ts. Its take gives each frame's Plays;
  its retained keeps only the topics still wanted.` Delete the **ESPN state** row. Fix **Wanted topics** and any row
  `grep -n "EspnState\|ESPN state\|Polled\|PollFailed" CONTEXT.md docs/technical-spec.md` finds.
- [ ] **Step 7: Run and commit.** `pnpm check` passes. `git diff --stat <task base> -- apps` deletes more than it adds;
  report the numbers. Commit body lists every moved, merged or deleted test.

```bash
git add -A apps/hub/src CONTEXT.md docs/technical-spec.md
git commit -m "refactor: run the ESPN poll and game topics on their own

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs follow

Task 2's docs (ADR 0016, the ADR 0014 status line) describe Task 1 only.

- [ ] Rewrite ADR 0016 as "ESPN's poll lists, its game topics play": context (two feeds said the same facts; the college
  scoreboard topic lists only ranked games); decision (FastCast follows only game topics, for plays; the poll is each
  game's listing, status and score; the two run on their own, joined only by the listings that say which topics are
  wanted; listings are the only snapshots, so no push-wins-a-tie rule); consequences (scores move with the poll, about
  10 s; no push-behind metric; `EspnState` and `Delivery.Snapshot` gone). ADR 0014's status: `Superseded by 0016.`
- [ ] `docs/technical-spec.md`: the provider section matches Tasks 3–4 (`grep -n "EspnState\|fold\|Snapshot" docs/technical-spec.md`).
- [ ] `pnpm check`; commit `docs: ESPN's poll lists, its game topics play`.

---

### Task 6: See it live

Not a code task; needs a live game (Saturday 2026-10-10 from 16:00Z).

- [ ] Ask the user to run `pnpm dev` (agent-launched Electron misreports on this machine). Check together: scores,
  clocks and the field's down and ball move about every 10 s; plays arrive on the strip as they happen, including a
  college game's; Hub logs show subscriptions only to `gp-…` topics and no `lost its document` warnings in a quiet
  stretch. Record what was seen in the checklist and commit.

---

## Self-review

- Spec coverage: Task 1 is the spec's design; Task 2 its docs; Tasks 3–5 follow from it (no snapshot is pushed, so
  nothing needs the poll and pushes in one fold or a tie rule) and were agreed with the user on 2026-10-09; Task 6 the
  live check.
- Types: `Topic.fromTc`/`tc()` and `FastCastMessage.Checkpoint` (Task 1) are used in Task 4; `Delivery` without
  `Snapshot` (Task 3) is what `GameTopics#take` and the poll emit in Task 4.
