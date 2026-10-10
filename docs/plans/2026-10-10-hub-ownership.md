# Hub Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Hub easier to navigate by repairing declaration, test, and harness ownership without changing its runtime behavior.

**Architecture:** Keep the root Hub concepts, `provider/espn/`, and `source/youtube-tv/`. Split the existing `ProviderFeed` declaration, localize FastCast's implementation, and move tests to the stage of the pipeline that owns their assertions. Extract concept-specific test harnesses, not production interfaces or new folders.

**Tech Stack:** TypeScript 7, Effect 4, `@effect/vitest`, Vitest 5, pnpm, Biome, dependency-cruiser, knip.

---

## Authority and execution rules

- Approved design: [`../specs/2026-10-10-hub-ownership-design.md`](../specs/2026-10-10-hub-ownership-design.md).
- Inspected revision: `9c3c4c6`, whose production/test baseline is `1e048ee` (41 files, 995 passing tests). Recheck at execution time; the planning session has not measured coverage.
- Read `AGENTS.md`, `CONTEXT.md`, and `docs/technical-spec.md` first. For Effect code, read the installed `apps/hub/node_modules/effect/AGENTS.md` and `ai-docs/src/index.md`, then the examples for the APIs being touched. Do not translate these tasks into Effect 3 APIs.
- This document authorizes no implementation by itself. Start after the user approves execution, in an isolated worktree using the using-git-worktrees workflow. `.worktrees/` currently exists and is ignored; verify again before using it.
- Run tasks in order, with one writer. Each numbered implementation task is a green commit. Task 0 is evidence collection, not a source-code commit.
- Preserve production service ids/interfaces, routes, wire schemas, log text/annotations, metrics, durations, recovery semantics, and stream operator order. The removal of the unused public constructor `FastCast.make` is the explicitly approved exception to public declaration preservation.
- No fixture bytes change. No production member is exported for a test. No new package, folder, barrel, behavior-suffixed suite, or generic helper module.
- The task snippets show new/replacement code. For an unchanged move, the named declaration or test at `9c3c4c6` is the source of truth: move its entire body, including comments, every assertion, timeout, and clock/fiber setup. Do not reimplement it from the prose.
- Move first, verify the destination, then remove the source. Existing characterization tests are the safety net for this refactor; do not manufacture failing runtime tests for unchanged behavior. The new dependency boundary gets an intentional negative check.
- Format only touched TypeScript/config files with `pnpm exec biome check --write <explicit paths>`. Run `pnpm check` before **every** commit. Do not fold unrelated diagnostics into this pass.

### Assertion ledgers

Every commit rewriting a test file includes, in its body, each old test name and its new file/name. A test staying in place still gets an entry when its assertions or harness were rewritten. Parameterized cases remain individually accounted for. For a split, list both destinations and which assertions each carries.

Use the JSON reports and saved baseline source from Task 0 to prepare the ledger. Test counts are a warning signal, not proof of preservation: splitting a mixed-owner test can increase the count; it must not erase an assertion. There is no removed runtime behavior in this plan, so there should be no unexplained deleted assertion.

Commit messages proposed below are subjects only. Save each complete message, including its ledger, under the evidence directory and use `git commit -F <that file>` after `pnpm check`. Stage explicit paths; do not stage generated coverage or evidence files.

## File and responsibility map

All Hub paths below are relative to `apps/hub/src/`.

| File | Result / responsibility |
| --- | --- |
| `provider/Provider.ts` | Provider port, `Delivery`, and unchanged test-layer handshake |
| `provider/ProviderFeed.ts` — new | Existing `ProviderFeed` service declaration |
| `provider/ProviderFeed.test.ts` — renamed | Existing deliver/acknowledge and end tests |
| `provider/espn/FastCast.ts` | Existing socket service, owns `ProviderUnavailable`, no `make` indirection |
| `provider/espn/ProviderUnavailable.ts` — delete | Error moves into its only owner |
| `provider/espn/EspnEvent.ts` | Scoreboard decoding and shared ESPN team-id conversion; lower-camel private schema builder |
| `provider/espn/EspnProvider.ts`, `EspnPlay.ts` | Namespace-import adjustment only |
| `source/youtube-tv/YouTubeTvGuide.ts` | Main decode export before supporting source constant |
| `provider/espn/FastCastDocuments.test.ts` — new | Direct document folding/reset/patch tests and socket-to-document malformed-patch acceptance |
| `provider/espn/GameTopics.test.ts` | Play decoding, identity/order, delivery cardinality, logs, and combined retention |
| `provider/espn/EspnEvent.test.ts`, `EspnPlay.test.ts` | Scoreboard transformations and recorded schema round trips |
| `provider/espn/EspnProvider.test.ts` | Poll lifecycle/cadence, merged deliveries, wanted topics, retention, integration |
| `source/youtube-tv/YouTubeTvGuide.test.ts` | Decoder behavior and recorded ESPN/YouTube adapter acceptance |
| `source/GuideReader.test.ts`, `source/Source.test.ts` | Reader lifecycle and source port/composition behavior respectively |
| `provider/espn/TestFastCast.ts` | Socket host/harness and reusable frame/checkpoint/message builders |
| `provider/espn/TestGameTopics.ts` — new | Existing frame replay and final GameTopics state harnesses |
| `provider/espn/TestEspn.ts` | Recorded ESPN payloads/day replay and its lazily cached result |
| `source/youtube-tv/TestYouTubeTv.ts` | Recorded guide and existing one-row response builder |
| `TestHubServer.ts` — new | Hub layer composition, client, SSE reading/decoding, publication harness |
| `source/TestGuide.ts` — new | Guide/airing scenario builders, not game snapshots or expected assertions |
| `HubServer.test.ts`, `source/Guide.test.ts`, `Director.test.ts` | Behavior-first layout and smaller local setup |
| `.dependency-cruiser.cjs` | General Hub `Test*.ts` import protection |
| `CONTEXT.md`, `docs/technical-spec.md` | Correct ownership paths and actual Hub tree |

Import-only consumers also touched as needed: `TestDirector.ts`, `provider/espn/Espn.test.ts`, and the tests in the table. Search at each move rather than assuming this list remains exhaustive. New and touched namespace modules are imported as namespaces; do not re-export moved symbols to preserve old import paths.

## Task 0 — Capture a reproducible baseline

**Files:** No production/test edits. Evidence goes outside the worktree under `/tmp`.

- [ ] **1. Create the execution worktree and install dependencies.** From the repository containing the approved plan:

```bash
git status --short
git check-ignore .worktrees
git worktree add .worktrees/hub-ownership -b refactor/hub-ownership
cd .worktrees/hub-ownership
pnpm install --frozen-lockfile
```

If that branch/directory already exists, inspect it before reusing or selecting another; do not delete it. Ensure the approved plan is available in the execution checkout. Stop on unexpected baseline modifications.

- [ ] **2. Save the revision, checkout root, complete test sources, and check output.** Run in bash; preserve `HUB_EVIDENCE` for later tasks (or recover its path from the printed output).

```bash
export HUB_EVIDENCE="$(mktemp -d /tmp/sportal-hub-ownership.XXXXXX)"
printf '%s\n' "$HUB_EVIDENCE"
git rev-parse HEAD > "$HUB_EVIDENCE/baseline-revision.txt"
pwd > "$HUB_EVIDENCE/baseline-root.txt"
git ls-files apps/hub/src > "$HUB_EVIDENCE/baseline-hub-files.txt"
git archive HEAD apps/hub/src .dependency-cruiser.cjs CONTEXT.md docs/technical-spec.md > "$HUB_EVIDENCE/baseline.tar"
set -o pipefail
pnpm check 2>&1 | tee "$HUB_EVIDENCE/baseline-check.log"
pnpm exec vitest run --reporter=json --outputFile="$HUB_EVIDENCE/baseline-tests.json"
```

