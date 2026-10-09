# Hub Encapsulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete all five recommendations from the Hub architecture analysis: localize guides, finish source decoding at the adapter, encapsulate ESPN state decisions, remove publication knowledge from Slate, and parse FastCast socket JSON once.

**Architecture:** Keep one ESPN frame fold feeding the Director's one authoritative Slate. Move interpretation and state decisions behind their existing interfaces rather than adding services. HTTP publication remains in HubServer; Display-owned Screen state, client-visible schemas, source ordering, and snapshot precedence remain unchanged.

**Tech Stack:** Effect 4.0.0, TypeScript, Vitest/@effect/vitest, pnpm workspaces.

**Baseline:** `45a5f85`. This is an execution plan, not implemented or runtime-verified code. Reconcile anchors against HEAD before executing.

---

## Scope and decisions

The user requested one plan for recommendations 1–5. They are mandatory here, including the previously optional envelope cleanup. Closely related lifecycle/recovery concerns are isolated in their own tasks, never hidden in mechanical refactors.

| Recommendation | Tasks |
| --- | --- |
| 1. Hub-local guide implementation | 1 |
| 2. Complete adapter decoding | 2 |
| 3. EspnState owns transitions and polling decisions | 4 |
| 4. Publication belongs to HubServer, not Slate | 5 |
| 5. Parse socket envelopes once | 6 |
| Guide lifecycle correctness | 3 |
| FastCast recovery ordering/cancellation | 7 |
| Bounded poll request and body read | 8 |
| Documentation and whole-system verification | 9, plus documentation in each earlier commit |

### Invariants

- `Provider.deliveries` stays `Stream<ReadonlyArray<Delivery>>`; keep `Listing`, `Snapshot`, and `Plays`.
- ESPN state describes the feed; Slate applies accepted-game precedence. Do not combine them or restore Slate precedence inside ESPN state.
- Raw topic documents, decoded-play caches, and accepted Slate plays have different purposes. Keep all three.
- Keep one merged frame fold, per-league polling, four concurrent checkpoint loads, ordered frame emission, and the minute-based wanted refresh.
- Keep the recent FastCast defect-containment fix: a push defect must not stop polling.
- Retention still happens only after poll frames, including failed/undecodable polls. Do not prune after every push or reject trailing checkpoint frames just because a game is no longer wanted.
- A successful empty listing is not a failed poll. Rename the misleading internal `unlisted` field to `failedPolls`.
- Keep ordered arrays in Slate; do not introduce an index, store, event bus, repository, or generic scheduler.
- Keep the Source resolver stream, explicit evaluation time, and source ordering. Source choice and same-source retuning remain in the Display.
- No change to SSE JSON, HTTP routes, `GuideUnreadable`'s tag/status, availability cases, live URLs, matching rules, or the number of recent plays.
- Keep immediate initial publication, trailing 250 ms debounce, equivalence filtering, shared encoding/replay-one, and per-connection keep-alives. Do not replace trailing debounce with a periodic rate limit.
- Guide freshness stays 45 minutes. Its outdated comment about the number of missed desktop reads is corrected, not used to change the duration.

### Intentional behavioral corrections

Only tasks 3, 7, and 8 may change runtime behavior:

1. A successfully installed guide always has a matching expiry, even with overlapping/interrupted reads.
2. Successful checkpoints cancel pending failed-checkpoint retries; recovery outcomes are applied in frame order.
3. A poll request plus body read has a fixed 20-second application deadline, becoming an ordinary failed poll on timeout. The next attempt waits the existing interval after the failure is folded; this is not a 20-second retry loop.

Do not broaden malformed-message recovery in task 6. Preserve the current distinction between an unknown/unreadable envelope and a recognized envelope whose patch payload fails. Improvements to that distinction need a separate behavior change.

## Preparation and working rules

- [ ] Read `AGENTS.md`, `CONTEXT.md`, `docs/technical-spec.md`, ADRs 0012, 0014, and 0015. The current code supersedes parts of older plans; do not reimplement the obsolete four-fold cleanup.
- [ ] Create an isolated implementation worktree using the using-git-worktrees skill. This plan itself can be written in the current checkout. Preserve the unrelated untracked `docs/Guard User Endpoints.md`; never stage it.
- [ ] Run `pnpm check` before implementation. Record existing failures separately.
- [ ] Read installed Effect documentation before changing Effect code. In this pnpm checkout, the root has no `node_modules/effect`; use `apps/hub/node_modules/effect/AGENTS.md`, `ai-docs/src/index.md`, the linked testing/schema examples, and current source definitions.
- [ ] Consult `effect/src/Semaphore.ts` (`withPermit`), `FiberHandle.ts` (`run`), `Effect.ts` (`uninterruptible`, `interruptible`, `timeout`), and `Stream.ts` (`mapEffect`) for tasks 3, 6–8.
- [ ] Use `pnpm check` before every implementation commit. Stage only the task's named files. In every rewritten-test commit body, list each old test name and the new test carrying its assertions (or the genuinely removed behavior). A moved test with unchanged name still gets an explicit old-file → new-file mapping.

For behavior-preserving moves, first prove existing tests green, move tests/imports, observe the expected missing-module/member failure, then move implementation. Do not invent a behavioral failure to justify a file move. New behavior fixes must have a reproducing regression before the fix.

## File ownership after completion

| File | Responsibility/change |
| --- | --- |
| `apps/hub/src/source/Guide.ts` | Moved Guide, Airing, ChannelId, matching logic; remains pure |
| `apps/hub/src/source/Guide.test.ts` | Moved guide behavior suite |
| `packages/api/src/GuideUnreadable.ts` | Existing cross-process tagged error, unchanged shape/status |
| `packages/api/src/SportalApi.ts` | Imports error from its API-local home |
| `apps/hub/src/source/youtube-tv/YouTubeTvGuide.ts` | Decode and validate a complete Guide, timestamp, safe diagnostics |
| `apps/hub/src/source/youtube-tv/YouTubeTvGuide.test.ts` | Direct complete-guide decoding tests against recorded payload |
| `apps/hub/src/source/GuideReader.ts` | Serialized successful installation and scoped expiry; no provider interpretation |
| `apps/hub/src/source/Twitch.ts` | Import-only migration to Hub-local Guide |
| `apps/hub/src/provider/espn/EspnState.ts` | Complete poll transition, retention, polling interval query |
| `apps/hub/src/provider/espn/EspnProvider.ts` | HTTP, timers and one frame fold; bounded poll |
| `apps/hub/src/Slate.ts` | Accepted-game transitions and changes only; no API/source imports |
| `apps/hub/src/HubServer.ts` | Existing shared publication pipeline now constructs SlateChanged |
| `apps/hub/src/provider/espn/FastCastMessage.ts` | Distinct outer envelope, framing validation, and patch-message validation |
| `apps/hub/src/provider/espn/Frame.ts` | Pushed carries the parsed envelope, not raw socket JSON |
| `apps/hub/src/provider/espn/FastCastDocuments.ts` | Decode patch content from parsed envelope; apply documents |
| `apps/hub/src/provider/espn/FastCast.ts` | Concurrent checkpoint loading, ordered recovery decisions |
| Existing `TestEspn.ts`, `TestFastCast.ts`, affected tests | Adapt test builders/harnesses without test-only production exports |

