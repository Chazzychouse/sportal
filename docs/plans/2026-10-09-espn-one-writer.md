# ESPN One Writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ESPN's state one writer and one rule for which snapshot wins, decode only what each feed carries, and
stop the provider and the live stream doing work twice or keeping what nothing follows.

**Architecture:**
- `EspnProvider.deliveries` becomes one `Stream.mapAccumEffect` fold over each league's polls merged with FastCast's
  frames. The fold is the only writer of `EspnState`. Each league schedules its own next poll through a ref only the
  fold sets.
- `EspnState` stops applying the Slate's precedence. It learns which leagues are unlisted, keeps decoded plays by id,
  and drops what is no longer followed.
- FastCast decodes a checkpoint once into its document, loads checkpoints side by side, and keeps per-topic follow
  state in one map. A FastCast event decodes only what it moves.
- The live route shares one encoded stream across connections. A delisted game's gauge series is removed.

**Tech Stack:** TypeScript 7, Effect 4 (`Stream`, `SubscriptionRef`, `HashMap`, `HashSet`, `Data`, `Schema`,
`Metric`), `@effect/vitest`.

**Spec:** `docs/specs/2026-10-09-espn-one-writer-design.md`.

## Global Constraints

- Read `AGENTS.md` first. Effect 4 is newer than training data: check `apps/hub/node_modules/effect/dist/*.d.ts`
  before using an API this plan does not spell out. Signatures this plan relies on, checked:
  - `Stream.switchMap(f)`, `Stream.mergeAll(streams, { concurrency })`, `Stream.mapAccumEffect(initial, f)`.
  - `Stream.share({ capacity: "unbounded", replay })` returns `Effect<Stream, never, Scope>`.
  - `DateTime.distance(start, end)` is `end - start`.
  - `Metric.MetricRegistry` is a `Context.Reference<Map<string, { id; attributes; … }>>`.
- Every exported type name is a `CONTEXT.md` term. This plan adds no exported type; it changes the wording of the
  `ESPN state`, `Frame` and `Director` rows (Tasks 1, 3, 6, 10).
- One behaviour per test, `it("should …")`, Arrange/Act/Assert separated by blank lines, no `// Arrange` comments.
- Rewriting a test keeps every assertion it had, unless the behaviour it asserts was removed. The commit body lists,
  per rewritten file, each old test name and the new test names that carry its assertions, or the removed behaviour
  it went with.
- No `any`, no casts outside decoding, no non-null assertions, no `_tag ===` (use `X.$is` / `X.$match`). Time comes
  from `DateTime.now` / `Clock`.
- Metric ids never change. `sportal_poll_duration` gains a `league` attribute (Task 7); nothing else changes
  attributes.
- `pnpm check` must pass before every commit (the push hook runs it).
- Work in a worktree on branch `espn-one-writer`, created from `main`:
  `git worktree add ../sportal-espn-one-writer -b espn-one-writer main`, then `pnpm install` there.

## File map

| File | After this plan |
|---|---|
| `packages/domain/src/Game.ts` | `GameSnapshot#advancedTo` takes the moved fields, not a snapshot |
| `apps/hub/src/provider/espn/EspnPayload.ts` | `FastCastEvent` keeps only what is read: id, status, competitors' id/side/score, situation |
| `apps/hub/src/provider/espn/EspnEvent.ts` | `EspnEvent(league)` decodes a site event; `PushedEvent(league)` decodes a FastCast event to what it moves |
| `apps/hub/src/provider/espn/Frame.ts` | `Checkpoint` carries `document`; new `PollFailed` |
| `apps/hub/src/provider/espn/FastCastMessage.ts` | `Checkpoint(topic)` decodes a checkpoint's text straight to its document |
| `apps/hub/src/provider/espn/FastCastDocuments.ts` | Syncs from a document; `DocumentChange.Game` says which plays it touched; `retained` |
| `apps/hub/src/provider/espn/FastCast.ts` | One `Ref<HashMap<Topic, TopicFollow>>`; checkpoints framed four at a time |
| `apps/hub/src/provider/espn/EspnState.ts` | No `keptOver`; `unlisted`; decoded `plays` by game; `retained` |
| `apps/hub/src/provider/espn/EspnProvider.ts` | One fold; each league polls by its own games |
| `apps/hub/src/HubServer.ts` | One shared, debounced, encoded live stream |
| `packages/domain/src/Guide.ts` | Each game's kickoff window built once |
| `apps/hub/src/Director.ts` | A delisted game's series is removed |

Tasks 1–6 change `EspnState` and FastCast with `EspnProvider` as it is. Task 7 rewrites `EspnProvider` on top of
them. Tasks 8–9 are independent of the rest.

---

### Task 1: One rule for which snapshot wins

A poll replaces its league's listing as it shows it. The Slate keeps applying `Game#listed`.

**Files:**
- Modify: `apps/hub/src/provider/espn/EspnState.ts` (`listed`, `keptOver`, the class doc)
- Test: `apps/hub/src/provider/espn/EspnState.test.ts`
- Modify: `CONTEXT.md` (the `ESPN state` row), `docs/technical-spec.md` (line 295)

**Interfaces:**
- Produces: `EspnState#listing(league)` is the league's last poll's games, with pushes since advanced in.

- [ ] **Step 1: Rewrite the lag test to the new behaviour**

In `EspnState.test.ts`, replace `"should keep a pushed game's progress over a poll that lags it"` with:

```ts
  it.effect("should list a poll's games as it shows them, even one a push moved past it", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([...synced(), neAtBufFinal(4286638), poll("nfl", scoreboardBody)])

      const game = state.games().find((each) => each.id === "401872971")
      assert.strictEqual(game?.progress(), "live")
    })
  )
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/EspnState.test.ts -t "even one a push moved past it"`
Expected: FAIL, `expected 'over' to equal 'live'`.

- [ ] **Step 3: Drop `keptOver`**

In `EspnState.ts`, `listed` becomes:

```ts
const listed = Effect.fnUntraced(function* (state: EspnState, league: LeagueId, body: string) {
  const scoreboard = yield* decodeScoreboard(body)
  const games = yield* gamesOf(league, scoreboard.events)

  const next = new EspnState({ ...state, listings: HashMap.set(state.listings, league, games) })
  return [next, [Delivery.Listing({ league, games })]] as const
})
```

Delete `keptOver` and its doc, and the `Game` import if nothing else uses it. In the doc of `take`, replace "the
listing it keeps holds, for a game a push moved past the poll, the pushed one (`Game#listed`)" with "its listing is
the games it shows, as it shows them". In the class doc, replace "as its last poll listed them, and each push since
(a push behind its listed game is logged and counted)" with "as its last poll showed them, each push since advanced
in (a push behind its listed game is logged and counted). Which snapshot wins is the Slate's rule, not the state's".

- [ ] **Step 4: Run the file**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/EspnState.test.ts`
Expected: PASS.

- [ ] **Step 5: Docs**

- `CONTEXT.md`, `ESPN state` row: delete "(a lagging poll does not set a pushed game back)".
- `docs/technical-spec.md:295`: "as its last poll listed them, and each push since" becomes "as its last poll showed
  them, and each push since".

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/provider/espn/EspnState.ts apps/hub/src/provider/espn/EspnState.test.ts CONTEXT.md docs/technical-spec.md
git commit -m "refactor: ESPN's listing is what it last said; the Slate alone says which snapshot wins

EspnState.test.ts: 'should keep a pushed game's progress over a poll that lags it' went with keptOver;
'should list a poll's games as it shows them, even one a push moved past it' asserts the new behaviour.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: A FastCast event is only what it moves

**Files:**
- Modify: `packages/domain/src/Game.ts` (`advancedTo`), test `packages/domain/src/Game.test.ts`
- Modify: `apps/hub/src/provider/espn/EspnPayload.ts` (`FastCastEvent`)
- Modify: `apps/hub/src/provider/espn/EspnEvent.ts`, test `EspnEvent.test.ts`
- Modify: `apps/hub/src/provider/espn/EspnState.ts` (the scoreboard push path), test `EspnState.test.ts`

**Interfaces:**
- Produces:
  - `GameSnapshot#advancedTo(moved: { readonly status: GameStatus; readonly period: number; readonly clock: string; readonly homeScore: number; readonly awayScore: number; readonly situation?: Situation | undefined }): GameSnapshot`
  - `PushedEvent(league: LeagueId)`: a schema from a FastCast event to `{ id: GameId, status, period, clock, homeScore, awayScore, situation? }`.
  - `EspnEvent(league)`: a schema from a site event to `GameSnapshot` only.