Expected: baseline green, presently 995 tests in 41 files. Report discrepancies before editing. Two previously observed web Effect suggestions are not part of this refactor; a new error is not excused by those suggestions.

- [ ] **3. Capture workspace coverage, including per-file detail.**

```bash
pnpm coverage --coverage.reporter=json --coverage.reporter=json-summary --coverage.reporter=text 2>&1 | tee "$HUB_EVIDENCE/baseline-coverage.log"
cp coverage/coverage-summary.json "$HUB_EVIDENCE/baseline-coverage-summary.json"
cp coverage/coverage-final.json "$HUB_EVIDENCE/baseline-coverage-final.json"
```

This workspace run contains the Hub and its consumers. Keep both workspace totals and individual Hub records, including zero-covered files. Do not restrict the final run differently. Do not change Vitest's coverage include/exclude settings to improve the comparison.

- [ ] **4. Generate the exact test-name inventory.**

```bash
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
const dir = process.env.HUB_EVIDENCE
const report = JSON.parse(readFileSync(`${dir}/baseline-tests.json`, 'utf8'))
const rows = report.testResults.flatMap(file =>
  file.assertionResults.map(test => ({
    file: relative(process.cwd(), file.name),
    name: test.fullName,
    status: test.status
  }))
)
writeFileSync(`${dir}/baseline-test-names.json`, JSON.stringify(rows, null, 2))
console.log(`${rows.length} test cases inventoried`)
NODE
```

Before each later task, save its current test report/source as well: the ledger for that commit compares to its parent, while final acceptance also compares to Task 0. Vitest's `assertionResults` are test cases, **not** an inventory of individual `assert.*` calls; read the saved source to account for those.

## Task 1 — Give ProviderFeed its own module and protect test modules

**Create:** `apps/hub/src/provider/ProviderFeed.ts`.

**Rename:** `apps/hub/src/provider/Provider.test.ts` → `apps/hub/src/provider/ProviderFeed.test.ts`.

**Modify:** `apps/hub/src/provider/Provider.ts`, `apps/hub/src/TestDirector.ts`, `apps/hub/src/Director.test.ts`, `apps/hub/src/HubServer.test.ts` (TestDirector namespace import), `.dependency-cruiser.cjs`, `CONTEXT.md`.

- [ ] **1. Run the current owner and consumer tests before moving anything.**

```bash
pnpm exec vitest run apps/hub/src/provider/Provider.test.ts apps/hub/src/Director.test.ts apps/hub/src/HubServer.test.ts
rg -n 'ProviderFeed|from .*TestDirector' apps/hub/src --glob '*.ts'
```

Expected: green; the feed's value import callers are `Provider.ts`, its test, `TestDirector.ts`, and `Director.test.ts`.

- [ ] **2. Move the declaration, without changing the handshake.** New file:

```ts
import { Context, type Effect } from "effect"
import type { Delivery } from "./Provider.ts"

/** What a test gives `Provider.layerTest`'s provider to say. */
export class ProviderFeed extends Context.Service<
  ProviderFeed,
  {
    /** One frame saying `deliveries`; returns once the provider's reader has taken it and asked for the next. */
    deliver(deliveries: ReadonlyArray<Delivery>): Effect.Effect<void>
    /** Ends the provider's frames after those already delivered. */
    readonly end: Effect.Effect<void>
  }
>()("sportal/hub/provider/ProviderFeed") {}
```

Delete that class from `Provider.ts`; add `import { ProviderFeed } from "./ProviderFeed.ts"`. Keep `Delivery` and **all** of `Provider.layerTest` as they are. The reverse import is type-only, so there is no runtime service cycle.

Rename the test with `git mv`. Split its import into:

```ts
import { Delivery, Provider } from "./Provider.ts"
import { ProviderFeed } from "./ProviderFeed.ts"
```

Split the corresponding imports in `TestDirector.ts` and `Director.test.ts`. Use `import * as TestDirector from "./TestDirector.ts"` in its two test consumers and qualify `directorOver`, `delivered`, and `latest` where used. Keep both existing feed test bodies and their exact names unchanged.

- [ ] **3. Replace the three incomplete Hub-only test rules.** Remove `test-telemetry-is-for-tests`, `test-director-is-for-tests`, and `test-adapter-data-is-for-tests`; insert:

```js
{
  name: "hub-test-modules-are-for-tests",
  comment: "Hub Test modules are imported only by tests and other Hub Test modules.",
  severity: "error",
  from: {
    pathNot: "(\\.test\\.tsx?$|^apps/hub/src/(?:[^/]+/)*Test[^/]*\\.ts$)"
  },
  to: { path: "^apps/hub/src/(?:[^/]+/)*Test[^/]*\\.ts$" }
},
```

The `from` side intentionally is not restricted to Hub: other apps/packages must not gain access to Hub test modules either. Existing cross-app rules still apply. Keep `test-game-is-for-tests`, `test-screen-is-for-tests`, web/desktop rules, adapter privacy, and the type-only-cycle exception unchanged. Do not broadly exempt `Test*.ts` from unrelated production boundaries.

- [ ] **4. Exercise both sides of the rule with a temporary probe.** Use a fresh file name; check it does not exist first. Remove the probe in a `finally` block so it never reaches a commit.

```bash
node <<'NODE'
const { writeFileSync, unlinkSync, existsSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const probe = 'apps/hub/src/BoundaryProbe.ts'
if (existsSync(probe)) throw new Error(`Refusing to overwrite ${probe}`)
try {
  writeFileSync(probe, 'import * as TestDirector from "./TestDirector.ts"\nvoid TestDirector\n')
  const result = spawnSync('pnpm', ['exec', 'depcruise', 'apps', 'packages'], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  process.stdout.write(output)
  if (result.status === 0 || !output.includes('hub-test-modules-are-for-tests')) {
    throw new Error('Expected the new boundary to reject the production import')
  }
} finally {
  unlinkSync(probe)
}
NODE
pnpm exec depcruise apps packages
```

Expected: the probe fails under the new rule; after removal the actual graph passes. Task 6's `TestHubServer` → `TestDirector` import supplies the positive Test-to-Test case under the same rule.

- [ ] **5. Verify and commit.** Add `apps/hub/src/provider/ProviderFeed.ts` to the Provider feed glossary row without changing its meaning.

```bash
pnpm exec vitest run apps/hub/src/provider/ProviderFeed.test.ts apps/hub/src/Director.test.ts apps/hub/src/HubServer.test.ts
pnpm structure
pnpm check
```

Ledger includes:

- `Provider.test.ts` / `should return once the provider's reader has taken the frame` → same name in `ProviderFeed.test.ts`.
- `Provider.test.ts` / `should end the provider's frames after those already delivered` → same name in `ProviderFeed.test.ts`.
- Director/HubServer tests with qualified harness imports → same file/name/assertions.

Subject: `refactor: separate the provider feed module`.

## Task 2 — Localize FastCast and normalize production reading order

**Modify:** `apps/hub/src/provider/espn/{FastCast,EspnEvent,EspnProvider,EspnPlay,TestEspn,EspnEvent.test,Espn.test,EspnPlay.test,EspnProvider.test,GameTopics.test,FastCast.test}.ts`, `apps/hub/src/Director.test.ts`, `apps/hub/src/source/Source.test.ts`, `apps/hub/src/source/youtube-tv/YouTubeTvGuide.ts`, `CONTEXT.md`.

**Delete:** `apps/hub/src/provider/espn/ProviderUnavailable.ts`.