No package manifest change is needed: package exports already use `./* → ./src/*.ts`.

## Task 1 — Localize Guide; retain only its error in the API package

**Files:** Move `packages/domain/src/Guide.ts` and `Guide.test.ts` to `apps/hub/src/source/`; create `packages/api/src/GuideUnreadable.ts`; modify `packages/api/src/SportalApi.ts`, `apps/hub/src/source/{GuideReader,Twitch}.ts`, `apps/hub/src/source/youtube-tv/YouTubeTvGuide.ts`, `CONTEXT.md`, `docs/technical-spec.md`.

- [ ] **1. Establish the existing test baseline.**

```bash
pnpm exec vitest run packages/domain/src/Guide.test.ts apps/hub/src/source/GuideReader.test.ts apps/hub/src/source/Source.test.ts apps/hub/src/HubServer.test.ts
```

Expected: all pass before moving anything.

- [ ] **2. Move the guide tests first, repairing their imports.**

```bash
git mv packages/domain/src/Guide.test.ts apps/hub/src/source/Guide.test.ts
```

Keep `./Guide.ts` as the unit import. Change other former domain-relative imports to `@sportal/domain/<module>`, including `TestGame`; retain every assertion and test name. Run the same command with the new path: expected missing `./Guide.ts` until the implementation moves.

- [ ] **3. Move the implementation and separate the error.**

```bash
git mv packages/domain/src/Guide.ts apps/hub/src/source/Guide.ts
```

Remove only `GuideUnreadable` from the moved file. Keep Guide's schema id (`sportal/Guide`), all schemas, methods, matching constants, and behavior. Rewrite its imports of Channel, Game, League, Stream, and Team to package imports. Do not rename it, introduce a new options type, or convert it to another representation.

Create the entire API error module as:

```ts
import { Schema } from "effect"

/** A guide response the source could not read. */
export class GuideUnreadable extends Schema.TaggedError<GuideUnreadable>()(
  "GuideUnreadable",
  {},
  { httpApiStatus: 422 }
) {}
```

Use this exact import mapping:

| Consumer | Replacement |
| --- | --- |
| `SportalApi.ts` | `import { GuideUnreadable } from "./GuideUnreadable.ts"` |
| `GuideReader.ts` | `GuideUnreadable` from `@sportal/api/GuideUnreadable`; `Guide` from `./Guide.ts` |
| `Twitch.ts` | `ChannelId, Guide` from `./Guide.ts` |
| `youtube-tv/YouTubeTvGuide.ts` | `ChannelId, Guide` from `../Guide.ts` |

- [ ] **4. Validate import locality and wire compatibility.**

```bash
rg -n '@sportal/domain/Guide' apps packages
pnpm exec vitest run apps/hub/src/source/Guide.test.ts apps/hub/src/source/GuideReader.test.ts apps/hub/src/source/Source.test.ts apps/hub/src/HubServer.test.ts
pnpm structure
```

Expected: the search has no matches; all tests and structure checks pass. Existing HTTP rejection remains `GuideUnreadable`/422; no compatibility re-export is left behind.

- [ ] **5. Update Guide/error paths in glossary and architectural tree, run `pnpm check`, commit.** Suggested subject: `refactor: keep guide interpretation in the Hub`. Commit body records the unchanged-name migration of every Guide test.

## Task 2 — Have YouTubeTvGuide decode a complete Guide

**Files:** Modify `apps/hub/src/source/youtube-tv/YouTubeTvGuide.ts`, `apps/hub/src/source/GuideReader.ts`; create `apps/hub/src/source/youtube-tv/YouTubeTvGuide.test.ts`; retain `GuideReader.test.ts` integration assertions; update `CONTEXT.md` and technical-spec source descriptions.

- [ ] **1. Add direct adapter tests first.** Reuse `recordedGuide` and `recordedAt` from `./TestYouTubeTv.ts`; do not copy the recorded payload. Add this test file:

```ts
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"
import { Guide } from "../Guide.ts"
import { recordedAt, recordedGuide } from "./TestYouTubeTv.ts"
import * as YouTubeTvGuide from "./YouTubeTvGuide.ts"

describe("YouTubeTvGuide.decode", () => {
  it.effect("should return a complete guide stamped by the Effect clock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(recordedAt)

      const guide = yield* YouTubeTvGuide.decode(recordedGuide)

      assert.isTrue(guide instanceof Guide)
      assert.strictEqual(guide.source, "YouTube TV")
      assert.strictEqual(DateTime.toEpochMillis(guide.readAt), recordedAt)
      assert.isAbove(guide.channels.length, 0)
      assert.isAbove(guide.airings.length, 0)
    })
  )

  it.effect("should reject a response with no channels as GuideUnreadable", () =>
    Effect.gen(function* () {
      const response = JSON.stringify({
        contents: { epgRenderer: { paginationRenderer: { epgPaginationRenderer: { contents: [] } } } }
      })

      const error = yield* YouTubeTvGuide.decode(response).pipe(Effect.flip)

      assert.strictEqual(error._tag, "GuideUnreadable")
    })
  )

  it.effect("should reject malformed JSON as GuideUnreadable", () =>
    Effect.gen(function* () {
      const error = yield* YouTubeTvGuide.decode("not json").pipe(Effect.flip)

      assert.strictEqual(error._tag, "GuideUnreadable")
    })
  )
})
```

Run `pnpm exec vitest run apps/hub/src/source/youtube-tv/YouTubeTvGuide.test.ts`; expected failures: current return is not a Guide, empty channels are accepted, errors are schema errors.

- [ ] **2. Replace the exported partial decoder with a complete decoder.** Import `GuideUnreadable` from the API and `Effect`. Put the exported operation near the top (after the existing source value); codec constants stay below their lazy users. Replace the old exported `decode` at the bottom with private `decodeListing`.

```ts
export const decode = Effect.fn("YouTubeTvGuide.decode")(function* (response: string) {
  const decoded = yield* decodeListing(response).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("YouTubeTv: a guide response did not decode", error.message)
    ),
    Effect.mapError(() => new GuideUnreadable())
  )
  const readAt = yield* DateTime.now
  const guide = new Guide({ source, readAt, ...decoded })
  if (guide.channels.length === 0) {
    yield* Effect.logWarning("YouTubeTv: a guide response listed no channels")
    return yield* new GuideUnreadable()
  }

  yield* Effect.logInfo(
    `YouTubeTv: read a guide of ${guide.channels.length} channels and ${guide.airings.length} airings`
  )
  return guide
})

// Below GuideListing and the helpers that use it:
const decodeListing = Schema.decodeEffect(GuideListing)
```

Keep the existing URL validation, `GuideListing`, row/airing skipping, and safe error messages verbatim. The effect is lazy: defining `decode` above `decodeListing` is safe, calling it eagerly at module load is not.

- [ ] **3. Reduce GuideReader's decode phase to one operation.** In its current `readGuide` generator replace everything before `SubscriptionRef.set(latest, ...)` with:

```ts
const read = yield* YouTubeTvGuide.decode(response)
```

Keep installation/expiry unchanged until task 3. Remove now-unused DateTime and GuideUnreadable value imports (retain a type-only GuideUnreadable import for the service's error channel). Do not remove `GuideReader.readGuide`'s span or duplicate adapter diagnostics in it. HTTP logging remains in HubServer.

- [ ] **4. Run direct and integration tests, then commit after `pnpm check`.**

```bash
pnpm exec vitest run apps/hub/src/source/youtube-tv/YouTubeTvGuide.test.ts apps/hub/src/source/GuideReader.test.ts apps/hub/src/source/Source.test.ts apps/hub/src/HubServer.test.ts
```

All existing GuideReader assertions remain: recorded matching, invalid live-id behavior, safe diagnostics, all rejected-response cases, freshness, and no notification on rejection. They are useful service-interface coverage, not grounds for deleting tests. Suggested subject: `refactor: decode complete guides at the adapter`.

## Task 3 — Make guide installation and expiry one lifecycle operation

**Files:** `apps/hub/src/source/GuideReader.ts`, `GuideReader.test.ts`; lifecycle description in `CONTEXT.md`.

- [ ] **1. Add regression coverage before changing lifecycle code.** In the existing GuideReader describe, add:

```ts
it.effect("should not renew freshness when a rejected read arrives near expiry", () =>
  Effect.gen(function* () {
    yield* readRecordedGuide
    const reader = yield* GuideReader
    yield* TestClock.adjust("44 minutes")

    yield* reader.readGuide("{}").pipe(Effect.flip)
    yield* TestClock.adjust("1 minute")

    const availabilityOf = yield* availabilityNow
    assert.deepStrictEqual(availabilityOf(ohioStateAtIowa), [{ _tag: "NoGuide", source: "YouTube TV" }])
  }).pipe(Effect.provide(youTubeTv))
)

it.effect("should expire the guide surviving overlapping reads exactly once", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(recordedAt)
    const reader = yield* GuideReader

    yield* Effect.forEach([recordedGuide, recordedGuide], reader.readGuide, {
      concurrency: "unbounded",
      discard: true
    })
    const changes = yield* counted(laterGuides)
    yield* TestClock.adjust("45 minutes")

    const current = yield* Stream.runHead(reader.guide)
    const signalled = yield* Ref.get(changes)
    assert.deepStrictEqual(current, Option.some(Option.none()))
    assert.strictEqual(signalled, 1)
  }).pipe(
    Effect.provideService(Scheduler.MaxOpsBeforeYield, 1),
    Effect.provide(youTubeTv)
  )
)

it.effect("should still expire a published guide when its reading fiber is interrupted", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(recordedAt)
    const reader = yield* GuideReader
    const published = yield* reader.guide.pipe(
      Stream.filter(Option.isSome),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkChild({ startImmediately: true })
    )

    const reading = yield* reader.readGuide(recordedGuide).pipe(Effect.forkChild)
    yield* Fiber.join(published)
    yield* Fiber.interrupt(reading)
    yield* TestClock.adjust("45 minutes")

    const current = yield* Stream.runHead(reader.guide)
    assert.deepStrictEqual(current, Option.some(Option.none()))
  }).pipe(
    Effect.provideService(Scheduler.MaxOpsBeforeYield, 1),
    Effect.provide(youTubeTv)
  )
)
```

Add `Scheduler` to the Effect import. Use the installed public scheduler reference; do not insert yield hooks or testing switches in production. Run the GuideReader suite with a test timeout so an interrupted read cannot hang the run indefinitely:

```bash
pnpm exec vitest run apps/hub/src/source/GuideReader.test.ts --testTimeout=10000
```

The rejected-read case is characterization. The overlap/interruption concern was static analysis: record which regression reproduces on the baseline. If neither exposes it, refine the scheduler-controlled test through this same public interface before claiming a fix; do not report a reproduced bug merely because a new test exists.

- [ ] **2. Serialize read/install and protect only the small commit.** Import `Semaphore`. Create `const writes = yield* Semaphore.make(1)` beside `expiry` and `latest`. Replace `readGuide` with:

```ts
const readGuide = Effect.fn("GuideReader.readGuide")(
  function* (response: string) {
    const read = yield* YouTubeTvGuide.decode(response)
    const retire = SubscriptionRef.updateSome(latest, (current) =>
      Option.exists(current, (guide) => guide === read)
        ? Option.some(Option.none<Guide>())
        : Option.none()
    )
    const retirement = Effect.sleep(staleAfter).pipe(
      Effect.andThen(retire),
      Effect.interruptible
    )

    yield* Effect.gen(function* () {
      yield* SubscriptionRef.set(latest, Option.some(read))
      yield* FiberHandle.run(expiry, retirement)
    }).pipe(Effect.uninterruptible)
  },
  Semaphore.withPermit(writes)
)
```

The permit covers decode and installation so successful reads install in serialized order. Waiting for the permit and decoding stay interruptible. The published value and its timer replacement cannot be separated by interruption. The timer itself must remain interruptible; otherwise replacing a guide or shutting down could wait 45 minutes. Keep the identity guard; no extra revision counter or freshness flag.

- [ ] **3. Verify all freshness/replacement tests, source behavior, and shutdown behavior.**

```bash
pnpm exec vitest run apps/hub/src/source/GuideReader.test.ts apps/hub/src/source/Source.test.ts apps/hub/src/HubStopping.test.ts apps/hub/src/HubServer.test.ts
```

Correct the staleAfter comment to say only that a guide answers for 45 minutes. Run `pnpm check`; commit separately as `fix: keep guide publication and expiry together`.

## Task 4 — Encapsulate ESPN retention and polling decisions

**Files:** `apps/hub/src/provider/espn/{EspnState,EspnProvider,TestEspn}.ts`, corresponding tests and other callers found by `rg`; `CONTEXT.md`, technical spec.

- [ ] **1. Add a polling-decision test through the state interface.** Add `Duration` to EspnState.test.ts imports:

```ts
it.effect("should distinguish a successful empty listing from a failed poll", () =>
  Effect.gen(function* () {
    const now = DateTime.makeUnsafe("2026-10-04T18:00:00Z")
    const failed = yield* stateAfter([Frame.PollFailed({ league: "nfl" })])
    const empty = yield* stateAfter([
      Frame.PollFailed({ league: "nfl" }),
      poll("nfl", JSON.stringify({ events: [] }))
    ])

    const failedWait = failed.pollInterval("nfl", now)
    const emptyWait = empty.pollInterval("nfl", now)

    assert.strictEqual(Duration.toMillis(failedWait), 30_000)
    assert.strictEqual(Duration.toMillis(emptyWait), 900_000)
  })
)
```

Run `pnpm exec vitest run apps/hub/src/provider/espn/EspnState.test.ts`; expected failure: missing `pollInterval`.

- [ ] **2. Move cadence onto EspnState, not into a new scheduler.** Rename `unlisted` → `failedPolls` and `unlistedBy` → `pollFailed` within state and its tests; retain the set's meaning. Add Duration and value DateTime imports. Add this method:

```ts
/** How long this league waits after its latest poll has been taken. */
pollInterval(league: LeagueId, now: DateTime.Utc): Duration.Duration {
  const games = this.listing(league)
  const normal = games.some((game) => game.progress() === "live")
    ? Duration.seconds(10)
    : games.some((game) => game.isLiveOrKicksOffWithin(GameSnapshot.kickoffWindow, now))
      ? Duration.minutes(1)
      : Duration.minutes(15)
  return HashSet.has(this.failedPolls, league)
    ? Duration.min(normal, Duration.seconds(30))
    : normal
}
```

- [ ] **3. Put poll-triggered retention inside the transition.** Replace the public take implementation with:

```ts
take(
  frame: Frame,
  leagues: ReadonlyArray<LeagueId>
): Effect.Effect<readonly [EspnState, ReadonlyArray<Delivery>]> {
  return Effect.flatMap(taken(this, frame), ([next, deliveries]) => {
    const wasPoll = Frame.$is("Polled")(frame) || Frame.$is("PollFailed")(frame)
    if (!wasPoll) return Effect.succeed([next, deliveries] as const)

    return Effect.map(DateTime.now, (now) => [next.retained(leagues, now), deliveries] as const)
  })
}
```

Make `retained` private. Retain its algorithm unchanged. In particular, retention runs after `taken` has handled an undecodable poll and marked its failure; putting retention only in the decoder's successful branch would be incorrect. No Config service is passed into this pure-data class; the provider yields HubConfig as before and supplies its configured league list.

- [ ] **4. Reduce EspnProvider's takeFrame to orchestration.** Replace its transition body with:

```ts
const takeFrame = Effect.fnUntraced(function* (state: EspnState, frame: Frame) {
  const [next, said] = yield* state.take(frame, leagues)
  const now = yield* DateTime.now
  const league = pollLeagueOf(frame)

  yield* SubscriptionRef.set(view, next)
  if (Option.isSome(league)) {
    const at = pollAt.get(league.value)
    if (at !== undefined) {
      const nextPoll = DateTime.addDuration(now, next.pollInterval(league.value, now))
      yield* SubscriptionRef.set(at, Option.some(nextPoll))
    }
  }

  return [next, [said]] as const
})
```

Delete `interval` and the resulting unused GameSnapshot, Duration, and HashSet imports from EspnProvider. Keep `pollLeagueOf`, the per-league refs, `wantedOf`, `mapAccumEffect`, and the view publication. Production code outside EspnState must not inspect its storage collections. This step deliberately does not replace Data.Class or add accessor boilerplate just to hide every test-visible field.

- [ ] **5. Migrate every take caller and retention test.**

```bash
rg -n '\.take\(|\.retained\(|\.unlisted\b' apps/hub/src/provider/espn --glob '*.ts'
```

`TestEspn.decodedFrames`, `TestEspn.stateAfter`, and EspnState.test.ts's `resetTopics` pass `LeagueId.literals` to take. Tests of configured subsets pass their actual list. No default that silently disables retention.

Rewrite the two `EspnState#retained` tests to drive a poll transition instead of calling a now-private method. Preserve the old assertions exactly:

```ts
// In "should drop the document and plays of a game no longer wanted":
yield* TestClock.setTime(duringTheGames.epochMilliseconds)
const [kept] = yield* state.take(Frame.PollFailed({ league: "nfl" }), ["nfl"])
assert.isFalse(HashMap.has(kept.documents.byTopic, topicNamed(neAtBufPlays)))
assert.isFalse(HashMap.has(kept.plays, GameId.make("401872971")))

// In "should keep the document of a topic still wanted":
yield* TestClock.setTime(duringTheGames.epochMilliseconds)
const [kept] = yield* state.take(Frame.PollFailed({ league: "nfl" }), ["nfl"])
assert.isTrue(kept.documents.isSynced(topicNamed("event-football-nfl")))
```

Put both under `describe("EspnState#take, retention")`; add the TestClock import. Rename the failedPolls describe and its three tests only where needed; their existing membership assertions remain, beside the new observable polling-decision assertion. Test fixtures that need historical time must set TestClock explicitly; never disable retention to make a fixture pass.

Add one timing characterization using the existing synced/final/checkpoint fixture helpers:

```ts
it.effect("should keep a trailing game checkpoint until the next poll prunes it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.makeUnsafe("2026-10-04T18:00:00Z").epochMilliseconds)
    const tc = "gp-football-nfl-401872971"
    const state = yield* stateAfter([...synced(), neAtBufFinal(4286638)])

    const [afterPush, said] = yield* state.take(
      checkpoint(tc, 99, { entities: { plays: plays("401872971237") } }),
      ["nfl"]
    )
    const [afterPoll] = yield* afterPush.take(Frame.PollFailed({ league: "nfl" }), ["nfl"])

    assert.isTrue(said.some(Delivery.$is("Plays")))
    assert.isTrue(afterPush.documents.isSynced(topicNamed(tc)))
    assert.isFalse(HashMap.has(afterPoll.documents.byTopic, topicNamed(tc)))
    assert.isFalse(HashMap.has(afterPoll.plays, GameId.make("401872971")))
  })
)
```

- [ ] **6. Validate and commit.**

```bash
pnpm exec vitest run apps/hub/src/provider/espn/EspnState.test.ts apps/hub/src/provider/espn/EspnProvider.test.ts apps/hub/src/provider/espn/Espn.test.ts apps/hub/src/Director.test.ts
```

Preserve the recorded game's final/182-play assertion, lagging-poll behavior, independent league cadence, and failed-live-poll 10-second cadence. Update glossary wording from “last poll listed nothing” to “last poll failed or did not decode”; successful empty listings are normal. Run `pnpm check`; commit `refactor: encapsulate ESPN state decisions`.

## Task 5 — Move publication projection out of Slate

**Files:** `apps/hub/src/{Slate,Slate.test,HubServer,HubServer.test}.ts`, `CONTEXT.md`, technical spec.

- [ ] **1. Transfer all seven Slate#published behaviors to the HTTP seam before deleting them.** Keep the old tests temporarily. Use existing `delivered`, `liveLines`, `messageOf`, and `serverUnderTest`; do not export private publication helpers. Add this private test helper below the tests:

```ts
const publishedAfter = Effect.fnUntraced(function* (deliveries: ReadonlyArray<Delivery>) {
  yield* Effect.forEach(deliveries, delivered, { discard: true })
  yield* TestClock.adjust("250 millis")
  const { lines } = yield* liveLines()
  const line = yield* Queue.take(lines)
  return messageOf(line)
})
```

Call it only before the first live connection for that test, so the first shared projection is of the fully arranged slate. Each test uses a fresh `serverUnderTest` scope. Add `PlayId`, `play`, and `GameSnapshot` imports as used. Implement these seven individual tests with the following Arrange/Act/Assert content (the `it.effect` wrapper is `Effect.gen(...).pipe(Effect.scoped, Effect.provide(serverUnderTest()))`):

| New test name in `GET /api/live` | Deliveries/arrangement | Required assertions |
| --- | --- | --- |
| `should publish the listing order with leagues in their order` | FBS snapshots ids `3,1,2`; NFL snapshot id `9`; each live, period 1, clock 10:00 | message ids deep-equal `["9","3","1","2"]` |
| `should publish the accepted snapshot rather than the original listing` | FBS listing id `1`, live period 1; Snapshot id `1`, live period 2 | first game's period strictly equals 2 |
| `should publish each listed game's plays` | FBS listing id `1`; Plays containing `play({ id: PlayId.make("p1"), sequence: 1 })` | encoded/decoded play deep-equals the original domain play |
| `should publish only the last ten plays in sequence order` | FBS listing id `1`; Plays containing sequences 1–12 in reverse order | sequences deep-equal `[3,4,5,6,7,8,9,10,11,12]` |
| `should publish a listed final game` | FBS listing of `snapshot({ id: GameId.make("1"), status: "final" })` | published snapshots deep-equal `[final]` |
| `should not publish an unlisted game's snapshot` | FBS listing id `1`; Snapshot of id `9` | ids deep-equal `["1"]` |
| `should publish every source's availability beside each game` | Listing id `1`; server with `Source.layerAll` of two `layerTest`s answering StreamingOnly and NoGuide/Twitch | availability deep-equals both answers in supplied order |

Use these test bodies (alongside the existing HTTP tests):

```ts
it.effect("should publish the listing order with leagues in their order", () =>
  Effect.gen(function* () {
    const fbs = ["3", "1", "2"].map((id) =>
      snapshot({ id: GameId.make(id), league: "fbs", status: "live", period: 1, clock: "10:00" })
    )
    const nfl = snapshot({ id: GameId.make("9"), league: "nfl", status: "live" })

    const message = yield* publishedAfter([
      Delivery.Listing({ league: "fbs", games: fbs }),
      Delivery.Listing({ league: "nfl", games: [nfl] })
    ])

    assert.deepStrictEqual(message.games.map(({ game }) => game.snapshot.id), ["9", "3", "1", "2"])
  }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
)

it.effect("should publish the accepted snapshot rather than the original listing", () =>
  Effect.gen(function* () {
    const first = snapshot({ id: GameId.make("1"), status: "live", period: 1, clock: "10:00" })
    const next = snapshot({ ...first, period: 2 })

    const message = yield* publishedAfter([
      Delivery.Listing({ league: "fbs", games: [first] }),
      Delivery.Snapshot({ snapshot: next })
    ])

    assert.strictEqual(message.games[0]?.game.snapshot.period, 2)
  }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
)

it.effect("should publish each listed game's plays", () =>
  Effect.gen(function* () {
    const listed = snapshot({ id: GameId.make("1"), status: "live" })
    const recordedPlay = play({ id: PlayId.make("p1"), sequence: 1 })

    const message = yield* publishedAfter([
      Delivery.Listing({ league: "fbs", games: [listed] }),
      Delivery.Plays({ game: listed.id, plays: [recordedPlay] })
    ])

    assert.deepStrictEqual(message.games[0]?.game.plays, [recordedPlay])
  }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
)

it.effect("should publish a listed final game", () =>
  Effect.gen(function* () {
    const final = snapshot({ id: GameId.make("1"), status: "final" })

    const message = yield* publishedAfter([Delivery.Listing({ league: "fbs", games: [final] })])

    assert.deepStrictEqual(message.games.map(({ game }) => game.snapshot), [final])
  }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
)

it.effect("should not publish an unlisted game's snapshot", () =>
  Effect.gen(function* () {
    const listed = snapshot({ id: GameId.make("1"), status: "live" })
    const unlisted = snapshot({ id: GameId.make("9"), status: "live" })

    const message = yield* publishedAfter([
      Delivery.Listing({ league: "fbs", games: [listed] }),
      Delivery.Snapshot({ snapshot: unlisted })
    ])

    assert.deepStrictEqual(message.games.map(({ game }) => game.snapshot.id), ["1"])
  }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
)

it.effect("should publish every source's availability beside each game", () =>
  Effect.gen(function* () {
    const listed = snapshot({ id: GameId.make("1"), status: "live" })

    const message = yield* publishedAfter([Delivery.Listing({ league: "fbs", games: [listed] })])

    assert.deepStrictEqual(message.games[0]?.availability, [
      { _tag: "NotCarried", why: "StreamingOnly" },
      { _tag: "NoGuide", source: "Twitch" }
    ])
  }).pipe(
    Effect.scoped,
    Effect.provide(serverUnderTest(Source.layerAll([
      Source.layerTest(() => ({ _tag: "NotCarried", why: "StreamingOnly" })),
      Source.layerTest(() => ({ _tag: "NoGuide", source: "Twitch" }))
    ])))
  )
)

it.effect("should publish only the last ten plays in sequence order", () =>
  Effect.gen(function* () {
    const listed = snapshot({ id: GameId.make("1"), status: "live" })
    const plays = Array.from({ length: 12 }, (_, index) =>
      play({ id: PlayId.make(`p${index + 1}`), sequence: index + 1 })
    ).toReversed()

    const message = yield* publishedAfter([
      Delivery.Listing({ league: "fbs", games: [listed] }),
      Delivery.Plays({ game: listed.id, plays })
    ])

    assert.deepStrictEqual(message.games[0]?.game.plays.map(({ sequence }) => sequence), [
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12
    ])
  }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
)
```

Run HubServer.test.ts; these are characterization tests and must pass before the move.

- [ ] **2. Inline the projection at its only production caller.** Add a type-only `SlateChanged` import from the existing LiveMessage module. Replace only liveEvents' mapEffect projection, leaving operator order intact:

```ts
Stream.mapEffect(([slate, availabilityOf]) =>
  Effect.map(DateTime.now, (now): SlateChanged => {
    const games = slate.games.map((game) => ({
      game: game.recent(),
      availability: availabilityOf(game.snapshot, now)
    }))
    return { _tag: "SlateChanged", games }
  })
),
```

Delete `Slate.published` and its `SlateChanged` and `ChannelAvailability` imports. Keep `GameSnapshot`, which Slate still uses for relisting. Do not add a publication service, a new store, a public mapping helper, or another share operator.

- [ ] **3. Delete the seven superseded Slate#published tests only after the HTTP tests are green.** The exact migration ledger is:

| Old `Slate.test.ts` test | New `HubServer.test.ts` test |
| --- | --- |
| should keep the listing's order, leagues in their order | should publish the listing order with leagues in their order |
| should publish a game's latest snapshot over its listing's | should publish the accepted snapshot rather than the original listing |
| should carry each listed game's plays with it | should publish each listed game's plays |
| should carry only a game's last ten plays | should publish only the last ten plays in sequence order |
| should publish a final game a listing names | should publish a listed final game |
| should leave off a game no listing has | should not publish an unlisted game's snapshot |
| should put each game's availability from every source beside it | should publish every source's availability beside each game |

Remove now-unused `noAvailability`, `streamingOnly`, and imports from Slate.test.ts, but keep helpers used by its other tests. Copy the ledger into the commit body.

- [ ] **4. Verify and commit.**

```bash
pnpm exec vitest run apps/hub/src/Slate.test.ts apps/hub/src/HubServer.test.ts packages/api/src/LiveMessage.test.ts apps/web/src/hub/LiveStream.test.ts
rg -n 'published\(|@sportal/api|ChannelAvailability' apps/hub/src/Slate.ts
```

Expected: no matches in Slate, all tests green including debounce/replay/source-sharing/keep-alive tests. Update `CONTEXT.md`'s Slate changed row and technical-spec publication description. Run `pnpm check`; commit `refactor: keep slate publication in HubServer`.

## Task 6 — Parse FastCast outer JSON once

**Files:** `apps/hub/src/provider/espn/{FastCastMessage,Frame,FastCast,FastCastDocuments,TestEspn}.ts`, `FastCastMessage.test.ts`, `FastCast.test.ts`, `EspnState.test.ts`, `EspnProvider.test.ts`, `TestFastCast.ts`; `CONTEXT.md`, technical spec.

### Contract

Separate three operations, without introducing another module:

1. Parse socket JSON into an **Envelope**: a JSON object with a string `op`, retaining its other JSON fields. Invalid JSON or an object without a string op becomes `Option.none`.
2. Validate **Framed** fields for socket operation/handshake/checkpoint loading. This is the existing framing schema, operating on the parsed object rather than text.
3. Decode **Message**, including compressed patch payload, in FastCastDocuments from that same object. This remains the document module's responsibility.

Parsing once does not mean validating everything in FastCast. Do not decompress patches on the socket path, and do not replace malformed frames with a stream failure.

- [ ] **1. Add schema characterization tests.** Add `Option` to FastCastMessage.test.ts and these cases:

```ts
it("should retain patch payload text in an outer envelope", () => {
  const text = patchMessage("not decompressed here")

  const envelope = Schema.decodeUnknownSync(Schema.fromJsonString(FastCastMessage.Envelope))(text)

  assert.strictEqual(envelope.op, "P")
  assert.strictEqual(typeof envelope.pl, "string")
})

it("should retain an unknown operation without accepting it as a framed message", () => {
  const envelope = Schema.decodeUnknownSync(Schema.fromJsonString(FastCastMessage.Envelope))(
    JSON.stringify({ op: "X", extra: 1 })
  )

  const framed = Schema.decodeUnknownOption(FastCastMessage.Framed)(envelope)

  assert.strictEqual(envelope.extra, 1)
  assert.isTrue(Option.isNone(framed))
})
```

Run the file; expected failures against the old string-transforming Envelope/private Framed. Preserve both existing compressed-payload tests unchanged.

- [ ] **2. Replace the Envelope schema and expose the existing Framed wire schema.** In FastCastMessage.ts change `const Framed` to `export const Framed`; keep its definition. Replace the old Envelope transformation block with:

```ts
/** Outer socket JSON; payload decoding belongs to Message, not framing. */
export const Envelope = Schema.StructWithRest(Schema.Struct({ op: Schema.String }), [
  Schema.Record(Schema.String, Schema.Json)
])
export type Envelope = typeof Envelope.Type
```

Remove imports only if no remaining code uses them. These are provider wire names in FastCastMessage, exempt from new domain vocabulary requirements.

- [ ] **3. Change only Pushed's stored body representation.** Add a type-only namespace import of FastCastMessage to Frame.ts; replace the Pushed case with:

```ts
Pushed: {
  readonly topic: Option.Option<Topic>
  readonly mid: Option.Option<number>
  readonly envelope: Option.Option<FastCastMessage.Envelope>
}
```

Polled still carries response text, Checkpoint still carries its decoded document. Topic/mid remain typed routing metadata: derive them from a successfully validated Framed value, exactly as today. A malformed envelope must not newly acquire routing metadata merely because its raw `tc` resembles a topic.

- [ ] **4. Parse at socket receipt and reuse the handshake parse.** Replace FastCast's codec constants with:

```ts
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(FastCastMessage.Envelope))
const decodeFramed = Schema.decodeUnknownOption(FastCastMessage.Framed)
```

After obtaining `opened`, set `const openingEnvelope = decodeEnvelope(opened)` and `const opening = Option.flatMap(openingEnvelope, decodeFramed)`. The existing handshake switch uses `opening`; its onSome value is the message itself, not `{ message }`.

Replace the final concat/map section of connect with:

```ts
return Stream.concat(
  Stream.make({ text: opened, envelope: openingEnvelope }),
  rest.pipe(Stream.map((text) => ({ text, envelope: decodeEnvelope(text) })))
).pipe(
  Stream.mapEffect(({ text, envelope }) => framed(text, envelope, resubscribeLater), { concurrency: 4 }),
  Stream.flattenIterable
)
```

Change framed's signature to accept `envelope: Option.Option<FastCastMessage.Envelope>` before its existing recovery callback. Replace the code through the initial H guard with:

```ts
const message = Option.getOrUndefined(Option.flatMap(envelope, decodeFramed))
const topic = message !== undefined && "tc" in message ? topicOf(message.tc) : Option.none<Topic>()
const mid = message !== undefined && "mid" in message ? Option.some(message.mid) : Option.none<number>()
const frame = Frame.Pushed({ topic, mid, envelope })
if (message === undefined) {
  yield* Effect.logDebug("FastCast: framed a text of an unknown op", text)
  return [frame]
}
if (message.op !== "H" || Option.isNone(topic)) return [frame]
```

The remaining checkpoint path is unchanged in this task. Raw text is kept only while framing/logging; it is no longer the downstream state interface. The first handshake must not be parsed again in framed.

- [ ] **5. Decode documents from the parsed object.** In FastCastDocuments.moveOn:

```ts
if (Option.isNone(frame.envelope)) return unchanged(documents)
const decoded = yield* decodeMessage(frame.envelope.value).pipe(Effect.result)
```

Change the codec to `Schema.decodeUnknownEffect(FastCastMessage.Message)`, with no outer `Schema.fromJsonString`. In undecoded, replace `decodeKnownOp(frame.body)` with `Option.flatMap(frame.envelope, decodeKnownOp)`. The known-op codec becomes:

```ts
const decodeKnownOp = Schema.decodeUnknownOption(
  Schema.Union(FastCastMessage.Message.members.map((member) => Schema.Struct({ op: member.fields.op })))
)
```

Keep the remainder of the known-op/reset/error decision unchanged. Inner patch payload JSON/zlib decoding still exists and is required; the acceptance criterion is one parse of the **outer socket JSON**, not elimination of nested provider encodings.

- [ ] **6. Migrate builders and tests without weakening malformed-input coverage.** Replace each test/recording `Frame.Pushed({ topic, mid, body })` with `Frame.Pushed({ topic, mid, envelope: decodeEnvelope(body) })`, using the same codec as above privately in the relevant test module. Keep supplied topic/mid overrides in malformed fixtures: they deliberately test the document layer separately from framing. Do not edit fixture bytes.

`TestEspn.frameOf` parses a recorded change body once into its envelope while preserving the recording's topic/mid. `FastCast.test.ts`'s seen helper uses `Option.map(envelope, (value) => value.op)` for its displayed body instead of parsing raw text. Keep every expected frame tag/topic/mid/op and checkpoint assertion.

Search all callers:

```bash
rg -n 'Frame\.Pushed|decodeEnvelope|FastCastMessage\.Envelope|Pushed:|frame\.body' apps/hub/src/provider/espn --glob '*.ts'
```

For real socket-edge tests, add this field to fakeServer's returned object alongside its existing object `send`:

```ts
sendText: (data: string) => emit("message", { data }),
```

Both methods use the same emit function. Add independent tests in FastCast.test.ts that send malformed JSON, an unknown op, a malformed known envelope, and a structurally valid P with a bad payload. Assert one Pushed frame is still emitted and its metadata/envelope are respectively absent, preserved-but-unframed, unframed, and framed. Use this concrete pattern for malformed JSON:

```ts
it.effect("should emit an unreadable socket text without ending the feed", () =>
  Effect.gen(function* () {
    const server = fakeServer()
    const { frames } = yield* nflFrames(server)
    yield* frames.until(atLeast(2))

    yield* Effect.sync(() => server.sendText("not json"))
    yield* Effect.sync(() => server.send({ op: "B" }))
    const received = yield* frames.until(atLeast(4))

    const bad = received[2]
    assert.isTrue(bad !== undefined && Frame.$is("Pushed")(bad) && Option.isNone(bad.envelope))
    const after = received[3]
    assert.isTrue(
      after !== undefined && Frame.$is("Pushed")(after) &&
      Option.exists(after.envelope, (envelope) => envelope.op === "B")
    )
  })
)
```

Keep all EspnState malformed patch/reset tests. For the valid-envelope/bad-payload socket case, also feed the emitted frame into a synced EspnState and assert only its topic resets; do not claim document recovery from a framing-only assertion.

- [ ] **7. Validate and commit this refactor before recovery changes.**

```bash
pnpm exec vitest run apps/hub/src/provider/espn/FastCastMessage.test.ts apps/hub/src/provider/espn/FastCast.test.ts apps/hub/src/provider/espn/EspnState.test.ts apps/hub/src/provider/espn/EspnProvider.test.ts apps/hub/src/Director.test.ts
```

Inspect production decoders: FastCast alone parses outer socket JSON; FastCastDocuments receives objects. Keep one delivery array per frame, including empty arrays. Update Frame's glossary description; run `pnpm check`; commit `refactor: parse FastCast envelopes once`.

## Task 7 — Apply checkpoint recovery in emission order

**Files:** `apps/hub/src/provider/espn/FastCast.ts`, `FastCast.test.ts`; recovery description in `CONTEXT.md` and technical spec.

- [ ] **1. Add the failure→success regression.** Reuse the existing real FastCast fake-server harness:

```ts
it.effect("should cancel a pending checkpoint retry once its checkpoint succeeds", () =>
  Effect.gen(function* () {
    const server = fakeServer()
    const { frames } = yield* nflFrames(server)
    yield* frames.until(atLeast(2))
    yield* Effect.sync(() => server.send(missingCheckpoint(7)))
    yield* frames.until(numbered(7))

    yield* Effect.sync(() => server.send(checkpointMessage(8)))
    yield* frames.until(wholeAt(8))
    yield* TestClock.adjust("30 seconds")

    assert.lengthOf(server.sent.all().filter((frame) => frame.op === "S"), 1)
  })
)
```

Expected baseline failure: the existing retry still sends an S.

Add an out-of-order-loading version by replacing the first missing checkpoint URL with `/slow-missing`. In the test HTTP adapter, classify both `/missing` and `/slow-missing` as 404, and apply the existing five-second delay to `/slow-missing` as well as `/slow`. Send the slow failure (mid 7) then the ordinary success (mid 8) back-to-back, advance five seconds, wait for wholeAt(8), then advance 30 seconds. Assert frame suffix `[Pushed(mid 7), Pushed(mid 8), Checkpoint(mid 8)]` and only one S.

Add the reverse case: `/slow` success at mid 7 then immediate `/missing` at mid 8. After ordered emission and 30 seconds, assert two S frames. These are separate tests of separate recovery outcomes; both also assert socket-order frame emission.

- [ ] **2. Make concurrent framed return its outcome rather than scheduling retries.** Remove framed's recovery callback parameter. Give its effect the following inline return shape (no new exported type):

```ts
Effect.fn.Return<{
  readonly frames: ReadonlyArray<Frame>
  readonly checkpoint: Option.Option<{
    readonly topic: Topic
    readonly unread: Option.Option<CheckpointUnread>
  }>
}>
```

For non-H/unframed messages return `{ frames: [frame], checkpoint: Option.none() }`. After `checkpoint(topic.value, message.pl).pipe(Effect.result)` return:

```ts
if (Result.isSuccess(loaded)) {
  const whole = Frame.Checkpoint({ topic: topic.value, mid: message.mid, document: loaded.success })
  return {
    frames: [frame, whole],
    checkpoint: Option.some({ topic: topic.value, unread: Option.none<CheckpointUnread>() })
  }
}
return {
  frames: [frame],
  checkpoint: Option.some({ topic: topic.value, unread: Option.some(loaded.failure) })
}
```

Move failure logging out of this concurrent stage too. Concurrent HTTP/decoding remains limited to four; no subscriptions or retry-timer changes happen in framed.

- [ ] **3. Add one sequential outcome stage before flattening.** In connect, replace the final two operators with these three (the concurrent call no longer passes a recovery callback):

```ts
Stream.mapEffect(({ text, envelope }) => framed(text, envelope), { concurrency: 4 }),
Stream.mapEffect((loaded) => Effect.gen(function* () {
  if (Option.isSome(loaded.checkpoint)) {
    const outcome = loaded.checkpoint.value
    if (Option.isNone(outcome.unread)) {
      yield* FiberMap.remove(pending, outcome.topic)
    } else {
      const error = outcome.unread.value
      yield* Effect.logWarning(
        `FastCast: the checkpoint of ${tcOf(outcome.topic)} failed; subscribing to it again later`,
        error.cause
      ).pipe(Effect.annotateLogs({ topic: tcOf(outcome.topic), reason: error.reason }))
      yield* resubscribeLater(outcome.topic)
    }
  }
  return loaded.frames
})),
Stream.flattenIterable
```

This stage uses the default sequential mapEffect, not `{ concurrency: 4 }`. The log drops mid because the recovery outcome does not need another copy of it; preserve warning level, reason/topic annotations, and cause. Adjust any exact-string assertion only for this explicitly changed diagnostic, recording it in the test ledger. Retain `subscribeNow` cancellation, wanted checks before delayed resubscription, per-socket scopes, timeout/backoff, and stopped's never-ending push isolation.

- [ ] **4. Run all FastCast and provider tests, then commit.**

```bash
pnpm exec vitest run apps/hub/src/provider/espn/FastCast.test.ts apps/hub/src/provider/espn/EspnProvider.test.ts apps/hub/src/provider/espn/Espn.test.ts
```

Existing `dueToBeFollowedAgain` includes a later successful checkpoint: its earlier pending retry now correctly disappears. Preserve the behavior asserted by its callers (a new Synced→AwaitingCheckpoint transition subscribes immediately and does not later double-subscribe). Do not restore a stale timer merely to keep a helper's internal narrative. Run `pnpm check`; commit `fix: order FastCast checkpoint recovery`.

## Task 8 — Bound poll request plus body read

**Files:** `apps/hub/src/provider/espn/EspnProvider.ts`, `EspnProvider.test.ts`, technical-spec failure table.

- [ ] **1. Add one parameterized deadline test for stalled request and stalled body.** These are the same recovery behavior with two stall locations. Reuse `espnOver`, `settled`, and recorded `fbsLive`; no live network call:

```ts
it.effect.each(["request", "body"] as const)(
  "should retry a poll after its %s stalls without stopping the other league",
  (phase) => Effect.gen(function* () {
    const nflRequests = yield* Ref.make<ReadonlyArray<number>>([])
    const fbsRequests = yield* Ref.make(0)
    const client = HttpClient.make((request) => Effect.gen(function* () {
      if (!request.url.includes("/nfl/")) {
        yield* Ref.update(fbsRequests, (count) => count + 1)
        return HttpClientResponse.fromWeb(request, new Response(fbsLive))
      }
      const at = yield* Clock.currentTimeMillis
      yield* Ref.update(nflRequests, (all) => [...all, at])
      if (phase === "request") return yield* Effect.never
      return HttpClientResponse.fromWeb(request, new Response(new ReadableStream<Uint8Array>()))
    }))
    const { logs, layer } = recordingLogs()

    yield* Effect.gen(function* () {
      const provider = yield* Provider
      yield* provider.deliveries.pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
      yield* TestClock.adjust(0)
      yield* settled
      yield* TestClock.adjust("20 seconds")
      yield* settled
      yield* TestClock.adjust("30 seconds")
      yield* settled
    }).pipe(
      Effect.provide(espnOver(client).pipe(Layer.provideMerge(layer))),
      Effect.scoped
    )

    const nfl = yield* Ref.get(nflRequests)
    const fbs = yield* Ref.get(fbsRequests)
    assert.deepStrictEqual(nfl, [0, 50_000])
    assert.isAtLeast(fbs, 2)
    assert.isTrue(logs.some((entry) => entry.level === "Warn"))
  })
)
```

The new Response/ReadableStream is a framework-edge test fixture; no bare promises or async helpers are introduced. Run the provider suite; expected failure: NFL never makes its second request without a deadline. Preserve the existing test that a push arriving during a slow poll is delivered first.

- [ ] **2. Apply timeout before the existing error handler.** Keep timeout as a private fixed policy, not a new environment setting. In the polled pipeline:

```ts
client.get(scoreboardUrl(league)).pipe(
  Effect.flatMap((response) => response.text),
  Effect.timeout("20 seconds"),
  Effect.map((body) => Frame.Polled({ league, body })),
  Effect.catch((error) =>
    Effect.logWarning(
      "EspnProvider: a poll failed; keeping the last good listing for this league, if any",
      error
    ).pipe(Effect.annotateLogs({ league }), Effect.as(Frame.PollFailed({ league })))
  )
)
```

The timeout encloses both connection and body consumption. It flows through PollFailed, then EspnState's existing cadence; it does not create a second retry mechanism or a new error type. Live-league failures still wait ten seconds; otherwise failures cap the wait at thirty seconds.

- [ ] **3. Verify and commit separately.** Run provider, Espn, and Director tests; update the documented timeout and retry timeline. Run `pnpm check`; commit `fix: bound ESPN poll requests and bodies`.

## Task 9 — Reconcile documentation and verify the full result

**Files:** `CONTEXT.md`, `docs/technical-spec.md`; comments of touched modules. Change ADR 0014 only by adding a dated amendment/link if needed, not by rewriting its historical decision as though it originally described this implementation.

- [ ] **1. Update the current architecture descriptions.**

Make these statements explicit:

- Guide, Airing and ChannelId are Hub-local under `source/Guide.ts`; GuideUnreadable is an API error.
- YouTubeTvGuide returns a complete, validated, Clock-stamped Guide; GuideReader owns installation and expiry.
- EspnState.take includes poll-triggered retention; failedPolls distinguishes failed polls from successful empty listings; pollInterval owns cadence decisions, while EspnProvider owns I/O and waiting.
- Slate never constructs a live message. HubServer projects accepted games and source availability after settling, then deduplicates, encodes, and shares once.
- Pushed frames carry parsed envelopes; the framing and patch-validation steps remain distinct.
- Checkpoint loading is concurrent, recovery decisions/emission are ordered, and success cancels a pending failed-checkpoint retry.
- Poll request/body deadline is twenty seconds; retries use existing post-fold cadence.
- Listing ties retain the accepted live snapshot (`Game.listed`); remove “there is no tie rule” from the current technical spec. ESPN listings still accept a poll as sent, even when Slate does not.
- Publication is trailing 250 ms settling, not a guaranteed maximum 250 ms latency during continuous updates.

No new glossary concepts or service names are required. Update existing Frame, Guide, Guide reader, ESPN state, and Slate changed rows, and the physical tree.

- [ ] **2. Run structural searches.**

```bash
rg -n '@sportal/domain/Guide|Slate#published|Slate\.published' apps packages CONTEXT.md docs/technical-spec.md
rg -n 'unlisted|\.retained\(' apps/hub/src/provider/espn/EspnProvider.ts
rg -n 'Schema\.fromJsonString\(FastCastMessage\.Message\)|frame\.body' apps/hub/src/provider/espn/FastCastDocuments.ts
```

Expected: no obsolete references in these scopes. Historical plans and ADR prose are not mass-rewritten. Ensure only private state implementation uses retention and failedPolls storage, not EspnProvider.

- [ ] **3. Run final verification.**

```bash
pnpm check
pnpm --filter @sportal/web build
git diff --check
git status --short
```

Expected: checks/tests/build pass, no whitespace errors, and only intended changes. No source-control operations include the unrelated Guard User Endpoints document.

- [ ] **4. Review the blast radius with fovea_impact and inspect the final diff.** Confirm no change to `packages/domain/src/Game.ts`, `ChannelAvailability`, `LiveMessage`'s shape, Screen ownership, main's concrete adapter choices, metrics ids, or provider polling frequency beyond the explicit timeout behavior. Compare every rewritten test against its migration ledger.

- [ ] **5. Commit any remaining documentation only after `pnpm check`.** Suggested subject: `docs: clarify Hub ownership and recovery`. Report commands actually run, failures, and remaining risks; do not claim the new concurrency cases were reproduced if they were only characterized.

## Completion criteria

- All five recommendations are implemented, not deferred.
- Source and ESPN callers ask for complete values/decisions instead of completing someone else's state transition.
- No new application service, package, generic scheduler, persistence layer, or mirrored wire type exists.
- Mechanical moves/refactors and the three lifecycle/recovery corrections are separate reviewable commits.
- Existing behavior assertions have explicit destinations; fixture bytes and recorded-day final/play-count assertions are preserved.
- `pnpm check`, the web build, and final diff review pass.