- [ ] **Step 1: Domain test for the new `advancedTo`**

In `packages/domain/src/Game.test.ts`, find the `GameSnapshot#advancedTo` tests. Each that passes a whole snapshot
passes the moved fields instead, keeping its assertions. Add:

```ts
  it("should drop the situation when the moved fields have none", () => {
    const listed = liveSnapshot({ situation: situation({ down: 2 }) })

    const advanced = listed.advancedTo({
      status: "halftime",
      period: 2,
      clock: "0:00",
      homeScore: 7,
      awayScore: 3
    })

    assert.isUndefined(advanced.situation)
    assert.strictEqual(advanced.home.score, 7)
    assert.strictEqual(advanced.home.team, listed.home.team)
  })
```

(`liveSnapshot` and `situation` are in `packages/domain/src/TestGame.ts`; check their argument shapes there.)

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @sportal/domain exec vitest run src/Game.test.ts -t advancedTo`
Expected: FAIL to typecheck or run. `advancedTo` still takes a `GameSnapshot`.

- [ ] **Step 3: Change `advancedTo`**

```ts
  /**
   * This game moved on to `moved`'s status, period, clock, scores, and situation (none when it has none), keeping its
   * own teams, rankings, kickoff, and broadcasts.
   */
  advancedTo(moved: {
    readonly status: GameStatus
    readonly period: number
    readonly clock: string
    readonly homeScore: number
    readonly awayScore: number
    readonly situation?: Situation | undefined
  }): GameSnapshot {
    return new GameSnapshot({
      id: this.id,
      league: this.league,
      kickoff: this.kickoff,
      broadcasts: this.broadcasts,
      status: moved.status,
      period: moved.period,
      clock: moved.clock,
      home: { ...this.home, score: moved.homeScore },
      away: { ...this.away, score: moved.awayScore },
      ...(moved.situation === undefined ? {} : { situation: moved.situation })
    })
  }
```

Import `Situation`'s type into `Game.ts` if it is not already (it is a field type there). Run the domain tests; they
should pass.

- [ ] **Step 4: Trim `FastCastEvent`**

In `EspnPayload.ts`:

```ts
export const FastCastEvent = Schema.Struct({
  id: Schema.String,
  fullStatus: EspnStatus,
  competitors: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      homeAway: Schema.Literals(["home", "away"]),
      score: Schema.optional(Schema.String)
    })
  ),
  situation: Schema.optional(EspnSituation)
})
```

Keep its doc comment, and add "only what the Hub reads of it" to it.

- [ ] **Step 5: Split `EspnEvent`**

In `EspnEvent.ts`:
- `EspnEvent(league)` becomes only the `SiteEvent` branch (no `Schema.Union`). Its doc becomes "One game as the site
  scoreboard spells it, read as a `league` `GameSnapshot`. An event without a home and an away team does not decode."
- Delete the `location ?? displayName` / `shortDisplayName ?? displayName` fallbacks and the FastCast comment. The
  site event always carries `location` and `shortDisplayName`: check `SiteEvent` in `EspnPayload.ts`. If they are
  optional there, keep `?? displayName` and drop only the comment.
- Make `location` and `shortDisplayName` required in `snapshot`'s `event.competitors` shape, if `SiteEvent` has them
  required.

Add below `EspnEvent`:

```ts
/**
 * One game as a FastCast scoreboard topic's document spells it, read as what it moves: its status, period, clock,
 * scores, and situation. An event without a home and an away team does not decode.
 */
export function PushedEvent(league: LeagueId) {
  return FastCastEvent.pipe(
    Schema.decodeTo(Schema.toType(Moved), {
      decode: SchemaGetter.transformEffect((event) => moved(league, event)),
      encode: SchemaGetter.forbidden(() => "A pushed event cannot be encoded back to an ESPN event")
    })
  )
}
```

and, below the helpers `EspnEvent` uses:

```ts
const Moved = Schema.Struct({
  id: GameId,
  status: GameStatus,
  period: Schema.Int,
  clock: Schema.String,
  homeScore: Schema.Int,
  awayScore: Schema.Int,
  situation: Schema.optional(Situation)
})

/** What a FastCast event moves. */
const moved = Effect.fnUntraced(function* (league: LeagueId, event: typeof FastCastEvent.Type) {
  const home = event.competitors.find((competitor) => competitor.homeAway === "home")
  const away = event.competitors.find((competitor) => competitor.homeAway === "away")
  if (home === undefined || away === undefined) {
    return yield* Effect.fail(
      new SchemaIssue.InvalidValue({ message: "An event needs a home and an away team" }, event)
    )
  }
  return {
    id: GameId.make(event.id),
    status: statusOf(event.fullStatus.type),
    period: event.fullStatus.period,
    clock: event.fullStatus.displayClock,
    homeScore: scoreOf(home.score),
    awayScore: scoreOf(away.score),
    ...(event.situation === undefined ? {} : { situation: situation(league, event.situation, home.id) })
  }
})
```

Move the score rule out of `side` into a shared helper, so both use it:

```ts
// A score is digits, or nothing before kickoff, which reads as 0.
function scoreOf(score: string | undefined): number {
  return Number.parseInt(score ?? "", 10) || 0
}
```

`side` then sets `score: scoreOf(competitor.score)`. Import `GameStatus` as a value (`import { …, GameStatus, … }`),
since `Moved` reads it as a schema.

- [ ] **Step 6: `EspnState` decodes pushes with `PushedEvent`**

In `EspnState.ts`:
- `decodeEvent` stays for polls.
- Add `decodePushed`, built once per league, as `decodeEvent` is:

```ts
const decodePushed: { readonly [L in LeagueId]: ReturnType<typeof decodePushedOf> } = {
  nfl: decodePushedOf("nfl"),
  fbs: decodePushedOf("fbs")
}

function decodePushedOf(league: LeagueId) {
  return Schema.decodeUnknownEffect(PushedEvent(league))
}
```

- The `Scoreboard` case of `pushed` decodes `events` with `decodePushed[league]` (skip what does not decode, as
  `gamesOf` does: `Effect.forEach(events, (event) => Effect.option(decodePushed[league](event)))` then
  `Arr.getSomes`).
- `movedForward(state, league, moves)` takes those values. Each is matched to its listed game by `move.id` and
  advanced with `listedGame.advancedTo(move)`. The rest of `movedForward` is unchanged.
- In the doc of `take`, replace "advanced to it (FastCast has no short names)" with "its listed game advanced to what
  it moves".

- [ ] **Step 7: Rewrite the tests that read a FastCast event whole**

`EspnState.test.ts`:
- `"should decode each checkpoint event alone"` becomes (the golden's `checkpointEvents` stay the reference; only
  what a pushed event moves is compared):

```ts
    it("should read each checkpoint event as what it moves", () => {
      const decodePushed = Schema.decodeUnknownSync(PushedEvent("nfl"))
      const decodeExpected = Schema.decodeUnknownSync(Schema.Array(GameSnapshot))

      const read = checkpointEvents().map((event) => decodePushed(event))

      assert.deepStrictEqual(
        read,
        decodeExpected(expected.checkpointEvents).map((game) => ({
          id: game.id,
          status: game.status,
          period: game.period,
          clock: game.clock,
          homeScore: game.home.score,
          awayScore: game.away.score,
          ...(game.situation === undefined ? {} : { situation: game.situation })
        }))
      )
    })