Import-only test edits in this task are not test ownership changes. Keep their bodies/assertions in place.

- [ ] **1. Characterize the unchanged behavior and confirm the single constructor caller.**

```bash
rg -n 'FastCast\.make|ProviderUnavailable|from .*EspnEvent' apps/hub/src
pnpm exec vitest run apps/hub/src/provider/espn/FastCast.test.ts apps/hub/src/provider/espn/EspnProvider.test.ts apps/hub/src/provider/espn/EspnEvent.test.ts apps/hub/src/provider/espn/EspnPlay.test.ts apps/hub/src/source/youtube-tv/YouTubeTvGuide.test.ts
```

- [ ] **2. Replace `make` plus its call with the following layer.** Keep the service interface and existing `layerTest`. Keep the layer's existing explanatory comment.

```ts
static readonly layer: Layer.Layer<FastCast, never, HttpClient.HttpClient | Socket.WebSocketConstructor> =
  Layer.effect(
    FastCast,
    Effect.gen(function* () {
      const context = yield* Effect.context<HttpClient.HttpClient | Socket.WebSocketConstructor>()
      const reconnect = Schedule.min([
        Schedule.exponential("1 second").pipe(Schedule.jittered),
        Schedule.spaced("1 minute")
      ])
      const follow = (wanted: Stream.Stream<Wanted>) =>
        Stream.unwrap(connect(wanted, "30 seconds")).pipe(
          Stream.concat(
            Stream.fail(new ProviderUnavailable({ reason: "Closed", cause: "FastCast ended the stream" }))
          ),
          Stream.timeoutOrElse({ duration: silence, orElse: () => Stream.fail(silent()) }),
          Stream.tapError((error) =>
            Effect.logWarning(`FastCast: the live feed failed (${error.reason}); subscribing again`, error)
          ),
          Stream.retry(reconnect),
          Stream.catchCause(stopped),
          Stream.provideContext(context)
        )
      return FastCast.of({ follow })
    })
  )
```

Keep `Duration` imported: `connect` still uses it. Do not simplify `connect`, change concurrency, reorder flattening/recovery, or replace retry combinators.

- [ ] **3. Move the error after `Wanted`, before private helpers.** Its schema/tag/comment are unchanged. Its export is no longer needed because its only consumer is in the same file; leave it private so knip does not force a test-only consumer.

```ts
/** FastCast could not be followed: it refused, closed, or went silent. `FastCast` logs it and opens the socket again. */
class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()("ProviderUnavailable", {
  reason: Schema.Literals(["Refused", "Closed", "Silent"]),
  cause: Schema.Defect()
}) {}
```

Remove the old import and file. Retain `CheckpointUnread` beside it. Update the glossary's Provider unavailable row to name `apps/hub/src/provider/espn/FastCast.ts`.

- [ ] **4. Normalize namespace imports and declaration order.** Replace named `EspnEvent` imports in `EspnProvider.ts`, `EspnPlay.ts`, `TestEspn.ts`, and `EspnEvent.test.ts`:

```ts
import * as EspnEvent from "./EspnEvent.ts"
```

Qualify `listingOf` and `teamId` at their existing call sites. Rename only the private schema builder and its call:

```diff
-function EspnEvent(league: LeagueId) {
+function espnEvent(league: LeagueId) {
```

Retain the existing `SiteEvent.pipe(...)` body byte-for-byte. The other exact replacement is:

```diff
-  return Schema.decodeUnknownEffect(EspnEvent(league))
+  return Schema.decodeUnknownEffect(espnEvent(league))
``` Keep `teamId` here; do not create a team module or a decoder table abstraction.

Because `TestEspn.ts` is touched, convert its existing consumers to `import * as TestEspn` and qualify their calls; do not change their setup. In `FastCast.test.ts`, this is temporarily `TestEspn.topicsAfter` until Task 3 moves that helper.

Move the complete `YouTubeTvGuide.source` declaration/comment immediately below `decode`. Do not move the codecs above `decode` or alter the effect body; its reads are lazy.

- [ ] **5. Verify unchanged contracts and commit.**

```bash
rg -n 'FastCast\.make|ProviderUnavailable\.ts|import \{.*\} from "./EspnEvent\.ts"' apps/hub/src
pnpm exec vitest run apps/hub/src/provider/espn apps/hub/src/source/youtube-tv/YouTubeTvGuide.test.ts apps/hub/src/Director.test.ts apps/hub/src/source/Source.test.ts
pnpm check
```

Expected: the search has no matches. Review `git diff --word-diff` for the production edits: only relocation, qualification, private naming, and the approved constructor inlining. Ledger import-only test edits as unchanged names/assertions.

Subject: `refactor: localize FastCast implementation`.

## Task 3 — Put document assertions beside FastCastDocuments

**Create:** `apps/hub/src/provider/espn/FastCastDocuments.test.ts`, `apps/hub/src/provider/espn/TestGameTopics.ts`.

**Modify:** `apps/hub/src/provider/espn/{TestFastCast,TestEspn,GameTopics.test,FastCast.test,EspnProvider.test}.ts`.

**Production changes:** None.

### Exact split ledger

Names below are the existing leaf test names. Keep the original leaf name at each destination unless the table explicitly gives a new one. `D` means `FastCastDocuments.test.ts`; `G` means `GameTopics.test.ts`.

| Existing `GameTopics.test.ts` name | Destination and assertions |
| --- | --- |
| should add the value read at a copy's source | D: source is defined, copied text equals source, using the same recorded checkpoint/copy |
| should send a topic that missed a message back to waiting for a checkpoint | D: reset topics equals `[neAtBufPlays]`; G: delivery frames equals `[1, 2]` |
| should give nothing and fail nothing for a patch or an idle message before any checkpoint | D: both advances succeed with no change and no synced topic; G: existing empty delivery-tag assertion |
| should send a topic back to waiting for a checkpoint when a patch will not apply | D: one reset of NE/BUF; G: no deliveries after frame 1 |
| should reset a synced topic on a message that does not decode | D: reset of NE/BUF; G: existing filtered-deliveries `[]` assertion and its message |
| should reset a topic's document, once, after $reset | D: all three rows, exact ordered reset arrays (gap, unapplicable patch, undecodable message) |
| should reset no topic that was never synced | D: reset array `[]` |
| should sync a waiting topic on the next checkpoint that decodes | D: synced state and reset array `[]`; G: frame-2 text array `["Corrected"]` |
| should keep a topic synced through a recorded move outside the plays, still delivering the plays after it | D: reset array `[]` and synced state; G: recorded `move` evidence, frame indices `[1, 2, 5]`, penalty text, final play id |
| should give nothing and fail nothing for a patch outside the plays | D: no reset and ignored patch leaves topic synced; G: play-id arrays `[[], ["40187297063"]]` |
| should keep the other games decoding after a gap on one game's topic | D: only ARI/NYG resets and the other topic remains synced; G: `Plays` tag and `401872971330` delivery assertions |

All Warning assertions, skip-malformed-frame delivery behavior, play identity/replacement/removal/move/order, recorded FBS delivery, delivery-per-frame tests, and all three retention tests remain in G. The two schema round trips move only in Task 4.

- [ ] **1. Run the four affected suites before extraction.**

```bash
pnpm exec vitest run apps/hub/src/provider/espn/GameTopics.test.ts apps/hub/src/provider/espn/FastCast.test.ts apps/hub/src/provider/espn/EspnProvider.test.ts
```

- [ ] **2. Move the two GameTopics harness operations out of TestEspn.** Create this module, preserving the existing replay/fold logic. Test-only span names now identify the owning harness; production telemetry is untouched.

