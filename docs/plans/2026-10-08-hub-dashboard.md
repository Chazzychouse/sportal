# Hub dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give FastCast four metrics that show whether push is flowing, log each new play with its game, and rebuild `telemetry/dashboards/hub.json` so
that every panel has data. Dead panels go.

**Architecture:** The metrics are private consts at the end of `apps/hub/src/provider/espn/FastCast.ts`, updated at
the points that already handle each event: `framed` for every socket text, the `mapAccumEffect` tap and `steer` for
topics, and `checkpoint` for loads. The dashboard is plain provisioned JSON, read by the local LGTM container.

**Tech Stack:** Effect 4 `Metric`, `@effect/vitest` with `TestClock`, Grafana 13 dashboard JSON (schemaVersion 41),
PromQL / LogQL / TraceQL.

Spec: `docs/specs/2026-10-08-hub-dashboard-design.md` (approved).

## Global Constraints

- Work in the worktree `/home/chazzy/development/projects/sportal-dashboard`, on branch `dashboard`. Never touch
  `../sportal-twitch-source`.
- New metric ids, exactly: `sportal_live_feed_received` (counter, attributes `op` and, when the topic has an owner,
  `league`), `sportal_live_feed_topics` (gauge), `sportal_live_feed_steers` (counter, attribute `steer`),
  `sportal_checkpoint_duration` (timer).
- A metric is a private const at the end of its file, named for what it measures, with a `description`; counters take
  `incremental: true`, as the existing four in `FastCast.ts` do.
- Follow `AGENTS.md`: each `yield*` on its own line, bound to its own `const`; no `_tag ===`; no casts; the tests follow
  "should …" naming with Arrange, Act and Assert separated by blank lines, and no `// Arrange` comments.
- Comments only where the why is unclear. The new consts get a `description`, not a comment.
- `pnpm check` must pass before every commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Files

| File | Change |
|---|---|
| `apps/hub/src/provider/espn/FastCast.ts` | four metric consts, and their updates |
| `apps/hub/src/provider/espn/FastCast.test.ts` | six tests, one behaviour each |
| `apps/hub/src/TestTelemetry.ts` | `observed(id)`: a timer's sample count |
| `docs/technical-spec.md` | §5.2 and §5.6 name FastCast's metrics |
| `packages/domain/src/Game.ts` (+ test) | `Game#playsAfter` |
| `apps/hub/src/Director.ts` (+ test) | one Info log per new play |
| `CONTEXT.md` | the Director row mentions the play log |
| `telemetry/dashboards/hub.json` | rewritten |

---

### Task 0: Worktree setup

- [ ] **Step 1: Install**

Run: `cd /home/chazzy/development/projects/sportal-dashboard && pnpm install`
Expected: completes. It also patches `tsc` with `@effect/tsgo`.

- [ ] **Step 2: Baseline**

Run: `pnpm check`
Expected: PASS. If it fails on `main`'s own code, stop and report; do not fix unrelated failures.

---

### Task 1: Count socket texts, followed topics and steers