```

- Delete `"should carry a checkpoint event's teams' colors"`. A pushed event no longer carries teams.
- Replace the `EspnEvent` import with `PushedEvent` where only the pushed decode is used.

`EspnEvent.test.ts`: the tests that decode `fastCastEvent` (around lines 76–96) as a `GameSnapshot` decode it with
`PushedEvent("nfl")` and keep only their assertions on status, period, clock, scores and situation. Assertions on
names, colours, broadcasts or kickoff of a FastCast event go with that behaviour. List them in the commit body.

- [ ] **Step 8: Run the hub and domain tests**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn && pnpm --filter @sportal/domain exec vitest run`
Expected: PASS. `"should decode each listing and push"` still passes unchanged: a delivered snapshot is the listed
game advanced, as before.

- [ ] **Step 9: `pnpm check`, then commit**

```bash
git add packages/domain/src/Game.ts packages/domain/src/Game.test.ts apps/hub/src/provider/espn
git commit -m "refactor: a FastCast event decodes to what it moves; advancedTo takes only that

<per-file list of rewritten and removed tests>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: A checkpoint is decoded once

**Files:**
- Modify: `apps/hub/src/provider/espn/Frame.ts`, `FastCastMessage.ts`, `FastCast.ts`, `FastCastDocuments.ts`,
  `TestEspn.ts`
- Test: `FastCast.test.ts`, `EspnState.test.ts`
- Modify: `CONTEXT.md` (the `Frame` row)

**Interfaces:**
- Produces:
  - `Frame.Checkpoint({ topic: Topic, mid: number, document: Schema.Json })`.
  - `FastCastMessage.Checkpoint(topic)`: a schema from a checkpoint's text to its document. A scoreboard's document
    is its events by uid; a game's is `{ entities: { plays } }`.

- [ ] **Step 1: Change the FastCast test that reads a checkpoint frame**

In `FastCast.test.ts`, `"should emit each socket text as a message frame, and an H's checkpoint after it"` expects
`{ tag: "Checkpoint", tc: "event-football-nfl", mid: 7, body: checkpointBody }`. `seen(frame)` reads `body`. Change
`seen` so a checkpoint frame shows `document`, and expect `document: checkpointDocument`, where:

```ts
const checkpointDocument = Schema.decodeSync(FastCastMessage.Checkpoint(Topic.Scoreboard({ league: "nfl" })))(
  checkpointBody
)
```

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/FastCast.test.ts -t "an H's checkpoint after it"`
Expected: FAIL (`Checkpoint` still decodes to the body struct, and the frame carries `body`).

- [ ] **Step 2: `Checkpoint(topic)` decodes to the document**

In `FastCastMessage.ts`, wrap each checkpoint schema so it decodes to the document:

```ts
/** The document a checkpoint of `topic` holds, read from its text: a scoreboard's events by uid, or a game's plays. */
export function Checkpoint(topic: Topic) {
  return Topic.$match(topic, {
    Scoreboard: () => ScoreboardCheckpoint,
    Game: () => GameCheckpoint
  })
}

/** A scoreboard topic's whole document, as a checkpoint URL serves it, read as its events by uid. */
const ScoreboardCheckpoint = Schema.fromJsonString(
  Schema.Struct({ sports: /* unchanged */ })
).pipe(
  Schema.decodeTo(Schema.Json, {
    decode: SchemaGetter.transform(
      (body): Schema.Json =>
        Object.fromEntries(
          body.sports.flatMap((sport) =>
            sport.leagues.flatMap((league) => league.events.map((event) => [event.uid, event] as const))
          )
        )
    ),
    encode: SchemaGetter.forbidden(() => "A checkpoint is never sent back")
  })
)

/** A game topic's whole document, ESPN's game package, as a checkpoint URL serves it, read as only its plays. */
const GameCheckpoint = Schema.fromJsonString(
  Schema.Struct({
    entities: Schema.optional(
      Schema.Struct({ plays: Schema.optional(Schema.Record(Schema.String, Schema.Json)) })
    )
  })
).pipe(
  Schema.decodeTo(Schema.Json, {
    decode: SchemaGetter.transform((body): Schema.Json => ({ entities: { plays: body.entities?.plays ?? {} } })),
    encode: SchemaGetter.forbidden(() => "A checkpoint is never sent back")
  })
)
```

If `Schema.decodeTo(Schema.Json, …)` does not typecheck, use `Schema.toType(Schema.Json)`, as `EspnEvent` does with
`GameSnapshot`. Keep the `sports` struct exactly as it is now.

- [ ] **Step 3: `Frame.Checkpoint` carries the document**

`Frame.ts`:

```ts
  /** The checkpoint an `H` pointed to, decoded: `topic`'s whole document as of `mid`. */
  Checkpoint: { readonly topic: Topic; readonly mid: number; readonly document: Schema.Json }
```

(`import type { Schema } from "effect"` alongside `Data` and `Option`.)

`FastCast.ts`, `checkpoint` returns the decoded document: replace the `Effect.tap(...)` with `Effect.flatMap((body) =>
Schema.decodeEffect(FastCastMessage.Checkpoint(topic))(body).pipe(Effect.mapError(...)))`. Its doc becomes "The
document of the checkpoint at `url`, decoded as `topic`'s checkpoint." `framed` builds
`Frame.Checkpoint({ topic: topic.value, mid: message.mid, document: loaded.success })`.

- [ ] **Step 4: `FastCastDocuments` syncs from the document**

```ts
function advanced(
  documents: Documents,
  frame: Data.TaggedEnum.Value<Frame, "Pushed" | "Checkpoint">
): Effect.Effect<Advanced, Schema.SchemaError> {
  return Frame.$is("Checkpoint")(frame) ? Effect.succeed(synced(documents, frame)) : moveOn(documents, frame)
}

function synced(documents: Documents, frame: Data.TaggedEnum.Value<Frame, "Checkpoint">): Advanced {
  return {
    documents: HashMap.set(documents, frame.topic, Document.Synced({ mid: frame.mid, document: frame.document })),
    change: Option.some(changeOf(frame.topic, frame.document, Option.none()))
  }
}
```

Delete `checkpoint` and the `JsonPatch` import if unused (it is still used by `applied`). In `advance`'s doc, delete
"A checkpoint that does not decode leaves its topic waiting, and asks for nothing: the live feed already followed it
again." FastCast frames no checkpoint that does not decode.

- [ ] **Step 5: Test helpers build documents**

- `EspnState.test.ts`, `checkpoint(tc, mid, document)`:

```ts
function checkpoint(tc: string, mid: number, document: unknown): Frame {
  const topic = topicNamed(tc)
  return Frame.Checkpoint({
    topic,
    mid,
    document: Schema.decodeSync(FastCastMessage.Checkpoint(topic))(JSON.stringify(document))
  })
}
```

- `EspnState.test.ts`, `recorded`: the checkpoint frame's `document` is
  `Schema.decodeSync(FastCastMessage.Checkpoint(topic.value))(checkpointBody)`.
- `TestEspn.ts`, `frameOf`: for `kind === "whole"`, decode the body with
  `yield* Schema.decodeEffect(FastCastMessage.Checkpoint(checkpointTopic))(body)` and pass it as `document`.
- `EspnState.test.ts`: delete `"should leave a topic waiting on a checkpoint that does not decode, with no reset"`.
  That behaviour moved to FastCast, whose `"should emit only the H of a checkpoint that does not decode, counting it
  as Undecodable"` covers it. `"should sync a waiting topic on the next checkpoint that decodes"` keeps its
  assertions and drops the undecodable frame from its arrange step.

- [ ] **Step 6: Run the ESPN tests**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn`
Expected: PASS.

- [ ] **Step 7: Docs, `pnpm check`, commit**

`CONTEXT.md`, the `Frame` row: "the checkpoint an `H` pointed to" becomes "the checkpoint an `H` pointed to, decoded
into its topic's document".

```bash
git add apps/hub/src/provider/espn CONTEXT.md
git commit -m "refactor: a checkpoint is decoded once, by FastCast, into its document