```ts
import { Effect, Stream } from "effect"
import type { Frame } from "./Frame.ts"
import { GameTopics } from "./GameTopics.ts"

/** What GameTopics gives for each frame, one delivery array per frame. */
export const framesReplayed = Effect.fn("TestGameTopics.framesReplayed")(function* (
  frames: ReadonlyArray<Frame>
) {
  return yield* Stream.fromIterable(frames).pipe(
    Stream.mapAccumEffect(
      () => GameTopics.empty,
      (topics, frame) => Effect.map(topics.take(frame), ([next, deliveries]) => [next, [deliveries]] as const)
    ),
    Stream.runCollect
  )
})

/** The game topics after frames, from none. */
export const topicsAfter = Effect.fn("TestGameTopics.topicsAfter")(function* (
  frames: ReadonlyArray<Frame>
) {
  return yield* Effect.reduce(
    frames,
    () => GameTopics.empty,
    (topics, frame) => Effect.map(topics.take(frame), ([next]) => next)
  )
})
```

Delete the originals from `TestEspn.ts`, update its explanatory comment to point to `TestGameTopics.framesReplayed`, and use `import * as TestGameTopics` at the callers. No forwarding exports. Keep `GameTopics` and `Stream` imports in TestEspn because recorded-day replay still uses them.

- [ ] **3. Move shared frame setup into TestFastCast before copying tests.** Reuse the existing declarations rather than inventing another builder API.

From `GameTopics.test.ts`, move the complete declarations for `checkpoint`, `message`, `topicNamed`, `neAtBufCheckpoint`, `beforeAnyCheckpoint`, `textReplaced`, `unapplicablePatch`, `undecodablePatch`, and `moveRecordingFrames`. Export those that the two suites actually call; their private dependency closure includes `neAtBufPlays`, `moveRecording`, and `decodeEnvelope`. Export `neAtBufPlays` and `moveRecording` because retained assertions read them. Keep the raw recording's schema/bytes unchanged.

The low-level builders retain these exact signatures/bodies:

```ts
export function checkpoint(tc: string, mid: number, document: unknown): Frame {
  const decoded = Schema.decodeSync(FastCastMessage.Checkpoint)(JSON.stringify(document))
  return Frame.Checkpoint({ topic: topicNamed(tc), mid, document: decoded })
}

export function message(tc: string, mid: number, patches: ReadonlyArray<object>): Frame {
  const pl = JSON.stringify({ ts: 1791136341731, pl: patches })
  return Frame.Pushed({
    topic: Topic.fromTc(tc),
    mid: Option.some(mid),
    envelope: decodeEnvelope(JSON.stringify({ op: "P", tc, mid, pl }))
  })
}

export function topicNamed(tc: string): Topic {
  return Option.getOrThrow(Topic.fromTc(tc))
}
```

`checkpoint`'s named decode value is a small constructor-readability cleanup. Do not add a typed options bag or change how deliberately malformed frames are built.

From `FastCast.test.ts`, move the reusable host/harness dependency closure: `nflFrames`, `framesOver`, `fastCastHost`, `wantedOf`, `closedSockets`, the test HTTP client `espn`, `checkpointBody`, `checkpointDocument`, `gameOf`, `gameTopic`, `main`, `mainTc`, and `firstGame`; also `checkpointMessage` and `undecodablePatchMessage`, used by the migrated socket acceptance test. Export only live consumers. Put `firstGame` before the eager `main`/`mainTc` initializers and the recording decode before `checkpointBody`/`checkpointDocument`. Build `checkpointBody` from the already moved `moveRecording.checkpoint.body` rather than reading the same fixture a second time in the same module.

Keep `atLeast`, `numbered`, `wholeAt`, `seen`, subscription/connection projections, and single-suite scenario helpers private at the bottom of `FastCast.test.ts`. The new document socket test uses short inline wait predicates rather than exporting generic predicates or pulling in `seen`.

Keep GameTopics' one-off assertion projections (`tags`, `playIds`, `textOf`, indexed `decoded`) local. Move its `playEntities` fixture decode and existing `plays(...ids)` builder into TestEspn so the split two-topic scenario can use the same recorded play objects in both suites. Export `plays`, keep `playEntities` private, and read `./fixtures/nfl-plays-2026-10-04.json` with TestEspn's existing `readFileSync` import. Do not export its inferred wire type or use the scoreboard-named reader for a play fixture. Qualify calls as `TestEspn.plays(...)`; no duplicate builder. In GameTopics' malformed-play test, replace `playEntities["401872966237"] ?? {}` with `TestEspn.plays("401872966237")["401872966237"] ?? {}` so the fixture record itself stays private. Recorded frame scenarios shared by the suites use the moved TestFastCast builders.

Convert consumers of touched `TestFastCast.ts` to namespace imports, including `EspnProvider.test.ts`. Preserve the real FastCast layer, HTTP statuses, five-second delays, scopes, and initial wanted set in the moved harness.

- [ ] **4. Build the direct document suite with a local fold, not GameTopics.** Use `FastCastDocuments.advance`, `DocumentChange`, and `isSynced`. Keep this helper private below the tests:

```ts
const documentsAfter = Effect.fn("FastCastDocuments.test.documentsAfter")(function* (
  frames: ReadonlyArray<Frame>
) {
  return yield* Effect.reduce(
    frames,
    () => FastCastDocuments.empty,
    (documents, frame) => Effect.map(documents.advance(frame), (next) => next.documents)
  )
})

const resetTopics = Effect.fn("FastCastDocuments.test.resetTopics")(function* (
  frames: ReadonlyArray<Frame>
) {
  const result = yield* Effect.reduce(
    frames,
    (): { readonly documents: FastCastDocuments; readonly topics: ReadonlyArray<string> } => ({
      documents: FastCastDocuments.empty,
      topics: []
    }),
    ({ documents, topics }, frame) =>
      Effect.map(documents.advance(frame), (next) => {
        const reset = Option.filter(next.change, DocumentChange.$is("Reset"))
        return {
          documents: next.documents,
          topics: [...topics, ...Option.toArray(Option.map(reset, ({ topic }) => topic.tc()))]
        }
      })
  )
  return result.topics
})
```

Import `Effect`, `Option`, `Schema`, and any used `HashMap` from Effect; `Frame` and `FastCastDocuments`/`DocumentChange` by name; `TestFastCast` as a namespace. Do not catch and discard schema errors: the cases expected to fail must assert the error, and those expected to reset must succeed.

For example, the existing three-row reset test now calls this `resetTopics` with the same frame arrays and expected arrays. A direct ignored-patch test is:

```ts
it.effect("should keep a topic synced when a patch is outside the plays", () =>
  Effect.gen(function* () {
    const checkpoint = TestFastCast.checkpoint("gp-football-nfl-401872966", 99, { entities: {} })
    const patch = TestFastCast.message("gp-football-nfl-401872966", 100, [
      { op: "replace", path: "/boxscore/teams/0/statistics/0/displayValue", value: "12" }
    ])
    const before = yield* documentsAfter([checkpoint])

    const after = yield* before.advance(patch)

    assert.isTrue(Option.isNone(after.change))
    assert.isTrue(after.documents.isSynced(TestFastCast.topicNamed("gp-football-nfl-401872966")))
  })
)
```

`checkpoint` is returned as the `Frame` union, so the assertion obtains its topic from the existing builder rather than casting the frame to a case.

Use the same recorded checkpoint/copy for the source-value test. Read both `Game` changes' `plays` through `DocumentChange.$is("Game")`; decode the two selected JSON play objects with `Schema.Struct({ text: Schema.String })` and retain `assert.isDefined(source)` and `assert.strictEqual(copied, source)`. Do not replace this with a synthetic copy-only test and discard its recorded evidence.