**Files:**
- Modify: `apps/hub/src/provider/espn/FastCast.ts` (`connect`, `framed`, the metric consts at the end)
- Modify: `apps/hub/src/provider/espn/FastCast.test.ts` (new tests after "should leave a game's topic when its
  scoreboard shows it final"; import `gauged`)
- Modify: `docs/technical-spec.md` §5.2 (the FastCast bullet) and §5.6 (the "Live feed refused…" row)

**Interfaces:**
- Produces: these Prometheus series (OTLP adds the suffixes): `sportal_live_feed_received_total{op,league}`,
  `sportal_live_feed_topics_ratio`, and `sportal_live_feed_steers_total{steer}`. Task 3 reads them.

- [ ] **Step 1: Write the failing tests**

In `FastCast.test.ts`, change the import to:

```ts
import { counted, gauged, recordingLogs, withMetrics } from "../../TestTelemetry.ts"
```

Then add these tests inside `describe("FastCast", …)`, after "should leave a game's topic when its scoreboard shows it
final":

```ts
  it.effect("should count each socket text by its op and its topic's league", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send(patchMessage(8)))

      yield* frames.until(numbered(8))
      const patches = yield* counted("sportal_live_feed_received", { op: "P", league: "nfl" })
      assert.strictEqual(patches, 1)
    }).pipe(withMetrics)
  )

  it.effect("should count a socket text of an unknown op as unknown", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send({ op: "X" }))

      yield* frames.until(atLeast(3))
      const unknown = yield* counted("sportal_live_feed_received", { op: "unknown" })
      assert.strictEqual(unknown, 1)
    }).pipe(withMetrics)
  )

  it.effect("should gauge one topic followed once a game's scoreboard shows it live", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send(scoreboardShowing(1, firstGame)))

      yield* server.sent.until(subscribed(gameTopic(firstGame), 1))
      const topics = yield* gauged("sportal_live_feed_topics")
      assert.strictEqual(topics, 1)
    }).pipe(withMetrics)
  )

  it.effect("should gauge no topic followed once the followed game's scoreboard shows it final", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(scoreboardShowing(1, firstGame)))
      yield* server.sent.until(subscribed(gameTopic(firstGame), 1))

      yield* Effect.sync(() => server.send(patchMessage(2, [stateOf(firstGame, "post")])))

      yield* frames.until(numbered(2))
      const topics = yield* gauged("sportal_live_feed_topics")
      const leaves = yield* counted("sportal_live_feed_steers", { steer: "Leave" })
      assert.strictEqual(topics, 0)
      assert.strictEqual(leaves, 1)
    }).pipe(withMetrics)
  )

  it.effect("should count a topic followed again after its document reset", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(scoreboardShowing(7)))
      yield* frames.until(wholeAt(7))

      yield* Effect.sync(() => server.send(patchMessage(9)))

      yield* server.sent.until(subscribed("event-football-nfl", 2))
      const followedAgain = yield* counted("sportal_live_feed_steers", { steer: "FollowAgain" })
      assert.strictEqual(followedAgain, 1)
    }).pipe(withMetrics)
  )
```

The fourth test checks two values (the gauge and the Leave count) because both come from one Leave. "should gauge one
topic followed…" covers Follow, so no separate Follow-count test is needed.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/FastCast.test.ts -t "should count each socket text|unknown op|should gauge|reset"`
Expected: all five FAIL, each with `expected undefined to equal …`, because the metrics do not exist yet.

- [ ] **Step 3: Implement**

In `FastCast.ts`:

(a) In `connect`, replace the `steer` const with a counting wrapper around the existing match:

```ts
  const steerTo = Steer.$match({
    Follow: ({ tc }) => Effect.logInfo(`FastCast: subscribed to ${tc}`).pipe(Effect.andThen(follow(tc))),
    Leave: ({ tc }) =>
      Effect.logInfo(`FastCast: left ${tc}; its scoreboard shows it neither live nor about to kick off`).pipe(
        Effect.andThen(FiberMap.remove(follows, tc))
      ),
    FollowAgain: ({ tc, detail }) =>
      Effect.logWarning(`FastCast: ${tc} lost its document (${detail}); following it again`).pipe(
        Effect.andThen(follow(tc))
      )
  })
  const steer = (one: Steer) =>
    Metric.update(Metric.withAttributes(steersTaken, { steer: one._tag }), 1).pipe(Effect.andThen(steerTo(one)))
```

(b) Reset the topics gauge with the connected one. Replace

```ts
  yield* Effect.addFinalizer(() => Metric.update(connected, 0))
```

with

```ts
  yield* Effect.addFinalizer(() =>
    Metric.update(connected, 0).pipe(Effect.andThen(Metric.update(topicsFollowed, 0)))
  )
```

(c) In the returned stream's `mapAccumEffect`, gauge what is followed before steering. Replace

```ts
          Effect.tap(([, steers]) => Effect.forEach(steers, steer, { discard: true })),
```

with

```ts
          Effect.tap(([next, steers]) =>
            Metric.update(topicsFollowed, next.followed.length).pipe(
              Effect.andThen(Effect.forEach(steers, steer, { discard: true }))
            )
          ),
```

(d) In `framed`, count every text, and use the same `league` for the checkpoint failure. The top of `framed` becomes:

```ts
  const { text, receivedAt } = received
  const envelope = Option.getOrUndefined(decodeEnvelope(text))
  const league = Option.fromUndefinedOr(envelope?.channel).pipe(
    Option.flatMap(ownerOf),
    Option.map((owner) => owner.league)
  )
  const op = envelope?.message.op ?? "unknown"
  yield* Metric.update(Metric.withAttributes(textsReceived, { op, ...Record.getSomes({ league }) }), 1)
  const frame = new Frame({
```

Further down, the checkpoint-failure update becomes:

```ts
  yield* Metric.update(Metric.withAttributes(checkpointFailures, Record.getSomes({ league })), 1)
```

Update the doc comment of `framed`, so that its last clause reads: "…a checkpoint that fails is logged and counted, and
only its `H` is framed. Every text is counted by its op."

(e) Add these at the end of the file, after `liveFeedErrors`:

```ts
const textsReceived = Metric.counter("sportal_live_feed_received", {
  description: "FastCast socket texts, by op (unknown when it does not decode) and, when its topic has one, league",
  incremental: true
})

const topicsFollowed = Metric.gauge("sportal_live_feed_topics", {
  description: "Game topics the live feed follows, beside each league's scoreboard; 0 while it is not subscribed"
})

const steersTaken = Metric.counter("sportal_live_feed_steers", {
  description: "Times the live feed followed a game topic, left one, or followed one again after its document reset",
  incremental: true
})
```

(f) Docs. In `docs/technical-spec.md` §5.2, the bullet "A FastCast topic that loses its document…" gains: "…from its
checkpoint, counted as a `FollowAgain` on `sportal_live_feed_steers`. FastCast also counts every socket text by op and
league (`sportal_live_feed_received`) and gauges the game topics it follows (`sportal_live_feed_topics`)."

In the §5.6 "Live feed refused, closed, silent, or out of step" row, change "Logged and counted by reason" to "Logged
and counted by reason (`sportal_live_feed_errors`)".

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/FastCast.test.ts`
Expected: every FastCast test passes, old and new. That includes "should fail a checkpoint that hangs for 20 s as
Unloaded, counting it…", which proves the shared `league` still labels checkpoint failures.

- [ ] **Step 5: Check and commit**

Run: `pnpm check` (expected: PASS), then:

```bash
git add apps/hub/src/provider/espn/FastCast.ts apps/hub/src/provider/espn/FastCast.test.ts docs/technical-spec.md
git commit -m "feat(espn): count FastCast's texts by op, and gauge and count what it follows

The dashboard could not tell a socket that delivers from one that only stays open,
nor see the game topics followed, left, or followed again after a reset.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Time each checkpoint

**Files:**
- Modify: `apps/hub/src/TestTelemetry.ts` (`observed`, after `gauged`)
- Modify: `apps/hub/src/provider/espn/FastCast.ts` (`checkpoint`; the const at the end)
- Modify: `apps/hub/src/provider/espn/FastCast.test.ts` (one test after "should emit each socket text as a message
  frame, and an H's checkpoint after it"; import `observed`)
- Modify: `docs/technical-spec.md` §5.2

**Interfaces:**
- Produces: `sportal_checkpoint_duration_milliseconds_bucket` (the same shape as the existing
  `sportal_poll_duration_milliseconds_*`), read by Task 3.

- [ ] **Step 1: Add the test helper**

In `TestTelemetry.ts`, after `gauged`:

```ts
/** The number of samples histogram or timer `id` with `attributes` among its others has recorded, if any. */
export function observed(id: string, attributes: Readonly<Record<string, string>> = {}) {
  return Effect.map(metricOf(id, attributes), (metric) =>
    metric?.type === "Histogram" ? metric.state.count : undefined
  )
}
```

- [ ] **Step 2: Write the failing test**

Import `observed` beside `counted` and `gauged`, then add:

```ts
  it.effect("should time a checkpoint it loads", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* Effect.sync(() => server.send(checkpointMessage(7)))

      yield* frames.until(wholeAt(7))
      const timed = yield* observed("sportal_checkpoint_duration")
      assert.strictEqual(timed, 1)
    }).pipe(withMetrics)
  )
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/FastCast.test.ts -t "should time a checkpoint"`
Expected: FAIL, `expected undefined to equal 1`.

- [ ] **Step 4: Implement**

In `checkpoint`, add the timer as the last step of its pipe, so that it covers both the load and the decode:

```ts
        onSome: (owner) =>
          Schema.decodeEffect(FastCastMessage.Checkpoint(owner))(body).pipe(
            Effect.mapError(
              (cause) => new CheckpointUnread({ topic: envelope.tc, reason: "Undecodable", cause })
            )
          )
      })
    ),
    Effect.trackDuration(checkpointDuration)
  )
```

At the end of the file, after `steersTaken`:

```ts
const checkpointDuration = Metric.timer("sportal_checkpoint_duration", {
  description: "How long a FastCast checkpoint took to load and decode, whether or not it succeeded"
})
```

If `Metric.timer`'s options type does not accept `description`, copy the shape `pollDuration` uses in
`EspnProvider.ts:178`.

In `docs/technical-spec.md` §5.2, after the sentence Task 1 added, add: "Each checkpoint's load and decode is timed
(`sportal_checkpoint_duration`)."

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/FastCast.test.ts`
Expected: all pass. The checkpoint tests that use the test clock still pass, because `trackDuration` reads `Clock`.

- [ ] **Step 6: Check and commit**

Run: `pnpm check` (expected: PASS), then:

```bash
git add apps/hub/src/TestTelemetry.ts apps/hub/src/provider/espn/FastCast.ts apps/hub/src/provider/espn/FastCast.test.ts docs/technical-spec.md
git commit -m "feat(espn): time FastCast's checkpoints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Log each new play

**Files:**
- Modify: `packages/domain/src/Game.ts` (`Game#playsAfter`, after `playsTaken`)
- Modify: `packages/domain/src/Game.test.ts` (`describe("Game#playsAfter")`)
- Modify: `apps/hub/src/Director.ts` (`take`; a private `loggedNewPlays` below `gaugeChanged`)
- Modify: `apps/hub/src/Director.test.ts` (`describe("Director's play log")`, after "Director's game state gauge")
- Modify: `CONTEXT.md` (the Director row: "…and gauges each game's progress (`sportal_game_state`)" gains ", and logs
  each play a take adds"), and `docs/technical-spec.md` §5.2 (the Director bullet gains the same clause)

**Interfaces:**
- Produces: `Game#playsAfter(earlier: Game): ReadonlyArray<Play>`. Each play is an Info log
  `Director: <matchup> Q<period> <clock> <text>`, annotated with `game`, `league`, `matchup`, `play` (its `_tag`) and
  `scoring` (a boolean). Task 4's Plays panels filter on `play`, `matchup` and `scoring`.

- [ ] **Step 1: Write the failing domain tests**

In `packages/domain/src/Game.test.ts`, after the last `describe`:

```ts
describe("Game#playsAfter", () => {
  it("should give the plays the earlier game lacks, in order", () => {
    const first = play({ id: PlayId.make("1"), sequence: 1 })
    const second = play({ id: PlayId.make("2"), sequence: 2 })
    const third = play({ id: PlayId.make("3"), sequence: 3 })
    const earlier = Game.of(snapshot()).playsTaken([first])
    const later = earlier.playsTaken([third, first, second])

    const added = later.playsAfter(earlier)

    assert.deepStrictEqual(
      added.map(({ id }) => id),
      [second.id, third.id]
    )
  })

  it("should not give a play the earlier game had, though the feed corrected its text", () => {
    const first = play({ id: PlayId.make("1"), sequence: 1, text: "Rush for 1 yard" })
    const corrected = play({ id: PlayId.make("1"), sequence: 1, text: "Rush for 2 yards" })
    const earlier = Game.of(snapshot()).playsTaken([first])
    const later = earlier.playsTaken([corrected])

    const added = later.playsAfter(earlier)

    assert.deepStrictEqual(added, [])
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @sportal/domain exec vitest run src/Game.test.ts -t "Game#playsAfter"`
Expected: FAIL, because `playsAfter` is not a function (and the typecheck flags it too).

- [ ] **Step 3: Implement `playsAfter`**

In `Game.ts`, after `playsTaken`:

```ts
  /** The plays this game has that `earlier` lacks, by id, in this game's order. */
  playsAfter(earlier: Game): ReadonlyArray<Play> {
    const had = new Set(earlier.plays.map(({ id }) => id))
    return this.plays.filter(({ id }) => !had.has(id))
  }
```

Run the Step 2 command again. Expected: PASS.

- [ ] **Step 4: Write the failing Director test**

In `apps/hub/src/Director.test.ts`, add `PlayId` to the type-only `Play` import, so that it reads
`import { type Play, PlayId } from "@sportal/domain/Play"`. Then, after `describe("Director's game state gauge", …)`:

```ts
describe("Director's play log", () => {
  it.effect("should log each play a take adds once, annotated with its game", () => {
    const { logs, layer } = recordingLogs()
    const game = liveSnapshot({ id: one })
    const first = play({ id: PlayId.make("p1"), sequence: 1, text: "Rush for 1 yard" })
    const second = play({ id: PlayId.make("p2"), sequence: 2, clock: "14:20", text: "Rush for 4 yards" })
    return Effect.gen(function* () {
      yield* listing([game])
      yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [first] }))

      yield* delivered(Delivery.cases.Plays.make({ game: one, plays: [first, second] }))

      const played = logs.filter(({ annotations }) => annotations.play !== undefined)
      assert.deepStrictEqual(
        played.map(({ level, annotations }) => ({ level, game: annotations.game, play: annotations.play })),
        [
          { level: "Info", game: one, play: "Rush" },
          { level: "Info", game: one, play: "Rush" }
        ]
      )
      assert.include(played[1]?.message ?? "", `Director: ${game.matchup()} Q1 14:20 Rush for 4 yards`)
    }).pipe(Effect.provide(directed.pipe(Layer.provideMerge(layer))))
  })
})
```

This is one behaviour: each play is logged once, with its game. The second take re-sends `first`, and the
two-entry list proves it is not logged twice.

- [ ] **Step 5: Run it to see it fail**

Run: `pnpm --filter @sportal/hub exec vitest run src/Director.test.ts -t "play log"`
Expected: FAIL, because `played` is `[]`.

- [ ] **Step 6: Implement the log**

In `Director.ts`, change `import type { Game, GameId, GameSnapshot } from "@sportal/domain/Game"` to
`import { Game, type GameId, type GameSnapshot } from "@sportal/domain/Game"`, and add
`import type { Play } from "@sportal/domain/Play"`. In `take`, after `yield* gaugeChanged(before, next)`:

```ts
          yield* loggedNewPlays(before, next)
```

Below `gaugeChanged` (and its helpers `gauge` and `byId`, which stay where they are), add:

```ts
/** An Info log of each play `next` has that `before` lacked, annotated with its game; a game new to the slate had none. */
const loggedNewPlays = Effect.fnUntraced(function* (before: Slate, next: Slate) {
  if (next.games === before.games) return

  const had = byId(before.games)
  const changed = next.games.filter((game) => had.get(game.snapshot.id) !== game)
  yield* Effect.forEach(
    changed,
    (game) => {
      const earlier = had.get(game.snapshot.id) ?? Game.of(game.snapshot)
      return Effect.forEach(game.playsAfter(earlier), (play) => loggedPlay(game.snapshot, play), { discard: true })
    },
    { discard: true }
  )
})

function loggedPlay(snapshot: GameSnapshot, play: Play) {
  const matchup = snapshot.matchup()
  return Effect.logInfo(`Director: ${matchup} Q${play.period} ${play.clock} ${play.text}`).pipe(
    Effect.annotateLogs({
      game: snapshot.id,
      league: snapshot.league,
      matchup,
      play: play._tag,
      scoring: play.scoring
    })
  )
}
```

Update the `Director.layer` doc comment: "…gauging each game a take changed by its progress, and logging each play it
adds."

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @sportal/hub exec vitest run src/Director.test.ts`
Expected: all pass, including "should take NE at BUF's recorded day to its final… logging no error" (the play logs
are Info, not Error).

- [ ] **Step 8: Docs, check, commit**

Make the `CONTEXT.md` and `technical-spec.md` edits listed under Files. Run `pnpm check` (expected: PASS), then:

```bash
git add packages/domain/src/Game.ts packages/domain/src/Game.test.ts apps/hub/src/Director.ts apps/hub/src/Director.test.ts CONTEXT.md docs/technical-spec.md
git commit -m "feat(hub): log each play a take adds, annotated with its game

So the dashboard can show what happened in each game, not only its progress.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Rebuild the Hub dashboard

**Files:**
- Modify (rewrite): `telemetry/dashboards/hub.json`

**Interfaces:**
- Consumes: the series from Tasks 1 and 2; the play logs from Task 3 (annotations `play`, `matchup`, `scoring`); and the existing `sportal_game_state_ratio`,
  `sportal_live_feed_connected_ratio`, `sportal_live_feed_errors_total`,
  `sportal_live_feed_checkpoint_failures_total`, `sportal_poll_duration_milliseconds_*` and
  `sportal_provider_errors_total`.

Keep the top-level keys exactly as they are: `uid "sportal-hub"`, `title "Hub"`, `schemaVersion 41`, `time` now-30m,
`refresh "30s"` and empty `links`. `templating.list` holds a single variable:
`{ "name": "matchup", "label": "Game", "type": "query", "datasource": { "type": "prometheus", "uid": "prometheus" },
"query": { "qryType": 1, "query": "label_values(sportal_game_state_ratio, matchup)", "refId": "PrometheusVariableQueryEditor-VariableQuery" },
"definition": "label_values(sportal_game_state_ratio, matchup)", "refresh": 2, "multi": true, "includeAll": true,
"allValue": ".*", "current": { "text": "All", "value": "$__all" }, "sort": 1 }`. Datasource refs are `{ "type": "prometheus", "uid": "prometheus" }`,
`{ "type": "loki", "uid": "loki" }` and `{ "type": "tempo", "uid": "tempo" }`, set at the panel level, as the current
file does. Panel `id`s are unique integers. The Games panel (id 27) is copied verbatim, with only its `gridPos.y`
changed.

- [ ] **Step 1: Write the panels**

Panels in order. `gridPos` is `x, y, w, h`. Every stat has `"options": { "reduceOptions": { "calcs": ["lastNotNull"] },
"colorMode": "background", "graphMode": "none" }`.

**Top stats (y 0, h 4, w 4 each)**

| id | x | Title | Query (refId A) | Display |
|---|---|---|---|---|
| 13 | 0 | Connected | `max(sportal_live_feed_connected_ratio) + 2 * (1 - (max(sportal_game_state_ratio == bool 2) or vector(0)))` | value mappings: 0 → "No" red; 1 → "Yes" green; 2 → "No · no game live" text color; 3 → "Yes" green. `noValue` "Hub down" |
| 30 | 4 | Game topics followed | `max(sportal_live_feed_topics_ratio)` | thresholds: base text color; `noValue` "—" |
| 31 | 8 | Push messages / min | `(sum(increase(sportal_live_feed_received_total{op=~"P\|R"}[1m])) or vector(0)) and on() max(sportal_game_state_ratio == 2)` | thresholds: base red, green at 1; `noValue` "no game live" |
| 32 | 12 | Polls / min | `sum(increase(sportal_poll_duration_milliseconds_count[1m])) or vector(0)` | thresholds: base red, green at 0.01 |
| 33 | 16 | Feed failures in range | `(sum(increase(sportal_live_feed_errors_total[$__range])) or vector(0)) + (sum(increase(sportal_live_feed_checkpoint_failures_total[$__range])) or vector(0))` | thresholds: base green, orange at 1; `decimals` 0 |
| 34 | 20 | Provider errors in range | `sum(increase(sportal_provider_errors_total[$__range])) or vector(0)` | thresholds: base green, orange at 1; `decimals` 0 |

In JSON the `\|` above is a plain `|`; the backslash is only there for the Markdown table. Connected encodes "a game is
live" as +2, so a single stat can be red only when the socket is down during a game.

**Games (y 4)**: id 27, `{x 0, y 4, w 24, h 10}`, verbatim.

**Row "Plays"**: id 50, `type "row"`, `collapsed false`, `{x 0, y 14, w 24, h 1}`, `panels []`.

| id | gridPos | type | Title | Targets |
|---|---|---|---|---|
| 51 | 0,15,16,10 | logs | Plays | A `{service_name="sportal-hub"} \| play=~".+" \| matchup=~"$matchup"`; options as panel 17 |
| 52 | 16,15,8,10 | logs | Scoring plays | A `{service_name="sportal-hub"} \| play=~".+" \| matchup=~"$matchup" \| scoring="true"`; options as panel 17 |

The rows below start at y 25.

**Row "Live feed"**: id 12, `type "row"`, `collapsed false`, `{x 0, y 25, w 24, h 1}`, `panels []`.

| id | gridPos | type | Title | Targets |
|---|---|---|---|---|
| 35 | 0,26,12,8 | timeseries | Messages by op (/min) | A `sum by (op) (rate(sportal_live_feed_received_total[$__rate_interval])) * 60`, legend `{{op}}`; `custom.stacking.mode "normal"`, `fillOpacity 30` |
| 36 | 12,26,12,8 | timeseries | Patches by league (/min) | A `sum by (league) (rate(sportal_live_feed_received_total{op=~"P\|R"}[$__rate_interval])) * 60`, legend `{{league}}` |
| 37 | 0,34,8,8 | timeseries | Topics followed and steers | A `max(sportal_live_feed_topics_ratio)`, legend `followed`; B `sum by (steer) (increase(sportal_live_feed_steers_total[$__rate_interval]))`, legend `{{steer}}`. Override `byFrameRefID` B: `custom.drawStyle "bars"`, `custom.fillOpacity 80`, `custom.axisPlacement "right"`, `custom.axisLabel "steers"` |
| 38 | 8,34,8,8 | timeseries | Checkpoint duration | A `histogram_quantile(0.5, sum by (le) (rate(sportal_checkpoint_duration_milliseconds_bucket[$__rate_interval])))`, legend `p50`; B the same at `0.95`, legend `p95`; C `sum(increase(sportal_live_feed_checkpoint_failures_total[$__rate_interval]))`, legend `failures`. Defaults `unit "ms"`. Override `byFrameRefID` C: `custom.drawStyle "points"`, `custom.pointSize 8`, `custom.axisPlacement "right"`, `unit "short"`, `color { mode "fixed", fixedColor "red" }` |
| 15 | 16,34,8,8 | timeseries | Feed errors by reason | A `sum by (reason) (increase(sportal_live_feed_errors_total[$__rate_interval])) or vector(0)`, legend `{{reason}}`; bars, stacked, `fillOpacity 80` (as today) |
| 17 | 0,42,24,10 | logs | FastCast logs | A `{service_name="sportal-hub"} \|= "FastCast"`; options `sortOrder "Descending"`, `showTime true` |

**Row "Poll"**: id 40, `{x 0, y 52, w 24, h 1}`, `collapsed false`, `panels []`.

| id | gridPos | type | Title | Targets |
|---|---|---|---|---|
| 3 | 0,53,12,8 | timeseries | Poll duration | the current panel 3, verbatim except `gridPos` |
| 4 | 12,53,12,8 | timeseries | Provider errors by league | the current panel 4, with its expr followed by ` or vector(0)` |
| 5 | 0,61,24,8 | table | Poll traces | A `{resource.service.name="sportal-hub" && name="EspnProvider.pollEveryLeague"}`, `queryType "traceql"`, `limit 20` |
| 41 | 0,69,24,8 | logs | Provider logs | A `{service_name="sportal-hub"} \|~ "EspnProvider\|EspnDecoder"`; options as panel 17 |

**Row "Hub"**: id 42, `{x 0, y 77, w 24, h 1}`, `collapsed true`. Its `panels` holds the current panels 1 (Hub log
volume by level) and 2 (Recent warnings and errors), verbatim except `gridPos.y` 78. Because the row is collapsed,
they are not repeated in the top-level `panels`.

**Removed:** panels 18 (Connects in range), 25 (Checkpoint failures; now inside 33 and 38) and 26 (Take traces).

- [ ] **Step 2: Validate the JSON and every query**

Run: `python3 -m json.tool telemetry/dashboards/hub.json > /dev/null && echo ok`
Expected: `ok`.

With `pnpm telemetry` up, run every Prometheus expression through the API and check that none is rejected:

```bash
python3 - <<'EOF'
import json, subprocess, urllib.parse
d = json.load(open("telemetry/dashboards/hub.json"))
panels = d["panels"] + [p for r in d["panels"] if r.get("type") == "row" for p in r.get("panels", [])]
for p in panels:
    if p.get("datasource", {}).get("uid") != "prometheus":
        continue
    for t in p["targets"]:
        q = t["expr"].replace("$__rate_interval", "1m").replace("$__range", "30m")
        url = "http://localhost:3000/api/datasources/proxy/uid/prometheus/api/v1/query?query=" + urllib.parse.quote(q)
        out = json.loads(subprocess.run(["curl", "-s", "-u", "admin:admin", url], capture_output=True, text=True).stdout)
        print(out["status"], p["title"], t["refId"], len(out["data"]["result"]) if out["status"] == "success" else out.get("error"))
EOF
```

Expected: every line starts with `success`. Results may be 0 for the new series until a Hub on this branch runs.

- [ ] **Step 3: See it load in Grafana**

The file provider re-reads within about 10 s. Run:

`curl -s -u admin:admin localhost:3000/api/dashboards/uid/sportal-hub | python3 -c "import json,sys; d=json.load(sys.stdin)['dashboard']; print(len(d['panels']), [p['title'] for p in d['panels']])"`

Expected: the new titles, in order. If the old ones still show, run
`docker compose -f telemetry/compose.yaml restart lgtm` and check again.

- [ ] **Step 4: Check and commit**

Run: `pnpm check` (expected: PASS; its format check may cover the JSON, so run `pnpm format` first if it flags it),
then:

```bash
git add telemetry/dashboards/hub.json
git commit -m "feat(telemetry): Hub dashboard shows FastCast; dead panels go

Poll and take traces filtered on a mode that no longer exists. Take traces goes
(one tiny span per frame); poll traces works again. A top row says at a glance
whether the feed is up and pushing while a game is live. The live feed row reads
the new message, topic, steer and checkpoint metrics. Hub logs fold away at the
bottom.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Live check (with the user)

Not a subagent task.

- [ ] **Step 1:** In the worktree, run `pnpm --filter @sportal/hub dev` during a live game (TNF tonight, 2026-10-08).
- [ ] **Step 2:** Open `localhost:3000` → Sportal → Hub. Confirm that:
  - Connected reads Yes in green;
  - Game topics followed is ≥ 1;
  - Push messages / min is above 0;
  - Messages by op shows `P` and `B`;
  - Topics followed shows at least one Follow bar;
  - Checkpoint duration has a p50;
  - Poll traces lists traces;
  - Plays shows play lines, and the Game picker narrows them to one game.
- [ ] **Step 3:** Report any empty panel. A rename from OTLP is the likeliest cause, for example a gauge exported
  without `_ratio`. Check the actual name with
  `curl -s -u admin:admin localhost:3000/api/datasources/proxy/uid/prometheus/api/v1/label/__name__/values | grep live_feed`,
  fix the panel, and amend with its own commit.
- [ ] **Step 4:** `plannotator review` on the branch, then merge as the user decides.