<per-file list of rewritten and removed tests>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: FastCast's follows are one map; checkpoints load side by side

**Files:**
- Modify: `apps/hub/src/provider/espn/FastCast.ts` (`connect`)
- Test: `apps/hub/src/provider/espn/FastCast.test.ts`

- [ ] **Step 1: Write the concurrency test**

Add a checkpoint path `/slow` to the test's `espn` client that answers after 5 seconds of test time:
`url.pathname === "/slow" ? Effect.sleep("5 seconds").pipe(Effect.as(response))`, next to the `/hang` case. Then:

```ts
  it.effect("should load a second topic's checkpoint while the first still loads", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send({ ...checkpointMessage(7), pl: "https://checkpoint.test/slow" }))
      yield* Effect.sync(() =>
        server.send({ op: "H", tc: gameTopic(firstGame), mid: 3, pl: "https://checkpoint.test/slow" })
      )
      yield* TestClock.adjust("5 seconds")

      const received = yield* frames.until(atLeast(6))
      assert.deepStrictEqual(
        received.slice(2, 6).map((frame) => frame._tag),
        ["Pushed", "Checkpoint", "Pushed", "Checkpoint"]
      )
    })
  )
```

With one checkpoint at a time, the second `H` waits 5 more seconds, so `atLeast(6)` does not arrive at 5 seconds.
The test name says what it proves. `nflFrames`, `atLeast`, `firstGame` and `gameTopic` already exist in the file. If
`nflFrames` follows only the scoreboard topic, use the helper the `"should follow a topic once it is wanted"` test
uses to follow a game topic too.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/FastCast.test.ts -t "while the first still loads"`
Expected: FAIL (times out waiting for 6 frames).

- [ ] **Step 3: Frame four texts at a time**

In `connect`, the returned stream:

```ts
  // Up to four at once, so a reconnect's checkpoints load side by side; frames still leave in the texts' order.
  return Stream.concat(Stream.make(opened), rest).pipe(
    Stream.mapEffect((text) => framed(text, answer), { concurrency: 4 }),
    Stream.flattenIterable
  )
```

Run the test: PASS.

- [ ] **Step 4: One map of follow state**

In `FastCast.ts`, below `steersBetween`:

```ts
/** Where a topic's follow is on one socket; a topic absent from the map is synced, or not followed. */
type TopicFollow = Data.TaggedEnum<{
  /** A follow sent its `S` and waits for the `H` that answers it. */
  Awaiting: { readonly answered: Deferred.Deferred<void, CheckpointUnread> }
  /** Its checkpoint kept failing: nothing follows it until the socket reconnects. */
  LeftToPolling: {}
}>
const TopicFollow = Data.taggedEnum<TopicFollow>()
```

In `connect`, replace `pending` and `gaveUp` with:

```ts
  // Each topic's follow on this socket: waiting for the `H` that answers it, or left to polling until it reconnects.
  const topics = yield* Ref.make(HashMap.empty<Topic, TopicFollow>())
```

and:

```ts
  const attempt = Effect.fnUntraced(function* (topic: Topic) {
    const answered = yield* Deferred.make<void, CheckpointUnread>()
    yield* Ref.update(topics, HashMap.set(topic, TopicFollow.Awaiting({ answered })))
    yield* Queue.offer(outgoing, JSON.stringify({ op: "S", sid, tc: tcOf(topic) }))
    yield* Deferred.await(answered)
  })
  const answer = Effect.fnUntraced(function* (topic: Topic, outcome: Exit.Exit<void, CheckpointUnread>) {
    const waiting = yield* Ref.modify(topics, (all) => {
      const awaiting = HashMap.get(all, topic).pipe(Option.filter(TopicFollow.$is("Awaiting")))
      return [awaiting, Option.isSome(awaiting) ? HashMap.remove(all, topic) : all] as const
    })
    yield* Effect.forEach(Option.toArray(waiting), ({ answered }) => Deferred.done(answered, outcome), {
      discard: true
    })
  })
  const follow = Effect.fnUntraced(function* (topic: Topic) {
    const all = yield* Ref.get(topics)
    if (Option.exists(HashMap.get(all, topic), TopicFollow.$is("LeftToPolling"))) return

    const followed = attempt(topic).pipe(
      Effect.retry(retry),
      Effect.catch((error) =>
        Effect.logWarning(
          `FastCast: ${tcOf(topic)} is left to polling until the socket reconnects; its checkpoint kept failing`,
          error
        ).pipe(
          Effect.annotateLogs({ topic: tcOf(topic) }),
          Effect.andThen(Ref.update(topics, HashMap.set(topic, TopicFollow.LeftToPolling())))
        )
      )
    )
    yield* FiberMap.run(follows, topic, followed, { onlyIfMissing: true })
  })
```

Drop the `HashSet` import if unused. The existing tests guard this step, including `"should follow a topic left to
polling again once the socket reconnects"` and `"should keep one subscription pending at a time…"`.

- [ ] **Step 5: Run the FastCast tests, `pnpm check`, commit**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/FastCast.test.ts`
Expected: PASS.

```bash
git add apps/hub/src/provider/espn/FastCast.ts apps/hub/src/provider/espn/FastCast.test.ts
git commit -m "refactor: FastCast keeps each topic's follow in one map and loads checkpoints four at a time

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: A plays push decodes only the plays it touched

**Files:**
- Modify: `apps/hub/src/provider/espn/FastCastDocuments.ts` (`DocumentChange.Game`, `moved`, `changeOf`)
- Modify: `apps/hub/src/provider/espn/EspnState.ts` (a `plays` field, the `Game` case, `playsOf`)
- Test: `apps/hub/src/provider/espn/EspnState.test.ts`

**Interfaces:**
- Produces:
  - `DocumentChange.Game: { league; game; plays: Readonly<Record<string, Schema.Json>>; touched: Option.Option<ReadonlyArray<string>> }`. `touched` lists the play ids its patches touched; none means every play (a checkpoint, or a patch of the plays whole).
  - `EspnState` field `plays: HashMap.HashMap<GameId, HashMap.HashMap<string, Play>>`, each followed game's decoded plays by entity id.

- [ ] **Step 1: Write the failing test**

In `EspnState.test.ts`, under `describe("a game's plays")`:

```ts
    it.effect("should keep a play no patch touched as it was decoded", () =>
      Effect.gen(function* () {
        const deliveries = yield* decoded([
          checkpoint(ariAtNygPlays, 99, { entities: { plays: plays("401872966237", "401872966271") } }),
          playsMessage(100, [
            { op: "replace", path: "/entities/plays/401872966271/text", value: "Corrected" }
          ])
        ])

        const [first, second] = deliveries.map(({ delivery }) =>
          Delivery.$is("Plays")(delivery) ? delivery.plays.find((play) => play.id === "401872966237") : undefined
        )
        assert.isDefined(first)
        assert.strictEqual(second, first)
      })
    )
```

Run it. Expected: FAIL (`strictEqual`, two decodes of the same entity are different instances). Check first that
`Play`'s `id` for entity `401872966237` is `"401872966237"`. If the play id is not the entity key, find the play by
`text` instead.

- [ ] **Step 2: `FastCastDocuments` says which plays it touched**

`DocumentChange.Game` gains `readonly touched: Option.Option<ReadonlyArray<string>>`. Update the type doc: "a game
topic's plays, by id, with the ids it touched (every one, when none)".

In `moved`:

```ts
  const touched = Topic.$match(topic, {
    Scoreboard: () => Option.some(Arr.dedupe(patches.map((patch) => patch.path.uid))),
    Game: () => playsTouched(patches)
  })
```