For the resync case, preserve the existing `[checkpoint, textReplaced(819)]` assertions. Also exercise `[checkpoint, unapplicablePatch(819), checkpoint, textReplaced(819)]` in a separate direct test to make the approved later-checkpoint recovery expectation explicit; it must already pass before any production edits (none are planned here).

- [ ] **5. Move the real-socket downstream assertion without replacing its input with a synthetic frame.** Move `should reset only its topic when a patch's payload does not decode on a synced topic` from `FastCast.test.ts` into the new suite. Keep its fake server, `nflFrames`, real `checkpointMessage(7)`, base64/non-deflated `undecodablePatchMessage(8)`, and frame-arrival waits. Change only the downstream fold:

```ts
const before = yield* documentsAfter(received.slice(0, -1))
const bad = yield* Effect.fromOption(Arr.last(received))

const { documents: after } = yield* before.advance(bad)

assert.deepStrictEqual(syncedTopics(before), [TestFastCast.mainTc])
assert.deepStrictEqual(syncedTopics(after), [])
```

Use `Array as Arr` from Effect. Move its one-use projection here and change its parameter to `FastCastDocuments`:

```ts
function syncedTopics(documents: FastCastDocuments) {
  return [...HashMap.keys(documents.byTopic)]
    .filter((topic) => documents.isSynced(topic))
    .map((topic) => topic.tc())
}
```

For the waits, retain the old predicates' meanings: `all.length >= 2`, a `Checkpoint` with mid 7, and a `Pushed` with `Option.getOrUndefined(frame.mid) === 8`. The independent reset-isolation document test still seeds two topics. Keep FastCast's separate `should frame a patch whose payload does not decode with its topic and mid` unchanged.

- [ ] **6. Verify destinations, then remove only superseded assertions/setup.** Keep the GameTopics half of every split from the table. Delete GameTopics' `resetTopics`/`lostBetween` only when no retained assertion uses them. Check setup references after removing the old FastCast downstream test.

```bash
pnpm exec vitest run apps/hub/src/provider/espn/FastCastDocuments.test.ts
pnpm exec vitest run apps/hub/src/provider/espn/GameTopics.test.ts apps/hub/src/provider/espn/FastCast.test.ts apps/hub/src/provider/espn/EspnProvider.test.ts
pnpm structure
pnpm check
```

Expected: no lost warning/ordering/identity/cardinality/retention assertions and no new production exports. Record every split and the moved socket test in the ledger, plus import-only EspnProvider edits.

Subject: `test: put FastCast documents under their owner`.

## Task 4 — Move ESPN transformations and schema round trips

**Modify:** `apps/hub/src/provider/espn/{EspnEvent.test,EspnPlay.test,EspnProvider.test,GameTopics.test,TestEspn}.ts`.

**Production changes:** None.

- [ ] **1. Run the existing suites.**

```bash
pnpm exec vitest run apps/hub/src/provider/espn/EspnEvent.test.ts apps/hub/src/provider/espn/EspnPlay.test.ts apps/hub/src/provider/espn/EspnProvider.test.ts apps/hub/src/provider/espn/GameTopics.test.ts
```

- [ ] **2. Move all eight opening transformation tests to `describe("EspnEvent.listingOf")`.** These exact old names move from EspnProvider to EspnEvent, unchanged:

1. `should decode a live FBS scoreboard into snapshots`
2. `should keep television and streaming broadcasts and drop radio`
3. `should keep each team's location and short name`
4. `should keep each team's colors`
5. `should leave a team without colors with neither`
6. `should leave out what ESPN reports with placeholder values`
7. `should decode an NFL scoreboard, namespacing team ids by league`
8. `should orient the yard line for the team with the ball: ESPN counts it from the home goal line`

Replace only their `listedBy`/provided HTTP-layer setup with these direct calls:

| Cases | Act expression |
| --- | --- |
| 1–4 and 6 | `yield* EspnEvent.listingOf("fbs", TestEspn.recordedScoreboard("fbs-scoreboard-live"))` |
| 5 | `yield* EspnEvent.listingOf("fbs", withoutColors(TestEspn.recordedScoreboard("fbs-scoreboard-live")))` |
| 7 | `yield* EspnEvent.listingOf("nfl", TestEspn.recordedScoreboard("nfl-scoreboard-pregame"))` |
| 8 | `yield* EspnEvent.listingOf("fbs", TestEspn.recordedScoreboard("fbs-scoreboard-2026-10-03T2024Z"))` |

Keep variable name `slate` where that minimizes churn; all existing expected values stay literal. Example destination test:

```ts
it.effect("should keep each team's colors", () =>
  Effect.gen(function* () {
    const body = TestEspn.recordedScoreboard("fbs-scoreboard-live")

    const slate = yield* EspnEvent.listingOf("fbs", body)

    const game = slate.find((g) => g.id === "401862787")
    assert.strictEqual(game?.home.team.color, "005035")
    assert.strictEqual(game?.home.team.alternateColor, "a49665")
  })
)
```

Move `withoutColors` unchanged below its new tests. Keep `recordedEspn(fbs)`, `recordedHttp(fbs)`, and `answered` in EspnProvider: the retained per-run-stream and push-beside-poll tests still use them. Retain scoreboard constants used by scheduling/integration tests; remove only `fbsMidday` if now unused there. Keep non-2xx and undecodable-poll failures in EspnProvider.

- [ ] **3. Move the cache to TestEspn, after `replayed` is initialized.**

```ts
/** NE at BUF's recorded day, replayed lazily and cached for this module instance. */
export const neAtBufDecoded = Effect.runSync(Effect.cached(Effect.flatMap(recordedNeAtBuf, replayed)))
```

Delete its GameTopics declaration. Do not place this above the `replayed` const: constructing the effect reads that value eagerly even though replay itself is lazy. Do not use `Effect.runSync(replayed(...))`, which would execute replay at module load.

Vitest isolates files/workers, so a module-local cache does not promise one replay across the entire test process. Preserve this existing cache mechanism; do not disable isolation, introduce a global singleton, or rewrite fixtures to force cross-file caching. Keep both 60-second test timeouts and record final runtime alongside coverage.

- [ ] **4. Move the two round trips verbatim except for namespace qualification.**

| Old GameTopics name | Destination |
| --- | --- |
| should decode every snapshot so it reads back from its JSON Equal to itself | `EspnEvent.test.ts` / same name |
| should decode every play so it reads back from its JSON Equal to itself | `EspnPlay.test.ts` / same name |

Both continue setting the test clock to `TestEspn.duringNeAtBuf.epochMilliseconds`, yielding `TestEspn.neAtBufDecoded`, flattening **all** deliveries, and round-tripping every applicable value. Move the `snapshotJson`/`playJson` schema constants beside their destination tests; change EspnPlay.test's existing type-only `Play` import to the schema value import and add `Equal` where used. Preserve the nonempty assertion and every per-value `Equal.equals` assertion, including its id message; do not deduplicate repeated plays or test only the final list.

The replay result selection and round-trip operations remain:

```ts
const decoded = yield* TestEspn.neAtBufDecoded
const snapshots = decoded.flat().flatMap((delivery) =>
  Delivery.$is("Listing")(delivery) ? delivery.games : []
)
const backs = yield* Effect.forEach(snapshots, (snapshot) =>
  Schema.encodeEffect(snapshotJson)(snapshot).pipe(Effect.flatMap(Schema.decodeEffect(snapshotJson)))
)
assert.isNotEmpty(snapshots)
for (const [index, snapshot] of snapshots.entries()) {
  assert.isTrue(Equal.equals(backs[index], snapshot), snapshot.id)
}
```