`changeOf`'s `Game` case passes it: `DocumentChange.Game({ league, game, plays: objectAt(document, tokens(gamePlays)),
touched })`. `synced` passes `Option.none()`, as it does now.

Below `relevant`:

```ts
/** The play ids `patches` touch, at their path or their `from`; none when one patches the plays whole. */
function playsTouched(
  patches: ReadonlyArray<typeof FastCastMessage.Patch.Type>
): Option.Option<ReadonlyArray<string>> {
  const pointers = patches.flatMap((patch) =>
    "from" in patch ? [patch.path.pointer, patch.from.pointer] : [patch.path.pointer]
  )
  if (pointers.includes(gamePlays)) return Option.none()

  return Option.some(Arr.dedupe(pointers.flatMap((pointer) => Option.toArray(Arr.get(tokens(pointer), 2)))))
}
```

(`tokens("/entities/plays/401/text")` is `["entities", "plays", "401", "text"]`.)

- [ ] **Step 3: `EspnState` keeps decoded plays**

Add the field (`plays: HashMap.empty()` in `empty`). The `Game` case of `pushed`:

```ts
      Game: ({ league, game, plays, touched }) =>
        Effect.map(playsAfter(advanced, game, league, plays, touched), (byId) => {
          const next = new EspnState({ ...advanced, plays: HashMap.set(advanced.plays, game, byId) })
          const list = [...HashMap.values(byId)].toSorted(Play.order)
          return [next, [Delivery.Plays({ game, plays: list })]] as const
        }),
```

Replace `playsOf` with:

```ts
/**
 * Game `game`'s plays by id after a change: each touched entity decoded again, or dropped when it is gone or does
 * not decode; every entity when nothing says which were touched.
 */
const playsAfter = Effect.fnUntraced(function* (
  state: EspnState,
  game: GameId,
  league: LeagueId,
  entities: Readonly<Record<string, Schema.Json>>,
  touched: Option.Option<ReadonlyArray<string>>
) {
  const had = Option.match(touched, {
    onNone: () => HashMap.empty<string, Play>(),
    onSome: () => Option.getOrElse(HashMap.get(state.plays, game), () => HashMap.empty<string, Play>())
  })
  const ids = Option.getOrElse(touched, () => Record.keys(entities))
  return yield* Effect.reduce(
    ids,
    () => had,
    (byId, id) =>
      Option.match(Record.get(entities, id), {
        onNone: () => Effect.succeed(HashMap.remove(byId, id)),
        onSome: (entity) =>
          Effect.map(Effect.option(decodePlay[league](entity)), (play) =>
            Option.match(play, {
              onNone: () => HashMap.remove(byId, id),
              onSome: (decoded) => HashMap.set(byId, id, decoded)
            })
          )
      })
  )
})
```

- [ ] **Step 4: Run the plays tests**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/EspnState.test.ts -t "plays"`
Expected: PASS, including the existing replace, remove, copy and move tests and the recorded NE at BUF day.

- [ ] **Step 5: `pnpm check`, commit**

```bash
git add apps/hub/src/provider/espn
git commit -m "perf: a plays push decodes only the plays it touched

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: A failed poll is a frame; the state knows what is unlisted and keeps only what is followed

**Files:**
- Modify: `apps/hub/src/provider/espn/Frame.ts`, `EspnState.ts`, `FastCastDocuments.ts`
- Test: `apps/hub/src/provider/espn/EspnState.test.ts`
- Modify: `CONTEXT.md` (the `Frame` and `ESPN state` rows)

**Interfaces:**
- Produces:
  - `Frame.PollFailed({ league: LeagueId })`.
  - `EspnState` field `unlisted: HashSet.HashSet<LeagueId>`.
  - `EspnState#retained(leagues: ReadonlyArray<LeagueId>, now: DateTime.Utc): EspnState`.
  - `FastCastDocuments#retained(kept: (topic: Topic) => boolean): FastCastDocuments`.

- [ ] **Step 1: Write the failing tests**

In `EspnState.test.ts`, a new `describe("EspnState#unlisted")`:

```ts
describe("EspnState#unlisted", () => {
  it.effect("should hold a league whose poll failed", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([Frame.PollFailed({ league: "fbs" })])

      assert.isTrue(HashSet.has(state.unlisted, "fbs"))
    })
  )

  it.effect("should hold a league whose scoreboard did not decode", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([poll("fbs", "not json")])

      assert.isTrue(HashSet.has(state.unlisted, "fbs"))
    })
  )

  it.effect("should let go of a league once its poll lists", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([Frame.PollFailed({ league: "nfl" }), poll("nfl", scoreboardBody)])

      assert.isFalse(HashSet.has(state.unlisted, "nfl"))
    })
  )
})
```

and a new `describe("EspnState#retained")`:

```ts
describe("EspnState#retained", () => {
  it.effect("should drop the document of a topic no longer wanted", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([
        poll("nfl", scoreboardBody),
        checkpoint(ariAtNygPlays, 99, { entities: { plays: plays("401872966237") } })
      ])
      const longAfter = DateTime.makeUnsafe("2026-10-05T12:00:00Z")

      const kept = state.retained(["nfl"], longAfter)

      assert.isFalse(HashMap.has(kept.documents.byTopic, topicNamed(ariAtNygPlays)))
      assert.isFalse(HashMap.has(kept.plays, GameId.make("401872966")))
    })
  )

  it.effect("should keep the document of a topic still wanted", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([...synced()])
      const duringTheGames = DateTime.makeUnsafe("2026-10-04T18:00:00Z")

      const kept = state.retained(["nfl"], duringTheGames)

      assert.isTrue(kept.documents.isSynced(topicNamed("event-football-nfl")))
    })
  )
})
```

The first test's "long after" time works only if ARI at NYG is over, or not live, in the 18:00Z scoreboard by then.
At 12:00Z the next day, a game the scoreboard shows live at 18:00Z is still "live" by its status, and `wanted` would
keep it. If so, use a scoreboard where the game is final: `neAtBufFinal` on BUF at NE's topic
`"gp-football-nfl-401872971"` after `synced()`.

Run them. Expected: FAIL (no `PollFailed`, `unlisted`, `retained`).

- [ ] **Step 2: `PollFailed`**

`Frame.ts`:

```ts
  /** A poll that brought nothing: it did not connect, or was refused. */
  PollFailed: { readonly league: LeagueId }
```

- [ ] **Step 3: `unlisted` in `EspnState`**

- Field `readonly unlisted: HashSet.HashSet<LeagueId>`, `HashSet.empty()` in `empty`.
- `taken`'s match gains `PollFailed: ({ league }) => Effect.succeed([unlistedBy(state, league), noDeliveries] as const)`.
- `listed` sets `unlisted: HashSet.remove(state.unlisted, league)` on its next state.
- `taken`'s catch returns `[Frame.$is("Polled")(frame) ? unlistedBy(state, frame.league) : state, noDeliveries]`.
- Below `taken`:

```ts
/** `state` with `league` unlisted: its last poll brought nothing it could list. */
function unlistedBy(state: EspnState, league: LeagueId): EspnState {
  return new EspnState({ ...state, unlisted: HashSet.add(state.unlisted, league) })
}
```

- `annotationsOf` gains `PollFailed: ({ league }) => ({ frame: "PollFailed", league })`.
- The doc of `take` adds: "A failed poll, or one whose scoreboard does not decode, leaves its league unlisted until
  a poll of it lists."

- [ ] **Step 4: `retained`**

`FastCastDocuments`:

```ts
  /** These documents, keeping only the topics `kept` says. */
  retained(kept: (topic: Topic) => boolean): FastCastDocuments {
    return new FastCastDocuments({ byTopic: HashMap.filter(this.byTopic, (_, topic) => kept(topic)) })
  }
```

`EspnState`, after `wanted`:

```ts
  /** This state keeping documents and decoded plays only for the topics wanted at `now`. */
  retained(leagues: ReadonlyArray<LeagueId>, now: DateTime.Utc): EspnState {
    const wanted = this.wanted(leagues, now)
    const games = new Set(
      [...HashMap.keys(wanted)].flatMap((topic) => (Topic.$is("Game")(topic) ? [topic.game] : []))
    )
    return new EspnState({
      ...this,
      documents: this.documents.retained((topic) => HashMap.has(wanted, topic)),
      plays: HashMap.filter(this.plays, (_, game) => games.has(game))
    })
  }
```

Check `HashMap.filter`'s callback argument order in `apps/hub/node_modules/effect/dist/HashMap.d.ts`.

- [ ] **Step 5: Run the file**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/EspnState.test.ts`
Expected: PASS.

- [ ] **Step 6: Docs, `pnpm check`, commit**

- `CONTEXT.md`, `Frame` row: add "a poll that brought nothing (`PollFailed`, its league)".
- `CONTEXT.md`, `ESPN state` row: add "and which leagues' last poll listed nothing".

```bash
git add apps/hub/src/provider/espn CONTEXT.md
git commit -m "feat: a failed poll is a frame; ESPN's state knows unlisted leagues and keeps only what is followed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: One fold; each league polls by its own games

`EspnProvider.ts` is rewritten. The existing `EspnProvider.test.ts` tests guard it, except where they read the
cadence of both leagues as one, or the `pollEveryLeague` span.

**Files:**
- Modify: `apps/hub/src/provider/espn/EspnProvider.ts`
- Test: `apps/hub/src/provider/espn/EspnProvider.test.ts`
- Modify: `telemetry/dashboards/hub.json` ("Poll traces" query), `docs/technical-spec.md` (lines 295, 335)

**Interfaces:**
- Consumes: `Frame.PollFailed`, `EspnState#unlisted`, `EspnState#listing`, `EspnState#retained`.
- Produces: `EspnProvider.layer` with the same type as now.

- [ ] **Step 1: Make `polledOver` per league**

`polledOver` returns the instants of every league's polls deduped together. Make it return each league's polls:
`Partial<Record<LeagueId, ReadonlyArray<number>>>`. Drop the frame counting (`framesOfPoll`, the `frames` queue): run
`provider.deliveries` with `Stream.runDrain` forked, as `toldOver` does, then `TestClock.adjust(0)` and each span with
`TestClock.adjust`. Group `requests` by league, deduping each league's instants. Each existing single-league test then
reads `polled.fbs` (or `polled.nfl`) where it read `polled`, with the same expected values.

The two tests that read both leagues as one change behaviour:
- `"should poll every 10 seconds after a league fails during a live game"` (NFL live, FBS down) becomes two tests:

```ts
  it.effect("should poll a league with a live game every 10 seconds while the other league fails", () =>
    Effect.gen(function* () {
      const live = scoreboardOf([{ state: "in", period: 2 }])

      const polled = yield* polledOver(["10 seconds", "10 seconds", "10 seconds"], { nfl: live, fbs: down })

      assert.deepStrictEqual(polled.nfl, [0, 10_000, 20_000, 30_000])
    })
  )

  it.effect("should poll a failing league again within 30 seconds while the other has a live game", () =>
    Effect.gen(function* () {
      const live = scoreboardOf([{ state: "in", period: 2 }])

      const polled = yield* polledOver(["10 seconds", "10 seconds", "10 seconds"], { nfl: live, fbs: down })

      assert.deepStrictEqual(polled.fbs, [0, 30_000])
    })
  )
```

Add the spec's new behaviour:

```ts
  it.effect("should poll a league with no live game every 15 minutes while the other league's game is live", () =>
    Effect.gen(function* () {
      const live = scoreboardOf([{ state: "in", period: 2 }])
      const later = scoreboardOf([{ state: "pre", period: 0, kickoff: "2026-10-03T20:00Z" }])

      const polled = yield* polledOver(["10 seconds", "15 minutes"], { nfl: live, fbs: later })

      assert.deepStrictEqual(polled.fbs, [0, 900_000])
    })
  )
```

(`scoreboardOf` lists games as the file's other tests do; check how it spells a kickoff.)

- [ ] **Step 2: Rewrite the span and duration tests**

- `"should make a poll of every league one span, with each league's poll inside it"` becomes
  `"should make each league's poll its own span, named for its league"`. It asserts two `EspnProvider.poll` spans with
  `sportal.league` `nfl` and `fbs`. The `sportal.leagues` / `sportal.failed_leagues` assertions go with the
  `pollEveryLeague` span.
- `"should record each poll's duration"` asserts the timer by league:
  `yield* observed("sportal_poll_duration", { league: "fbs" })` is `2` (`observed` is in `TestTelemetry.ts`).
- `"should deliver no frame for a league that fails"` becomes `"should deliver no deliveries for a league that
  fails"`: the failed poll is now a frame with an empty array of deliveries. Assert that the arrays are empty.

Add:

```ts
  it.effect("should deliver a push that arrives during a slow poll before the poll's frame", () =>
    Effect.gen(function* () {
      const slow = HttpClient.make((request) =>
        Effect.sleep("5 seconds").pipe(Effect.as(answered(request, nflPregame)))
      )
      // A heartbeat: a push that says nothing, so its frame is an empty array of deliveries.
      const heartbeat = Frame.Pushed({ topic: Option.none(), mid: Option.none(), body: JSON.stringify({ op: "B" }) })
      const pushing = Stream.fromEffect(Effect.as(Effect.sleep("1 second"), heartbeat))

      const frames = yield* Effect.gen(function* () {
        const provider = yield* Provider
        const taken = yield* provider.deliveries.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
        yield* TestClock.adjust("5 seconds")
        return yield* Fiber.join(taken)
      }).pipe(Effect.provide(espnOver(slow, { leagues: "nfl", pushing })), Effect.scoped)

      assert.deepStrictEqual(
        frames.map((deliveries) => deliveries.map(({ _tag }) => _tag)),
        [[], ["Listing"]]
      )
    })
  )
```

The push's empty array comes first, the poll's `Listing` second.

- [ ] **Step 3: Run the provider tests to see the new ones fail**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/EspnProvider.test.ts`
Expected: the new per-league tests FAIL; the rest PASS or fail only on `polled.fbs` shape until Step 4.

- [ ] **Step 4: Rewrite `EspnProvider.ts`**

```ts
/**
 * ESPN as the provider: the site scoreboard of each league `HubConfig` names, polled, and FastCast pushing, every frame
 * folded, in the order it arrives, into one `EspnState` by one fold. Each league polls on its own, waiting after each
 * poll by its own listed games: 10 seconds while one is live, a minute within 30 minutes of a kickoff, and 15 minutes
 * otherwise; at most 30 seconds while its last poll failed or did not decode. A poll that does not connect is
 * `Unreachable` for its league, and one answered with a status other than 2xx `Refused`; either is logged and counted,
 * and is a `PollFailed` frame. It tells FastCast to follow every league's scoreboard topic and each listed game live or
 * within 30 minutes of kickoff, and keeps no document of a topic it no longer follows. Each run of `deliveries` polls
 * and follows on its own.
 */
export const layer: Layer.Layer<Provider, never, FastCast | HttpClient.HttpClient | HubConfig> = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const { leagues } = yield* HubConfig
    const http = yield* HttpClient.HttpClient
    const fastCast = yield* FastCast
    const client = http.pipe(HttpClient.filterStatusOk)

    const poll = Effect.fn("EspnProvider.poll")(
      function* (league: LeagueId) {
        yield* Effect.annotateCurrentSpan("sportal.league", league)
        const response = yield* client.get(scoreboardUrl(league))
        const body = yield* response.text

        return Frame.Polled({ league, body })
      },
      (effect, league) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderUnavailable({
                reason: Predicate.isTagged(cause.reason, "StatusCodeError") ? "Refused" : "Unreachable",
                league,
                cause
              })
          ),
          Effect.tapError((error) =>
            Effect.logWarning(
              "EspnProvider: a poll failed; keeping the last good listing for this league, if any",
              error
            ).pipe(Effect.andThen(Metric.update(Metric.withAttributes(providerErrors, { league }), 1)))
          ),
          Effect.catch(() => Effect.succeed(Frame.PollFailed({ league }))),
          Effect.trackDuration(Metric.withAttributes(pollDuration, { league }))
        )
    )

    const deliveries = Stream.unwrap(
      Effect.gen(function* () {
        // What the fold last took, for `wanted` to read; only the fold sets it.
        const view = yield* SubscriptionRef.make(EspnState.empty)
        // When each league polls next; only the fold sets it, once it has taken that league's poll.
        const pollAt = new Map(
          yield* Effect.forEach(leagues, (league) =>
            Effect.map(SubscriptionRef.make(Option.none<DateTime.Utc>()), (at) => [league, at] as const)
          )
        )

        const pollsOf = (league: LeagueId, at: SubscriptionRef.SubscriptionRef<Option.Option<DateTime.Utc>>) =>
          SubscriptionRef.changes(at).pipe(
            Stream.switchMap((next) => Stream.fromEffect(Effect.andThen(sleepUntil(next), poll(league))))
          )
        const polls = Stream.mergeAll(
          [...pollAt].map(([league, at]) => pollsOf(league, at)),
          { concurrency: "unbounded" }
        )
        const pushes = fastCast.follow(wantedOf(view, leagues))

        const takeFrame = Effect.fnUntraced(function* (state: EspnState, frame: Frame) {
          const [taken, said] = yield* state.take(frame)
          const now = yield* DateTime.now

          const polled = pollLeagueOf(frame)
          const next = Option.isSome(polled) ? taken.retained(leagues, now) : taken
          yield* SubscriptionRef.set(view, next)
          yield* Effect.forEach(
            Option.toArray(polled),
            (league) =>
              Effect.forEach(Option.toArray(Option.fromUndefinedOr(pollAt.get(league))), (at) =>
                SubscriptionRef.set(at, Option.some(DateTime.addDuration(now, interval(next, league, now))))
              ),
            { discard: true }
          )
          return [next, [said]] as const
        })

        return Stream.merge(polls, pushes).pipe(Stream.mapAccumEffect(() => EspnState.empty, takeFrame))
      })
    )

    return Provider.of({ deliveries })
  })
)
```

Below it, in first-use order:

```ts
/** The site scoreboard of `league` the Hub polls: today's games, every FBS game for college. */
function scoreboardUrl(league: LeagueId): string { /* unchanged */ }