For the play test keep its existing `Delivery.$is("Plays")` selection, `playJson`, `plays`, and `play.id` assertions unchanged. Remove now-unused schema/clock/Equal imports from GameTopics only after the moves.

Make the touched decoder suites open on their behavior. In EspnPlay.test, move the existing `recordedTypes` table immediately before its `it.effect.each(recordedTypes)` registration inside the owning `describe`; keep every row unchanged. Move the other private fixture/codec/helper declarations below the suites in dependency order (`recorded` before any eager user, `decodePlay` before any eager user). Callback bodies execute after module initialization, but `it.each` arguments execute during registration: do not put that table after its registration. Keep these as declaration moves; no decoder-table redesign.

- [ ] **5. Verify and commit.**

```bash
pnpm exec vitest run apps/hub/src/provider/espn/EspnEvent.test.ts apps/hub/src/provider/espn/EspnPlay.test.ts apps/hub/src/provider/espn/EspnProvider.test.ts apps/hub/src/provider/espn/Espn.test.ts apps/hub/src/provider/espn/GameTopics.test.ts
pnpm check
```

Ledger: the eight transformations, both round trips, and unchanged assertions in any rewritten surrounding tests. Subject: `test: colocate ESPN decoder coverage`.

## Task 5 — Separate guide decoding from reader/source lifecycle

**Modify:** `apps/hub/src/source/{GuideReader.test,Source.test}.ts`, `apps/hub/src/source/youtube-tv/{YouTubeTvGuide.test,TestYouTubeTv}.ts`.

**Production changes:** None.

- [ ] **1. Characterize the current behavior.**

```bash
pnpm exec vitest run apps/hub/src/source/GuideReader.test.ts apps/hub/src/source/Source.test.ts apps/hub/src/source/youtube-tv/YouTubeTvGuide.test.ts apps/hub/src/HubServer.test.ts
```

- [ ] **2. Move `oneRowGuide(videoId: string)` intact to TestYouTubeTv and export it.** It remains the existing News 3/Ohio State at Iowa wire response, including its exact dates, station id, nesting, title, and supplied video id. No new configurable response builder.

```ts
import * as TestYouTubeTv from "./TestYouTubeTv.ts"
```

Use the equivalent relative namespace import in GuideReader/Source. Qualify existing `recordedGuide`, `recordedAt`, and `readRecordedGuide` usages without changing their effects. Keep builders below the main recorded fixture exports, before private dependencies in first-use order.

- [ ] **3. Move the decoder-owned assertions with the following ledger.**

| Existing GuideReader test | Destination / retained half |
| --- | --- |
| should read the recorded guide's channels, live addresses, and airings | YouTubeTvGuide: decode directly, keep the exact News 3 availability expectation |
| should leave a channel without a live address when its row's live id is not one | YouTubeTvGuide: decode `oneRowGuide("y6zFA17zDsw?x")`, preserve the exact Upcoming/channel/begin expectation |
| should log why a response could not be read, without the response | YouTubeTvGuide: call decode under the same logger collector, preserve one Warn, `epgRenderer` present, `secret` absent |
| should refuse %s, giving no guide still (three rows) | YouTubeTvGuide: all three inputs still fail with `GuideUnreadable`; GuideReader: all three inputs still leave `NoGuide` |

The last row is a **split**, not permission to remove the reader's initial-state assertion. Retain its existing three-row reader test (including its error assertion) as publication-state protection; add/match the direct decoder error coverage in the owning suite. Its existing direct malformed-JSON and no-channels tests already cover two inputs: retain all their current assertions and add the non-guide JSON case, rather than adding duplicate tests for identical direct behavior:

```ts
it.effect("should reject JSON that is not a guide as GuideUnreadable", () =>
  Effect.gen(function* () {
    const error = yield* YouTubeTvGuide.decode("{}").pipe(Effect.flip)

    assert.strictEqual(error._tag, "GuideUnreadable")
  })
)
```

For the recorded and invalid-live-id scenarios, use this setup/act boundary with the original expected availability objects:

```ts
yield* TestClock.setTime(TestYouTubeTv.recordedAt)

const guide = yield* YouTubeTvGuide.decode(TestYouTubeTv.recordedGuide)
const availability = guide.availabilityOf(ohioStateAtIowa, guide.readAt)

assert.deepStrictEqual([availability], [onNews3])
```

Keep the snapshot/expected fixture definitions local to the destination (or reuse an existing identical definition there). These are assertion data, not new exported domain concepts. The invalid-id test supplies `TestYouTubeTv.oneRowGuide("y6zFA17zDsw?x")` instead. Do not drop the existing direct decoder's channel/airing counts or clock-stamp assertions.

For safe diagnostics, replace only the service call/layer composition:

```ts
yield* YouTubeTvGuide.decode(response).pipe(
  Effect.flip,
  Effect.provide(Logger.layer([collector]))
)
```

Keep the logger collection and four assertions unchanged.

- [ ] **4. Move the recorded cross-adapter matching matrix intact.** Move `describe("matching the 2026-10-03 slates to the guide read at 20:24:45Z")` from Source to YouTubeTvGuide, with both tests:

- `should place every college game on television that is under way, and the rest as the guide allows`
- `should put each of Sunday's CBS and FOX games on its own Sunday Ticket station`

Move its private `tallied` and `matchingLayer` harnesses with it, retaining the real `Source.layerYouTubeTv`, `GuideReader.layerYouTubeTv`, recorded ESPN provider, and `readRecordedGuide`. This remains adapter **acceptance** coverage; do not replace it with a hand-picked pair of decoded games.

Keep every id→channel mapping and every count: 8 unknown/13 streaming-only/17 not-in-guide for FBS; 12 Sunday stations, 7 CBS/5 FOX, 3 unknown/1 streaming-only for NFL. The expected dictionaries remain unchanged.

Convert the moved `tallied` effect-returning wrapper to the house spelling, keeping its generator body:

```ts
const tallied = Effect.fn("YouTubeTvGuide.test.tallied")(function* (league: LeagueId) {
  yield* TestYouTubeTv.readRecordedGuide
  const availabilityOf = yield* TestSource.availabilityNow
  const carried: Record<string, string> = {}
  const upcomingOn: Record<string, string> = {}
  const tally = { carried, upcomingOn, upcomingUnknown: 0, streamingOnly: 0, notInGuide: 0 }
  const listed = yield* TestProvider.listedBy(league)
  for (const game of listed) {
    for (const availability of availabilityOf(game))
      ChannelAvailability.match(availability, {
        Carried: ({ channel }) => {
          tally.carried[game.id] = channel.name
        },
        Upcoming: ({ channel }) =>
          Option.match(channel, {
            onNone: () => {
              tally.upcomingUnknown++
            },
            onSome: (name) => {
              tally.upcomingOn[game.id] = name
            }
          }),
        NoGuide: () => assert.fail(`${game.id} had no guide`),
        NotCarried: ({ why }) => {
          if (why === "StreamingOnly") tally.streamingOnly++
          else if (why === "NotInGuide") tally.notInGuide++
          else assert.fail(`${game.id} is not carried for ${why}`)
        }
      })
  }
  return tally
})
```

Import `TestSource` from `../TestSource.ts` and `TestProvider` from `../../provider/TestProvider.ts` as namespaces, `LeagueId` as a type from `@sportal/domain/League`, and `ChannelAvailability` from `@sportal/domain/Channel`. This wrapper/annotation adjustment is a separately identified small cleanup; the tally algorithm stays the same. Keep the pure `matchingLayer` function private below its user.

- [ ] **5. Audit what stays at the lifecycle seams, then remove originals.**

GuideReader retains all publication, 44/45-minute freshness, replacement, rejected-read-near-expiry, overlap, interruption, and state-preservation assertions. Source retains:

- no-guide mapping;
- `should give streaming only for a Prime Video game the guide does not list` as representative present-guide delegation;
- both Twitch tests;
- all four layerAll ordering/change/combined-source cases.

The remaining Source fixture `primeVideoSoonAfterRecording` still needs the recorded time. Do not remove the YouTubeTv layer constants used by its retained integration cases.

```bash
pnpm exec vitest run apps/hub/src/source/youtube-tv/YouTubeTvGuide.test.ts
pnpm exec vitest run apps/hub/src/source/GuideReader.test.ts apps/hub/src/source/Source.test.ts apps/hub/src/HubServer.test.ts
pnpm check
```

Subject: `test: colocate YouTube TV adapter coverage`. Ledger every moved/split test and the preserved direct decoder tests carrying existing error assertions.

## Task 6 — Extract remaining harnesses and make suites readable

**Create:** `apps/hub/src/TestHubServer.ts`, `apps/hub/src/source/TestGuide.ts`.

**Modify:** `apps/hub/src/HubServer.test.ts`, `apps/hub/src/source/Guide.test.ts`, `apps/hub/src/Director.test.ts`, `apps/hub/src/provider/espn/{FastCast.test,EspnProvider.test}.ts`.

**Production changes:** None. This task is extraction and grouping, not a new test framework.

- [ ] **1. Extract HubServer's reusable harness, leaving scenarios and expectations local.** Move these exact declarations from `HubServer.test.ts`:

| Declaration | New visibility / treatment |
| --- | --- |
| `makeClient` | exported, existing `HttpApiClient.make(SportalApi)` effect |
| `serverUnderTest` | exported, same optional Source layer and ephemeral Node server |
| `hubUnderTest` | private, same `provideMerge` order and version config |
| `liveLines` | exported `Effect.fn("TestHubServer.liveLines")`, same stream/fork/queue body |
| `pastInitialMessages` | exported `Effect.fn("TestHubServer.pastInitialMessages")`, same first-message consumption |
| `messageOf` | exported pure function, same `data: ` slicing and LiveMessageJson decoder |
| `publishedAfter` | exported, same delivery feeding, 250 ms settle, connection, first-message decode |

The new module imports `TestDirector` as a namespace and production modules by their proper shape. It takes `ReadonlyArray<Delivery>`, not a test-specific game fixture. The core layer functions remain:

```ts
export function serverUnderTest(
  source: Layer.Layer<Source, never, GuideReader> = Source.layerYouTubeTv
) {
  return HubServer.layer.pipe(
    Layer.provideMerge(hubUnderTest(source)),
    Layer.provideMerge(NodeHttpServer.layerTest)
  )
}

function hubUnderTest(source: Layer.Layer<Source, never, GuideReader>) {
  return TestDirector.directorOver.pipe(
    Layer.provideMerge(source),
    Layer.provideMerge(GuideReader.layerYouTubeTv),
    Layer.provideMerge(HubConfig.layerTest({ SPORTAL_VERSION: "1.2.3" }))
  )
}
```

Copy imports for `NodeHttpServer`, `HttpApiClient`, `HttpClient`, `SportalApi`, and `LiveMessageJson` from the existing test rather than guessing package paths. No `@sportal/domain/TestGame` import is needed in this new harness.

For `liveLines`/`pastInitialMessages`, replace `function f() { return Effect.gen(function* () { BODY }) }` with `export const f = Effect.fn("TestHubServer.f")(function* () { BODY })`. The body and fork scopes are unchanged. This is a test-only spelling cleanup, not runtime instrumentation.

Keep `game`, `firstSlate`, `firstSlateOnTestClock`, `inPeriod`, `realSizedGuideAiring`, `nextComment`, and `changingEverySecond` local to the test; they are scenario setup/projections. In particular retain the 700,000-character padding and `it.live`/three-second timeout for the large guide integration. Import `TestHubServer` as a namespace and qualify calls.

- [ ] **2. Extract reusable Guide/airing builders, not every fixture.** Create TestGuide with the existing `airing` implementation and the shared live-channel scenario constructor:

```ts
import { DateTime } from "effect"
import { type Airing, ChannelId, Guide } from "./Guide.ts"

export function onLiveChannel(readAt: DateTime.Utc, airings: ReadonlyArray<Airing>): Guide {
  return new Guide({
    source: "YouTube TV",
    readAt,
    channels: [
      {
        id: ChannelId.make("live-1"),
        name: "Live 1",
        live: { _tag: "WebView", url: "https://tv.youtube.com/watch/live1" }
      }
    ],
    airings
  })
}

export function airing(channel: ChannelId, title: string, begin: string, end: string): Airing {
  return { channel, title, begin: DateTime.makeUnsafe(begin), end: DateTime.makeUnsafe(end) }
}
```

Replace the local `onLiveChannel` closure with `TestGuide.onLiveChannel(readAt, airings)` and qualify all `airing` uses. Keep the existing local `readAt`, channel ids, expected URLs, multi-station recorded-like Guide, game snapshots, `nfl`, and `miamiAtClemson` values in their scenario scope. Put repeated `airingBeginning`/`baseballGuide` constructors below the tests or inline their short wrappers at use; do not create a game-fixture module or relax the cross-package TestGame boundary.

Keep every Guide assertion unchanged, including exact 45-minute boundary, ended-airing, ambiguous network, baseball-name collision, and network-only Twitch scenarios.

- [ ] **3. Group FastCast's retained tests under one owning suite.** Use nested `describe` names below; move whole test blocks, preserving test-clock timing and all assertions:

```text
FastCast
  connection       handshake, heartbeat, close, warning, defect, silence
  framing          socket text, checkpoint position, mid, malformed/unknown envelopes
  wanted topics    new/still-wanted/left/reset topics; new socket follows current set
  checkpoints      concurrent loading, missing/garbled/hanging checkpoint and warnings
  recovery         30-second refollow, cancellation, one pending retry, ordered outcomes
  reconnect        existing five jitter/backoff tests, unchanged
```

A test belongs in one section only. Preserve the reconnect jitter explanation next to its section. No test is renamed merely for consistency, and none becomes a parameterized test just to shorten the file.

- [ ] **4. Group EspnProvider without moving assertions out of its seam.**

```text
EspnProvider
  polling           non-2xx/invalid poll, cadence, independent leagues, deadlines, warnings
  merged deliveries per-run streams, push alongside polls, slow-poll/league interleaving
  wanted topics     initial empty, clock-driven 30-minute boundary, live/final, per-league retention
  retention/integration  synced state across listings, delisting, real FastCast subscribe/reset
```

Keep `settled`'s hundred yields, fake HTTP clock responses, and all stream/fiber start options. Leave private helpers below the suites, in first-use order; do not extract a generic polling harness.

- [ ] **5. Group HubServer and move Director's trailing behavior above its helpers.**

```text
HubServer
  HTTP endpoints    health, rejected guide, GET /api/slate remains absent
  GET /api/live
    SSE transport   initial framing, later changes, replay, source sharing, keep-alives
    settling        burst debounce and equal-availability suppression
    projection      snapshot/plays/availability/order/last-ten/final-game assertions
    guide integration  kickoff availability and large guide read publication
```

Keep all existing leaf test names, including the tests which use real time. Move `describe("Director's play log")` intact from below `broken` to immediately before the helper appendix beginning with `snapshotIn`. Leave the Director production service untouched.

- [ ] **6. Verify extracted layers, namespace use, and unchanged tests.**

```bash
pnpm exec vitest run apps/hub/src/source/Guide.test.ts apps/hub/src/Director.test.ts apps/hub/src/HubServer.test.ts apps/hub/src/provider/espn/FastCast.test.ts apps/hub/src/provider/espn/EspnProvider.test.ts
pnpm structure
pnpm check
```