/** Sleeps until `at`, or not at all when there is none yet or it has passed. */
function sleepUntil(at: Option.Option<DateTime.Utc>): Effect.Effect<void> {
  return Option.match(at, {
    onNone: () => Effect.void,
    onSome: (when) => Effect.flatMap(DateTime.now, (now) => Effect.sleep(DateTime.distance(now, when)))
  })
}

/**
 * What FastCast follows, read from `view` again on each change and once a minute from the last state seen, so a
 * kickoff coming into its window is followed with no frame to say so.
 */
function wantedOf(
  view: SubscriptionRef.SubscriptionRef<EspnState>,
  leagues: ReadonlyArray<LeagueId>
): Stream.Stream<Wanted> {
  return Stream.merge(
    SubscriptionRef.changes(view).pipe(Stream.map(Option.some)),
    Stream.tick("1 minute").pipe(Stream.as(Option.none<EspnState>()))
  ).pipe(
    Stream.mapAccum(
      (): Option.Option<EspnState> => Option.none(),
      (last, seen) => {
        const current = Option.orElse(seen, () => last)
        return [current, Option.toArray(current)] as const
      }
    ),
    Stream.mapEffect((current) => Effect.map(DateTime.now, (now) => current.wanted(leagues, now))),
    Stream.changes
  )
}

/** The league a poll's frame is of; none for a push. */
function pollLeagueOf(frame: Frame): Option.Option<LeagueId> {
  return Frame.$match(frame, {
    Polled: ({ league }) => Option.some(league),
    PollFailed: ({ league }) => Option.some(league),
    Pushed: () => Option.none(),
    Checkpoint: () => Option.none()
  })
}

/**
 * How long `league` waits before its next poll, by its own listed games. While its last poll failed or did not
 * decode, the wait is capped at 30 seconds so its scoreboard is read again soon; a live game still polls every 10
 * seconds. Reads only each game's progress and kickoff, so any league polls by it.
 */
function interval(state: EspnState, league: LeagueId, now: DateTime.Utc): Duration.Duration {
  const games = state.listing(league)
  const normal = games.some((game) => game.progress() === "live")
    ? Duration.seconds(10)
    : games.some((game) => game.isLiveOrKicksOffWithin(GameSnapshot.kickoffWindow, now))
      ? Duration.minutes(1)
      : Duration.minutes(15)
  return HashSet.has(state.unlisted, league) ? Duration.min(normal, Duration.seconds(30)) : normal
}
```

Metrics stay at the end. `pollDuration`'s description becomes "How long one league's poll takes, by league".
Imports: drop `Queue` and `Schedule`, add `HashSet`, `Wanted` (type, from `./FastCast.ts`). `Frame.Polled` is the
only frame `poll` builds; `Frame.PollFailed` is the caught one.

`Effect.fn`'s second argument receives `(effect, league)`; its pipe both maps the error and catches it, so the
`EspnProvider.poll` span still records the failure before it becomes a frame. If `Effect.trackDuration` inside the
`Effect.fn` pipeline measures only the inner effect and not the span, that is fine: it is the poll's duration either
way.

- [ ] **Step 5: Run the provider tests**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/EspnProvider.test.ts`
Expected: PASS. `"should give each run of its deliveries every frame"`, `"should deliver FastCast's frames beside its
polls"` and the `wanted` tests guard the fold. If `"should deliver a push taken between two leagues' polls after the
first league's listing"` fails because the leagues now poll side by side, make its arrange step poll the two leagues
in order through their answers' timing (FBS answering 1 second later), and keep its assertion.

- [ ] **Step 6: Dashboard and docs**

- `telemetry/dashboards/hub.json:891`, the "Poll traces" query: `name="EspnProvider.pollEveryLeague"` becomes
  `name="EspnProvider.poll"`.
- `docs/technical-spec.md:295`: the cadence sentence becomes "ESPN's cadence is `EspnProvider`'s: each league waits
  after its poll by its own listed games, as its last poll showed them and each push since (a push behind its listed
  game is logged and counted): about every 10 seconds while one is live, every minute near kickoff, every 15 minutes
  otherwise, at most 30 seconds while its last poll failed or did not decode." Keep whatever follows in the line.
- `docs/technical-spec.md:335`: "ESPN polls about every 10 seconds while any game is live" becomes "each league polls
  about every 10 seconds while one of its games is live".

- [ ] **Step 7: `pnpm check`, commit**

```bash
git add apps/hub/src/provider/espn telemetry/dashboards/hub.json docs/technical-spec.md
git commit -m "refactor: ESPN's provider is one fold over each league's polls and FastCast's frames

No queue, lock or drained merge; each league polls by its own games.

<per-file list of rewritten and removed tests>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The live stream is built once

**Files:**
- Modify: `apps/hub/src/HubServer.ts` (`layer`, `liveRoute`, `published`)
- Modify: `packages/domain/src/Guide.ts` (`availabilityOf`, `airs`)
- Test: `apps/hub/src/HubServer.test.ts`

- [ ] **Step 1: Write the failing test**

In `HubServer.test.ts`, beside the existing `/api/live` tests, using their harness (`serverUnderTest`, and the helper
that reads the first N SSE `data:` lines; reuse whichever the existing live tests use):

```ts
  it.effect("should publish a burst of slate changes once it settles, as one message", () =>
    Effect.gen(function* () {
      const { feed, live } = yield* serverUnderTest
      const reading = yield* Effect.forkScoped(live.messages(2))
      yield* feed.deliver([listingOf([upcoming(one)])])

      yield* feed.deliver([listingOf([live(one, "15:00")])])
      yield* feed.deliver([listingOf([live(one, "14:00")])])
      yield* TestClock.adjust("250 millis")

      const messages = yield* Fiber.join(reading)
      assert.lengthOf(messages, 2)
    })
  )