The dependency check must accept `TestHubServer` → `TestDirector`; it must still reject a production import of either under Task 1's probe. Do not widen the adapter rule if a one-use source fixture can remain in `HubServer.test.ts` as specified.

Ledger: every regrouped test's old qualified name → new qualified name, unchanged leaf/assertions; every harness-rewritten Guide/HubServer case; Director play-log move. Subject: `test: expose Hub suite behavior before setup`.

## Task 7 — Update the map and prove the pass preserved behavior

**Modify:** `docs/technical-spec.md`; `CONTEXT.md` only for ownership-path corrections not already made. No historical spec/plan rewrites.

- [ ] **1. Regenerate the Hub portion of the technical tree from the actual file list.**

```bash
git ls-files apps/hub/src
rg -n 'ProviderFeed|ProviderUnavailable|FastCast|TestEspn|TestYouTubeTv|TestDirector|test.*import' CONTEXT.md docs/technical-spec.md
```

Reflect `ProviderFeed`, `TestHubServer`, `TestGameTopics`, `TestGuide`, and the existing `TestFastCast` entry if absent. Remove the deleted ProviderUnavailable-file entry if present. Describe TestEspn as recordings/day replay/cache, TestGameTopics as frame replay/state, and TestYouTubeTv as recorded/one-row responses. The tree convention omits ordinary test files: do not insert only the new test file and make it inconsistent; the adjacent-tests prose covers it.

Update the automatic-boundaries paragraph to say production cannot import Hub `Test*.ts`, while tests and Hub test harnesses can. Describe ProviderFeed's new path beside Provider's test-layer explanation. No new glossary concept is required: the service/error names already exist, and no new exported type was added.

- [ ] **2. Run structural acceptance searches and inspect the production diff.**

```bash
BASE="$(git rev-parse 9c3c4c6)"
git diff --name-status "$BASE" -- apps/hub/src .dependency-cruiser.cjs CONTEXT.md docs/technical-spec.md
rg -n '^export (class|type|const)|^export function' apps/hub/src/provider/Provider.ts apps/hub/src/provider/ProviderFeed.ts
rg -n 'FastCast\.make|ProviderUnavailable\.ts' apps/hub/src
rg -n 'import \{.*\} from .*EspnEvent' apps/hub/src
rg -n 'import \{.*\} from .*Test(Espn|FastCast|GameTopics|HubServer|Guide|YouTubeTv|Director)\.ts' apps/hub/src
pnpm structure
```

Expected: Provider exports the Provider class and Delivery member type/value, ProviderFeed owns its class, the three obsolete-import searches are empty, no new generic/concern-suffixed files exist. Other untouched namespace-import violations are not an invitation for a repo-wide sweep.

Review each production hunk against the Task 0 snapshot, including the new feed file, the private relocated error, and the inlined layer. Any change to a wire schema, route, service id/member signature, log/metric id, retry/silence/checkpoint duration, stream operator/concurrency/order, or acknowledgement logic blocks completion.

- [ ] **3. Capture final tests and coverage under the same configuration.**

```bash
set -o pipefail
pnpm exec vitest run --reporter=json --outputFile="$HUB_EVIDENCE/final-tests.json"
pnpm coverage --coverage.reporter=json --coverage.reporter=json-summary --coverage.reporter=text 2>&1 | tee "$HUB_EVIDENCE/final-coverage.log"
cp coverage/coverage-summary.json "$HUB_EVIDENCE/final-coverage-summary.json"
cp coverage/coverage-final.json "$HUB_EVIDENCE/final-coverage-final.json"
```

Compare each unchanged production file's **covered and uncovered lines/branches**, not merely the workspace percentage. Coverage includes test helpers too; new helper files alter denominators, so a workspace percentage delta alone is not a regression or a pass.

For changed production files, pair moved coverage by source operation:

- ProviderFeed: old `Provider.ts` class declaration → new `ProviderFeed.ts`; queue/acknowledgement remains in Provider.
- ProviderUnavailable: old file → private class in FastCast.
- FastCast: old constructor body → inlined layer body, unchanged follow branches.
- EspnEvent: schema-builder rename; no decode branch disappears.
- YouTubeTvGuide: declaration movement only.

Use the raw `coverage-final.json` source locations when summary denominators changed. No lost line/branch coverage in unchanged production files is acceptable without investigation and repair; do not loosen thresholds or add ignores. Do not compensate for a lost branch with extra coverage elsewhere.

- [ ] **4. Reconcile assertion ledgers and counts.** Compare Task 0's source and test names with all implementation commit bodies. Confirm each old assertion has a live destination, including:

- both ProviderFeed handshake/end assertions;
- mixed GameTopics document/delivery assertions and both Warning behaviors;
- malformed traffic through the actual socket and subsequent document reset;
- all recorded copy/move evidence and per-frame delivery cardinality;
- eight scoreboard transformations and every snapshot/play round trip;
- GuideReader rejected-read state for all three inputs, safe decoder diagnostics, complete recorded matching maps/counts;
- all timing, sharing, transport, metric/log, and large-guide integration assertions.

Report baseline/final file counts and test counts, explaining added tests from splits. Retain existing tests even when two suites cover overlapping behavior at different seams. Confirm no snapshot or provider fixture changed:

```bash
git diff --stat 9c3c4c6 -- apps/hub/src/provider/espn/fixtures apps/hub/src/source/youtube-tv/fixtures
```

Expected: empty.

- [ ] **5. Final gate, documentation commit, and handoff.**

```bash
pnpm check 2>&1 | tee "$HUB_EVIDENCE/final-check.log"
git diff --check
git status --short
```

Review documentation diff, then commit only the documentation updates with subject `docs: refresh the Hub ownership map`. Report the revision, check/coverage results, any explained coverage denominator changes, assertion-ledger reconciliation, and the evidence directory. Do not claim success from the planning baseline. No live feed/socket probe or provider-player interaction is needed.

## Small cleanups explicitly included

These are not additional refactors to improvise during execution:

1. Remove the one-use `FastCast.make` indirection and make its now-local error private.
2. Rename the private `EspnEvent` schema builder to `espnEvent`; namespace-qualify touched modules' imports.
3. Name the checkpoint decode before its constructor.
4. Use `Effect.fn` for moved test effect wrappers and annotations instead of the tally's two casts.
5. Remove dead imports/helpers after destinations are green; move one-off private helpers below behavior.

Everything else is a move, a preserved assertion split, a dependency-boundary check, or documentation. If a move exposes a behavior defect or requires production redesign, stop and separate it from this plan.

## Plan self-review / acceptance map

| Approved design requirement | Task |
| --- | --- |
| Baseline names/assertions/check/coverage | 0, then 7 |
| ProviderFeed split, test rename, handshake unchanged | 1 |
| General Hub Test boundary, narrower cross-package rules retained | 1; positive harness case in 6 |
| FastCast error/local constructor, same retry and framing | 2 |
| EspnEvent namespace/private spelling, YouTubeTvGuide order | 2 |
| Direct document suite, split assertions, real-socket downstream check | 3 |
| TestFastCast/TestGameTopics ownership | 3 |
| Scoreboard transformations and recorded schema round trips/cache | 4 |
| Decoder versus reader/source lifecycle, recorded matching acceptance | 5 |
| TestYouTubeTv one-row response | 5 |
| TestHubServer/TestGuide and behavior-first suite layout | 6 |
| Director play-log suite above helpers | 6 |
| Paths/tree, coverage mapping, full check, contract review | 7 |

No implementation has been performed by writing this plan.