```

Adapt the names to the file's harness. The assertion is that two deliveries inside one 250 ms window give one
message after the first. This passes today as well (the debounce already merges them), so it is a guard for the
move, not a red test. The red test is the next one:

```ts
  it.effect("should give two connections the same messages", () =>
    Effect.gen(function* () {
      const { feed, live } = yield* serverUnderTest
      const first = yield* Effect.forkScoped(live.messages(2))
      const second = yield* Effect.forkScoped(live.messages(2))

      yield* feed.deliver([listingOf([upcoming(one)])])
      yield* TestClock.adjust("250 millis")

      assert.deepStrictEqual(yield* Fiber.join(first), yield* Fiber.join(second))
    })
  )
```

This also passes today. The sharing is checked by a count instead: wrap the test `Source` layer's `availability` in
`Stream.tap` counting pulls into a `Ref`, open two connections, and assert the count is that of one connection. If
the harness makes that awkward, keep the two guard tests and rely on review for the sharing.

- [ ] **Step 2: Share one encoded stream**

In `HubServer.ts`, `layer` builds the events once:

```ts
> = Layer.unwrap(
  Effect.gen(function* () {
    const { webRoot } = yield* HubConfig
    const events = yield* liveEvents
    const api = /* unchanged */
    const web = /* unchanged */
    return HttpRouter.serve(Layer.mergeAll(api, liveRoute(events), web))
  })
)
```

`Layer.unwrap` gives the effect a scope that lasts as long as the layer. Check its type: if it does not exclude
`Scope`, use `Layer.unwrapScoped` (or the Effect 4 spelling of it in `Layer.d.ts`).

```ts
/**
 * GET /api/live — the current slate, each game beside its availability, then every change to either, as server-sent
 * events, with a comment every 20 seconds so proxies that close idle connections leave a quiet stream open. Every
 * connection reads the one `events` stream.
 */
function liveRoute(events: Stream.Stream<string>) {
  return HttpRouter.add(
    "GET",
    "/api/live",
    Effect.sync(() => {
      // `tick` emits once at the start; only the later ticks are wanted.
      const keepAlive = Stream.tick("20 seconds").pipe(
        Stream.drop(1),
        Stream.map(() => ": keep-alive\n\n")
      )
      return HttpServerResponse.stream(Stream.merge(events, keepAlive).pipe(Stream.encodeText), {
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" }
      })
    })
  )
}

/**
 * The live stream's events, built once for every connection: the slate, each game beside its availability as of when
 * it is sent, first as it is, then once each burst of changes to the slate or the availability settles, unless what
 * it sends is the same; each as an SSE `data:` line. A connection joining gets the last one at once.
 */
const liveEvents = Effect.gen(function* () {
  const director = yield* Director
  const source = yield* Source
  const encode = Schema.encodeEffect(LiveMessageJson)

  return yield* settled(Stream.zipLatest(director.slate, source.availability)).pipe(
    Stream.mapEffect(([slate, availabilityOf]) =>
      Effect.map(DateTime.now, (now) => slate.published((game) => availabilityOf(game, now)))
    ),
    Stream.changesWith(samePublished),
    Stream.mapEffect((message) => Effect.map(encode(message), (json) => `data: ${json}\n\n`)),
    Stream.share({ capacity: "unbounded", replay: 1 })
  )
})
```

Delete `published`. `settled` and `samePublished` stay.

- [ ] **Step 3: The guide builds each game's window once**

In `Guide.ts`, `availabilityOf` builds the window and passes it:

```ts
    const nearKickoff = {
      minimum: DateTime.subtractDuration(game.kickoff, kickoffTolerance),
      maximum: DateTime.addDuration(game.kickoff, kickoffTolerance)
    }
    const matches = this.airings.filter((airing) => this.airs(airing, game, now, nearKickoff))
```

and `airs(airing, game, now, nearKickoff: { readonly minimum: DateTime.Utc; readonly maximum: DateTime.Utc })` reads
`DateTime.between(airing.begin, nearKickoff)`. Behaviour does not change; `Guide.test.ts` guards it.

- [ ] **Step 4: Run, `pnpm check`, commit**

Run: `pnpm --filter @sportal/hub exec vitest run src/HubServer.test.ts && pnpm --filter @sportal/domain exec vitest run src/Guide.test.ts`
Expected: PASS.

```bash
git add apps/hub/src/HubServer.ts apps/hub/src/HubServer.test.ts packages/domain/src/Guide.ts
git commit -m "perf: one live stream for every connection, debounced before the slate is published

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: A delisted game's series goes

**Files:**
- Modify: `apps/hub/src/Director.ts`
- Test: `apps/hub/src/Director.test.ts`
- Modify: `CONTEXT.md` (the `Director` row), `docs/technical-spec.md` (line 310), `docs/adr/0012-no-persistence-one-take.md` is history and stays

- [ ] **Step 1: Rewrite the delisting test**

`"should gauge a game no listing names any more as 0"` becomes:

```ts
  it.effect("should drop the series of a game no listing names any more", () =>
    Effect.gen(function* () {
      yield* listing([liveSnapshot({ id: one }), liveSnapshot({ id: two })])

      yield* listing([liveSnapshot({ id: two })])
      const value = yield* gauged("sportal_game_state", { game: one })

      assert.isUndefined(value)
    }).pipe(Effect.provide(directorOver), withMetrics)
  )
```

Run it: FAIL (`expected 0 to be undefined`).

- [ ] **Step 2: Remove the series**

In `Director.ts`, `observed`'s `Delisted` case becomes `Delisted: ({ game }) => forgotten(game.snapshot)`, and below
`gauge`:

```ts
/** Removes `snapshot`'s game's series of `sportal_game_state`, so a game no listing names is not exported again. */
function forgotten(snapshot: GameSnapshot) {
  return Effect.map(Metric.MetricRegistry, (registry) =>
    [...registry]
      .filter(([, metadata]) => metadata.id === gameState.id && metadata.attributes?.["game"] === snapshot.id)
      .forEach(([key]) => {
        registry.delete(key)
      })
  )
}
```

`gameState`'s description: "A game's progress, by game: 1 upcoming, 2 live, 3 over; no series once no listing
names it". The doc of `observed`: "a game's progress gauged (its series removed once delisted)". Also update the
`Metric.Metadata` field names if `id`/`attributes` differ in `Metric.d.ts` (checked: `id`, `attributes`).

- [ ] **Step 3: Run, docs, `pnpm check`, commit**

Run: `pnpm --filter @sportal/hub exec vitest run src/Director.test.ts`
Expected: PASS.

- `CONTEXT.md`, `Director` row: "gauges each game's progress (`sportal_game_state`)" gains "and drops a delisted
  game's series".
- `docs/technical-spec.md:310`: wherever it says a delisted game gauges 0, say its series is removed.

```bash
git add apps/hub/src/Director.ts apps/hub/src/Director.test.ts CONTEXT.md docs/technical-spec.md
git commit -m "fix: a delisted game's sportal_game_state series is removed, not kept at 0

Director.test.ts: 'should gauge a game no listing names any more as 0' became
'should drop the series of a game no listing names any more'.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Game-day checklist

**Files:**
- Modify: `docs/game-day-checklist.md`

- [ ] **Step 1: Add rows**

After the dashboard rows (around row 38), add:

| # | Step | Expected |
|---|---|---|
| 54 | On an NFL-only window, watch "Poll traces" for a few minutes | NFL polls every 10 s while a game is live; FBS every 15 minutes |
| 55 | After a game ends and leaves its kickoff window, check the Games panel and the matchup variable | The game's row is gone within a few minutes (Prometheus staleness) |
| 56 | Reconnect FastCast (cut the network briefly) with several games live | Their checkpoints load together: "Checkpoint duration" shows them overlapping, and plays resume for every game within one checkpoint's time |

Number them after the checklist's last row.

- [ ] **Step 2: Commit**

```bash
git add docs/game-day-checklist.md
git commit -m "docs: game-day checks for per-league polling, dropped series, and side-by-side checkpoints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
