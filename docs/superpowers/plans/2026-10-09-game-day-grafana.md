# Game-day Grafana Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a game-day overview and per-game drill-down to Grafana, backed by stable current-game metrics and the Hub's existing structured play logs.

**Architecture:** `Director` gauges the latest accepted values for each listed game and removes every series when the game is delisted. `Telemetry` exports one Hub-presence gauge. Two new provisioned dashboards read Prometheus for current state and Loki for plays; the existing Hub dashboard becomes operations-only.

**Tech Stack:** Effect 4 metrics and test clock, Vitest with `@effect/vitest`, Grafana 13 provisioned JSON, PromQL, LogQL, Prometheus, Loki, OTLP/HTTP.

Spec: `docs/superpowers/specs/2026-10-09-game-day-grafana-design.md`

---

## File map

| File | Responsibility |
| --- | --- |
| `apps/hub/src/Director.ts` | Update and remove current-game gauges when slate changes are observed. |
| `apps/hub/src/Director.test.ts` | Prove gauge values, stable attributes, status mapping, timestamps, and delisting. |
| `apps/hub/src/Telemetry.ts` | Register the Hub-presence gauge for the lifetime of the telemetry layer. |
| `apps/hub/src/Telemetry.test.ts` | Prove the presence gauge is 1 while the layer is active and 0 after graceful finalization. |
| `telemetry/dashboards/game-day.json` | All-games summary, table, and repeated recent-play panels. |
| `telemetry/dashboards/game-detail.json` | Selected-game summary, complete/scoring plays, and diagnostics. |
| `telemetry/dashboards/hub.json` | Operations-only FastCast, polling, provider, and Hub panels. |
| `CONTEXT.md` | Keep the Director glossary row aligned with the metrics it emits. |
| `docs/technical-spec.md` | Document the current-game telemetry and dashboard split. |

No package, source folder, exported type, domain schema, or API payload is added.

## Global constraints

- Execute in a dedicated worktree created with the `using-git-worktrees` skill.
- Before editing Effect code, retain the current Effect 4 patterns from `node_modules/.pnpm/effect@4.0.0/node_modules/effect/AGENTS.md` and `ai-docs/src/index.md`; do not substitute older Effect APIs.
- Metric ids are exactly: `sportal_hub_up`, `sportal_game_status`, `sportal_game_score`, `sportal_game_period`, `sportal_game_clock`, `sportal_game_kickoff`, and `sportal_game_updated_at`.
- Every game metric uses `game`, `league`, and `matchup`. Only `sportal_game_score` additionally uses `side` and `team`.
- Score, status, period, clock, kickoff, and update time are values, never attributes.
- Grafana reads Effect gauges through their observed Prometheus names, expected to end in `_ratio`; confirm the names through the Prometheus label API before finalizing queries.
- Keep `sportal_game_state`'s existing 1/2/3 values unchanged.
- Keep every existing test assertion. Add tests rather than weakening or replacing behavior.
- Run `pnpm check` before every commit.

### Task 1: Gauge Hub presence for the telemetry layer lifetime

**Files:**
- Modify: `apps/hub/src/Telemetry.ts`
- Modify: `apps/hub/src/Telemetry.test.ts`

- [ ] **Step 1: Write the failing lifecycle test**

Add `Metric` to the Effect import and import `gauged` from `TestTelemetry.ts`. Add this test inside `describe("Telemetry", ...)`:

```ts
it.effect("should gauge the Hub as up while telemetry is active and down after its graceful stop", () =>
  Effect.gen(function* () {
    const registry: Metric.MetricRegistry = new Map()
    const active = yield* Layer.build(telemetryWithoutCollector({})).pipe(
      Effect.andThen(gauged("sportal_hub_up")),
      Effect.scoped,
      Effect.provideService(Metric.MetricRegistry, registry)
    )

    const stopped = yield* gauged("sportal_hub_up").pipe(
      Effect.provideService(Metric.MetricRegistry, registry)
    )

    assert.strictEqual(active, 1)
    assert.strictEqual(stopped, 0)
  })
)
```

The imports become:

```ts
import { Array as Arr, Effect, Layer, Metric, Ref, References, Schema } from "effect"
import { gauged, recordingLogs } from "./TestTelemetry.ts"
```

- [ ] **Step 2: Run the test and verify red**

Run:

```bash
pnpm --filter @sportal/hub exec vitest run src/Telemetry.test.ts -t "gauge the Hub"
```

Expected: FAIL because `sportal_hub_up` does not exist, so `active` and `stopped` are `undefined`.

- [ ] **Step 3: Register and finalize the gauge**

Add `Metric` to `Telemetry.ts`'s Effect import. Merge a no-service lifecycle layer with the existing configured telemetry layer:

```ts
export const layer: Layer.Layer<
  never,
  PlatformError.PlatformError,
  HubConfig | HttpClient.HttpClient | Crypto.Crypto
> = Layer.merge(
  Layer.unwrap(
    Effect.gen(function* () {
      const { logLevel, logFormat, otlpUrl, version } = yield* HubConfig
      const console = Layer.mergeAll(
        Layer.succeed(References.MinimumLogLevel, logLevel),
        logFormat === "json" ? Logger.layer([Logger.consoleJson]) : Layer.empty
      )
      if (Option.isNone(otlpUrl)) return console

      const warnOnce = yield* Effect.cached(
        Effect.logWarning(`Telemetry cannot reach the collector at ${otlpUrl.value.href}`)
      )
      const httpClient = yield* HttpClient.HttpClient
      const client = HttpClient.tapError(httpClient, () => warnOnce)
      const crypto = yield* Crypto.Crypto
      const instanceId = yield* crypto.randomUUIDv4
      return Otlp.layerJson({
        baseUrl: otlpUrl.value.href,
        resource: {
          serviceName: "sportal-hub",
          serviceVersion: version,
          attributes: { "service.instance.id": instanceId }
        },
        shutdownTimeout: "1 second"
      }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)), Layer.provideMerge(console))
    })
  ),
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Metric.update(hubUp, 1)
      yield* Effect.addFinalizer(() => Metric.update(hubUp, 0))
    })
  )
)
```

Keep the existing explanatory comments in the configured branch. Add the metric at the end of the file:

```ts
const hubUp = Metric.gauge("sportal_hub_up", {
  description: "Whether this Hub's telemetry layer is active: 1 while active, 0 after a graceful stop"
})
```

- [ ] **Step 4: Run the focused and full Telemetry tests**

Run:

```bash
pnpm --filter @sportal/hub exec vitest run src/Telemetry.test.ts
```

Expected: all Telemetry tests pass, including export-without-collector and shutdown flushing.

- [ ] **Step 5: Check and commit**

Run:

```bash
pnpm check
git add apps/hub/src/Telemetry.ts apps/hub/src/Telemetry.test.ts
git commit -m "feat(telemetry): gauge Hub presence"
```

Expected: `pnpm check` passes and the commit contains only the two Telemetry files.

### Task 2: Gauge every listed game's current values

**Files:**
- Modify: `apps/hub/src/Director.ts`
- Modify: `apps/hub/src/Director.test.ts`

- [ ] **Step 1: Write the failing current-value test**

Add `team` to the TestGame import and retain the existing imports. Add this test under `describe("Director's game state gauge", ...)` after the existing live-game test:

```ts
it.effect("should gauge a progressed game's status, period, clock, kickoff, update time, and scores", () =>
  Effect.gen(function* () {
    const acceptedAt = DateTime.makeUnsafe("2026-10-09T20:00:00Z")
    const kickoff = DateTime.makeUnsafe("2026-10-09T17:00:00Z")
    const game = liveSnapshot({
      id: one,
      status: "halftime",
      period: 2,
      clock: "0:00",
      kickoff,
      away: { team: team("BUF"), score: 17 },
      home: { team: team("NE"), score: 14 }
    })
    yield* TestClock.setTime(DateTime.toEpochMillis(acceptedAt))

    yield* listing([game])
    const status = yield* gauged("sportal_game_status", { game: one })
    const period = yield* gauged("sportal_game_period", { game: one })
    const clock = yield* gauged("sportal_game_clock", { game: one })
    const measuredKickoff = yield* gauged("sportal_game_kickoff", { game: one })
    const updatedAt = yield* gauged("sportal_game_updated_at", { game: one })
    const away = yield* gauged("sportal_game_score", {
      game: one,
      side: "away",
      team: "BUF"
    })
    const home = yield* gauged("sportal_game_score", {
      game: one,
      side: "home",
      team: "NE"
    })

    assert.strictEqual(status, 3)
    assert.strictEqual(period, 2)
    assert.strictEqual(clock, 0)
    assert.strictEqual(measuredKickoff, DateTime.toEpochSeconds(kickoff))
    assert.strictEqual(updatedAt, DateTime.toEpochSeconds(acceptedAt))
    assert.strictEqual(away, 17)
    assert.strictEqual(home, 14)
  }).pipe(Effect.provide(directorOver), withMetrics)
)
```

The import changes are:

```ts
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { liveSnapshot, play, snapshot, team } from "@sportal/domain/TestGame"
```

- [ ] **Step 2: Write the failing exhaustive status test**

Add one parameterized behavior below the current-value test:

```ts
it.effect.each([
  ["scheduled", 1],
  ["live", 2],
  ["halftime", 3],
  ["delayed", 4],
  ["final", 5],
  ["postponed", 6],
  ["canceled", 7]
] as const)("should gauge %s status as %d", ([status, expected]) =>
  Effect.gen(function* () {
    yield* listing([snapshot({ id: one, status })])

    const value = yield* gauged("sportal_game_status", { game: one })

    assert.strictEqual(value, expected)
  }).pipe(Effect.provide(directorOver), withMetrics)
)
```

- [ ] **Step 3: Run the new tests and verify red**

Run:

```bash
pnpm --filter @sportal/hub exec vitest run src/Director.test.ts -t "progressed game's status|gauge .* status"
```

Expected: FAIL because the six new metric ids have no samples.

- [ ] **Step 4: Implement the current-value gauges**

In `Director.ts`, import `DateTime`, import `GameStatus` as a type, and replace the current `gauge` helper with an Effect function that records one accepted snapshot coherently:

```ts
import type { GameSnapshot, GameStatus, Progress } from "@sportal/domain/Game"
import { Cause, Context, DateTime, Effect, Layer, Metric, Stream, SubscriptionRef } from "effect"
```

Update `observed` to call `gaugeGame`:

```ts
function observed(change: SlateChange) {
  return SlateChange.$match(change, {
    Progressed: ({ game }) => gaugeGame(game.snapshot, progressValues[game.snapshot.progress()]),
    Delisted: ({ game }) => forgotten(game.snapshot),
    Played: ({ game, play }) => loggedPlay(game.snapshot, play)
  })
}
```

Add this immediately below `observed`:

```ts
const gaugeGame = Effect.fnUntraced(function* (snapshot: GameSnapshot, progress: number) {
  const now = yield* DateTime.now
  const attributes = { game: snapshot.id, league: snapshot.league, matchup: snapshot.matchup() }
  const away = { ...attributes, side: "away", team: snapshot.away.team.abbreviation }
  const home = { ...attributes, side: "home", team: snapshot.home.team.abbreviation }

  yield* Metric.update(Metric.withAttributes(gameState, attributes), progress)
  yield* Metric.update(Metric.withAttributes(gameStatus, attributes), statusValues[snapshot.status])
  yield* Metric.update(Metric.withAttributes(gameScore, away), snapshot.away.score)
  yield* Metric.update(Metric.withAttributes(gameScore, home), snapshot.home.score)
  yield* Metric.update(Metric.withAttributes(gamePeriod, attributes), snapshot.period)
  yield* Metric.update(Metric.withAttributes(gameClock, attributes), snapshot.secondsLeft())
  yield* Metric.update(Metric.withAttributes(gameKickoff, attributes), DateTime.toEpochSeconds(snapshot.kickoff))
  yield* Metric.update(Metric.withAttributes(gameUpdatedAt, attributes), DateTime.toEpochSeconds(now))
})
```

At the end of the file, keep `progressValues` and add the exhaustive status mapping before the metric declarations:

```ts
const statusValues = {
  scheduled: 1,
  live: 2,
  halftime: 3,
  delayed: 4,
  final: 5,
  postponed: 6,
  canceled: 7
} satisfies Record<GameStatus, number>
```

Add the metrics after `gameState`:

```ts
const gameStatus = Metric.gauge("sportal_game_status", {
  description: "A listed game's status: 1 scheduled, 2 live, 3 halftime, 4 delayed, 5 final, 6 postponed, 7 canceled"
})

const gameScore = Metric.gauge("sportal_game_score", {
  description: "A listed game's points by away or home side and team abbreviation"
})

const gamePeriod = Metric.gauge("sportal_game_period", {
  description: "A listed game's current period"
})

const gameClock = Metric.gauge("sportal_game_clock", {
  description: "A listed game's seconds remaining in its current period"
})

const gameKickoff = Metric.gauge("sportal_game_kickoff", {
  description: "A listed game's kickoff in Unix seconds"
})

const gameUpdatedAt = Metric.gauge("sportal_game_updated_at", {
  description: "When the Director accepted a listed game's snapshot, in Unix seconds"
})
```

- [ ] **Step 5: Run the focused tests and verify green**

Run:

```bash
pnpm --filter @sportal/hub exec vitest run src/Director.test.ts -t "game state gauge"
```

Expected: every game-state gauge test passes.

- [ ] **Step 6: Write the failing stable-series and delisting tests**

Add these two behaviors in the same describe block without removing the existing game-state delisting test:

```ts
it.effect("should update current values without creating series from changing values", () =>
  Effect.gen(function* () {
    const first = liveSnapshot({
      id: one,
      away: { team: team("BUF"), score: 7 },
      home: { team: team("NE"), score: 3 }
    })
    const second = liveSnapshot({
      id: one,
      clock: "8:00",
      away: { team: team("BUF"), score: 14 },
      home: { team: team("NE"), score: 3 }
    })
    yield* listing([first])

    yield* takenSnapshot(second)
    const metrics = yield* Metric.snapshot
    const scores = metrics.filter(
      (metric) => metric.id === "sportal_game_score" && metric.attributes?.game === one
    )
    const clocks = metrics.filter(
      (metric) => metric.id === "sportal_game_clock" && metric.attributes?.game === one
    )

    const clock = yield* gauged("sportal_game_clock", { game: one })
    const away = yield* gauged("sportal_game_score", {
      game: one,
      side: "away",
      team: "BUF"
    })

    assert.strictEqual(scores.length, 2)
    assert.strictEqual(clocks.length, 1)
    assert.strictEqual(clock, 480)
    assert.strictEqual(away, 14)
  }).pipe(Effect.provide(directorOver), withMetrics)
)

it.effect("should drop every current-value series of a game no listing names", () =>
  Effect.gen(function* () {
    yield* listing([liveSnapshot({ id: one }), liveSnapshot({ id: two })])

    yield* listing([liveSnapshot({ id: two })])
    const metrics = yield* Metric.snapshot
    const forgotten = metrics.filter(({ attributes }) => attributes?.game === one)

    assert.deepStrictEqual(forgotten, [])
  }).pipe(Effect.provide(directorOver), withMetrics)
)
```

- [ ] **Step 7: Run the two tests and verify the delisting test fails**

Run:

```bash
pnpm --filter @sportal/hub exec vitest run src/Director.test.ts -t "without creating series|every current-value series"
```

Expected: the stable-series test passes; the delisting test fails because only `sportal_game_state` is removed.

- [ ] **Step 8: Remove all of a delisted game's current gauges**

Replace `forgotten` with:

```ts
/** Removes `snapshot`'s game's current metric series, so a game no listing names is not exported again. */
function forgotten(snapshot: GameSnapshot) {
  return Effect.map(Metric.MetricRegistry, (registry) =>
    [...registry]
      .filter(
        ([, metadata]) =>
          currentGameMetrics.has(metadata.id) && metadata.attributes?.game === snapshot.id
      )
      .forEach(([key]) => {
        registry.delete(key)
      })
  )
}
```

After all game metric declarations, add:

```ts
const currentGameMetrics = new Set([
  gameState.id,
  gameStatus.id,
  gameScore.id,
  gamePeriod.id,
  gameClock.id,
  gameKickoff.id,
  gameUpdatedAt.id
])
```

This also resolves the existing Biome suggestion about `attributes?.["game"]`.

- [ ] **Step 9: Run Director tests, check, and commit**

Run:

```bash
pnpm --filter @sportal/hub exec vitest run src/Director.test.ts
pnpm check
git add apps/hub/src/Director.ts apps/hub/src/Director.test.ts
git commit -m "feat(hub): gauge listed games for Grafana"
```

Expected: all Director tests and all repository checks pass.

### Task 3: Build the Game Day overview

**Files:**
- Create: `telemetry/dashboards/game-day.json`

- [ ] **Step 1: Confirm the exported metric names**

Start telemetry and the Hub from the implementation worktree:

```bash
pnpm telemetry
pnpm --filter @sportal/hub dev
```

In another shell, wait for one OTLP export, then run:

```bash
curl -s -u admin:admin \
  http://localhost:3000/api/datasources/proxy/uid/prometheus/api/v1/label/__name__/values \
  | python3 -c 'import json,sys; print("\n".join(n for n in json.load(sys.stdin)["data"] if n.startswith("sportal_game_") or n == "sportal_hub_up_ratio"))'
```

Expected names:

```text
sportal_game_clock_ratio
sportal_game_kickoff_ratio
sportal_game_period_ratio
sportal_game_score_ratio
sportal_game_state_ratio
sportal_game_status_ratio
sportal_game_updated_at_ratio
sportal_hub_up_ratio
```

If the exporter uses a different suffix, use the names printed by this command in both new dashboards and record that exact exporter spelling in the implementation commit body.

- [ ] **Step 2: Create the dashboard shell and variables**

Create `telemetry/dashboards/game-day.json` with these top-level values:

```json
{
  "uid": "sportal-game-day",
  "title": "Game Day",
  "schemaVersion": 41,
  "time": { "from": "now-24h", "to": "now" },
  "refresh": "10s",
  "links": [
    {
      "title": "Hub operations",
      "type": "link",
      "url": "/d/sportal-hub/hub?from=${__from}&to=${__to}&refresh=10s",
      "targetBlank": false
    }
  ],
  "templating": {
    "list": [
      {
        "name": "league",
        "label": "League",
        "type": "query",
        "datasource": { "type": "prometheus", "uid": "prometheus" },
        "query": {
          "qryType": 1,
          "query": "label_values(sportal_game_state_ratio, league)",
          "refId": "PrometheusVariableQueryEditor-League"
        },
        "definition": "label_values(sportal_game_state_ratio, league)",
        "refresh": 2,
        "multi": true,
        "includeAll": true,
        "allValue": ".*",
        "current": { "text": "All", "value": "$__all" },
        "sort": 1
      },
      {
        "name": "game",
        "label": "Games with plays",
        "type": "query",
        "hide": 2,
        "datasource": { "type": "prometheus", "uid": "prometheus" },
        "query": {
          "qryType": 0,
          "query": "query_result(max by (game, matchup) (sportal_game_state_ratio{league=~\"$league\"} > 1))",
          "refId": "PrometheusVariableQueryEditor-Game"
        },
        "definition": "query_result(max by (game, matchup) (sportal_game_state_ratio{league=~\"$league\"} > 1))",
        "regex": "/game=\"(?<value>[^\"]+)\".*matchup=\"(?<text>[^\"]+)\"/",
        "refresh": 2,
        "multi": true,
        "includeAll": true,
        "allValue": ".*",
        "current": { "text": "All", "value": "$__all" },
        "sort": 1
      }
    ]
  },
  "panels": []
}
```

Load the shell through provisioning and inspect the variable preview in Grafana. If Grafana 13 rewrites `qryType` when the query is saved, export the dashboard and keep Grafana's rewritten numeric value.

- [ ] **Step 3: Add the summary stat panels**

Add these five native stat panels at `y: 0`, `h: 4`. Every target is instant Prometheus data and filters `league=~"$league"` where applicable.

| id | x/w | title | expression | display |
| ---: | --- | --- | --- | --- |
| 1 | 0/4 | Hub | `2 * (max(sportal_hub_up_ratio) or vector(0)) + (count(sportal_game_state_ratio{league=~"$league"}) > bool 0)` | 0 and 1 `Hub unavailable` red; 2 `No games currently listed` blue; 3 `Games listed` green |
| 2 | 4/4 | Live | `count(sportal_game_state_ratio{league=~"$league"} == 2) or vector(0)` | green value |
| 3 | 8/4 | Upcoming | `count(sportal_game_state_ratio{league=~"$league"} == 1) or vector(0)` | blue value |
| 4 | 12/4 | Over | `count(sportal_game_state_ratio{league=~"$league"} == 3) or vector(0)` | purple value |
| 5 | 16/8 | Stalest live update | `max((time() - sportal_game_updated_at_ratio{league=~"$league"}) and on(game) (sportal_game_state_ratio{league=~"$league"} == 2))` | seconds; neutral through 30, amber at 31, red at 61; `noValue` `No game live` |

Use the existing dashboard's stat option shape:

```json
"options": {
  "reduceOptions": { "calcs": ["lastNotNull"] },
  "colorMode": "background",
  "graphMode": "none"
}
```

- [ ] **Step 4: Add the joined Games table**

Add panel id 6 at `{ "x": 0, "y": 4, "w": 24, "h": 12 }`, type `table`, title `Games`, Prometheus datasource. Each target is instant, table-formatted, and filters the league variable:

| ref | field | expression |
| --- | --- | --- |
| A | Progress | `max by (game, league, matchup) (sportal_game_state_ratio{league=~"$league"})` |
| B | Status | `max by (game) (sportal_game_status_ratio{league=~"$league"})` |
| C | Away | `max by (game) (sportal_game_score_ratio{league=~"$league",side="away"})` |
| D | Home | `max by (game) (sportal_game_score_ratio{league=~"$league",side="home"})` |
| E | Period | `max by (game) (sportal_game_period_ratio{league=~"$league"})` |
| F | Clock | `max by (game) (sportal_game_clock_ratio{league=~"$league"})` |
| G | Kickoff | `max by (game) (sportal_game_kickoff_ratio{league=~"$league"}) * 1000` |
| H | Updated | `time() - max by (game) (sportal_game_updated_at_ratio{league=~"$league"})` |
| I | Sort | `max by (game) ((sportal_game_state_ratio{league=~"$league"} == bool 2) + 2 * (sportal_game_state_ratio{league=~"$league"} == bool 1) + 3 * (sportal_game_state_ratio{league=~"$league"} == bool 3))` |

Apply transformations in this order:

1. `joinByField`, mode `outer`, field `game`.
2. `sortBy`: the query-I value ascending, then the query-G value ascending.
3. `organize`: keep one `game`, `league`, and `matchup`; rename each query value to the field in the table; hide every Time, duplicate label, Sort, and raw Progress field not used for display.

Field overrides:

- Matchup: add a data link `/d/sportal-game-detail/game-detail?var-game=${__data.fields["game"]}&from=${__from}&to=${__to}&refresh=10s`.
- Status: map 1 Scheduled, 2 Live, 3 Halftime, 4 Delayed, 5 Final, 6 Postponed, 7 Canceled.
- Clock: unit `clock_s`.
- Kickoff: unit `dateTimeAsLocal`.
- Updated: unit `s`, thresholds amber 31 and red 61.
- Game id: hidden after it has supplied the data link.

Use outer join so one absent secondary metric leaves `—` rather than dropping the row.

- [ ] **Step 5: Add the repeated recent-play grid**

Add row id 7 at `y: 16`, title `Recent plays by game`, not collapsed. Add one logs panel template id 8 at `{ "x": 0, "y": 17, "w": 12, "h": 10 }`:

```json
{
  "id": 8,
  "type": "logs",
  "title": "${game:text}",
  "repeat": "game",
  "repeatDirection": "h",
  "maxPerRow": 2,
  "datasource": { "type": "loki", "uid": "loki" },
  "gridPos": { "x": 0, "y": 17, "w": 12, "h": 10 },
  "description": "Latest five plays in the selected range. No logs means no plays were received in range.",
  "links": [
    {
      "title": "Open game detail",
      "url": "/d/sportal-game-detail/game-detail?var-game=${game}&from=${__from}&to=${__to}&refresh=10s",
      "targetBlank": false
    }
  ],
  "options": {
    "sortOrder": "Descending",
    "showTime": true,
    "wrapLogMessage": true,
    "enableLogDetails": true
  },
  "targets": [
    {
      "refId": "A",
      "expr": "{service_name=\"sportal-hub\"} | game=~\"$game\" | play=~\".+\"",
      "maxLines": 5
    }
  ]
}
```

Grafana's native empty state says `No logs found`; the description gives the domain wording `No plays were received in range` without adding a plugin.

- [ ] **Step 6: Validate JSON, provisioning, and queries**

Run:

```bash
python3 -m json.tool telemetry/dashboards/game-day.json >/dev/null
sleep 12
curl -fsS -u admin:admin http://localhost:3000/api/dashboards/uid/sportal-game-day \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["dashboard"]; print(d["title"], [p["title"] for p in d["panels"]])'
```

Expected: `Game Day` followed by the five stats, `Games`, the row, and the repeated panel template.

Run every Prometheus expression with variables replaced:

```bash
python3 - <<'PY'
import json, subprocess, urllib.parse
path = "telemetry/dashboards/game-day.json"
dashboard = json.load(open(path))
for panel in dashboard["panels"]:
    if panel.get("datasource", {}).get("uid") != "prometheus":
        continue
    for target in panel.get("targets", []):
        query = target["expr"].replace('$league', '.*').replace('$game', '.*')
        url = "http://localhost:3000/api/datasources/proxy/uid/prometheus/api/v1/query?query=" + urllib.parse.quote(query)
        response = json.loads(subprocess.run(["curl", "-fsS", "-u", "admin:admin", url], capture_output=True, text=True, check=True).stdout)
        assert response["status"] == "success", (panel["title"], target["refId"], response)
        print("success", panel["title"], target["refId"])
PY
```

Expected: one `success` line for every Prometheus target.

- [ ] **Step 7: Check and commit**

Run:

```bash
pnpm check
git add telemetry/dashboards/game-day.json
git commit -m "feat(telemetry): add game-day overview"
```

Expected: the dashboard is valid, provisioned, and committed alone.

### Task 4: Build the per-game drill-down

**Files:**
- Create: `telemetry/dashboards/game-detail.json`

- [ ] **Step 1: Create the dashboard shell and selected-game variable**

Create `telemetry/dashboards/game-detail.json` with:

```json
{
  "uid": "sportal-game-detail",
  "title": "Game Detail",
  "schemaVersion": 41,
  "time": { "from": "now-24h", "to": "now" },
  "refresh": "10s",
  "links": [
    {
      "title": "Game Day",
      "type": "link",
      "url": "/d/sportal-game-day/game-day?from=${__from}&to=${__to}&refresh=10s",
      "targetBlank": false
    },
    {
      "title": "Hub operations",
      "type": "link",
      "url": "/d/sportal-hub/hub?from=${__from}&to=${__to}&refresh=10s",
      "targetBlank": false
    }
  ],
  "templating": {
    "list": [
      {
        "name": "game",
        "label": "Game",
        "type": "query",
        "datasource": { "type": "prometheus", "uid": "prometheus" },
        "query": {
          "qryType": 0,
          "query": "query_result(max by (game, matchup) (sportal_game_state_ratio))",
          "refId": "PrometheusVariableQueryEditor-Game"
        },
        "definition": "query_result(max by (game, matchup) (sportal_game_state_ratio))",
        "regex": "/game=\"(?<value>[^\"]+)\".*matchup=\"(?<text>[^\"]+)\"/",
        "refresh": 2,
        "multi": false,
        "includeAll": false,
        "sort": 1
      }
    ]
  },
  "panels": []
}
```

Provision it and confirm the Game picker displays matchup text while its URL value is the game id.

- [ ] **Step 2: Add the current-game header**

Add seven stat panels at `y: 0`, `h: 4`:

| id | x/w | title | datasource | expression | display |
| ---: | --- | --- | --- | --- | --- |
| 1 | 0/3 | Listing | Prometheus | `(count(sportal_game_state_ratio{game=~"$game"}) or vector(0)) + 2 * (max(sportal_hub_up_ratio) or vector(0))` | 0 and 1 Hub unavailable red; 2 Game no longer listed amber; 3 Listed green |
| 2 | 3/4 | Away | Prometheus | `max(sportal_game_score_ratio{game=~"$game",side="away"})` | integer |
| 3 | 7/4 | Home | Prometheus | `max(sportal_game_score_ratio{game=~"$game",side="home"})` | integer |
| 4 | 11/4 | Status | Prometheus | `max(sportal_game_status_ratio{game=~"$game"})` | map all seven status values |
| 5 | 15/3 | Period | Prometheus | `max(sportal_game_period_ratio{game=~"$game"})` | integer |
| 6 | 18/3 | Clock | Prometheus | `max(sportal_game_clock_ratio{game=~"$game"})` | unit `clock_s` |
| 7 | 21/3 | Updated | Prometheus | `time() - max(sportal_game_updated_at_ratio{game=~"$game"})` | seconds; amber 31, red 61 |

Use `${game:text}` in the dashboard description and keep the stable id only in queries.

- [ ] **Step 3: Add scoring and complete play logs**

Add panel id 8, type `logs`, title `Scoring timeline`, at `{ "x": 0, "y": 4, "w": 8, "h": 14 }`, using:

```logql
{service_name="sportal-hub"} | game=~"$game" | play=~".+" | scoring="true"
```

Add panel id 9, type `logs`, title `Full play log`, at `{ "x": 8, "y": 4, "w": 16, "h": 14 }`, using:

```logql
{service_name="sportal-hub"} | game=~"$game" | play=~".+"
```

Both use descending order, show time, wrap messages, enable log details, and set `maxLines` to 1000. The selected 24-hour range bounds “full.”

- [ ] **Step 4: Add game diagnostics**

Add an uncollapsed row id 10 at `y: 18`, title `Diagnostics`. Add:

1. Panel 11, timeseries, `Snapshot age`, x 0/w 8/y 19/h 8, Prometheus:

   ```promql
   time() - sportal_game_updated_at_ratio{game=~"$game"}
   ```

   Unit seconds; thresholds amber 31 and red 61.

2. Panel 12, stat, `Plays / 15 min`, x 8/w 4/y 19/h 8, Loki metric query:

   ```logql
   sum(count_over_time({service_name="sportal-hub"} | game=~"$game" | play=~".+" [15m])) or vector(0)
   ```

3. Panel 13, logs, `Game warnings and errors`, x 12/w 12/y 19/h 8:

   ```logql
   {service_name="sportal-hub"} | game=~"$game" | detected_level=~"warn|error|fatal|critical"
   ```

   Its description says that an empty panel means no warning or error was attributed to this game; feed-wide failures are on Hub.

- [ ] **Step 5: Validate JSON, provisioning, PromQL, and LogQL**

Run:

```bash
python3 -m json.tool telemetry/dashboards/game-detail.json >/dev/null
sleep 12
curl -fsS -u admin:admin http://localhost:3000/api/dashboards/uid/sportal-game-detail \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["dashboard"]; print(d["title"], [p["title"] for p in d["panels"]])'
```

Expected: `Game Detail` with seven header stats, two play panels, Diagnostics, and three diagnostic panels.

Validate both new dashboards' datasource queries:

```bash
python3 - <<'PY'
import json, subprocess, time, urllib.parse
paths = ["telemetry/dashboards/game-day.json", "telemetry/dashboards/game-detail.json"]
now = int(time.time() * 1_000_000_000)
start = now - 24 * 60 * 60 * 1_000_000_000
for path in paths:
    dashboard = json.load(open(path))
    panels = list(dashboard["panels"])
    panels += [child for panel in dashboard["panels"] for child in panel.get("panels", [])]
    for panel in panels:
        uid = panel.get("datasource", {}).get("uid")
        for target in panel.get("targets", []):
            query = target.get("expr", "").replace('$league', '.*').replace('$game', '.*').replace('$__range', '24h').replace('$__rate_interval', '1m')
            if not query:
                continue
            if uid == "prometheus":
                endpoint = "/api/datasources/proxy/uid/prometheus/api/v1/query?query=" + urllib.parse.quote(query)
            elif uid == "loki":
                endpoint = "/api/datasources/proxy/uid/loki/loki/api/v1/query_range?" + urllib.parse.urlencode({"query": query, "start": start, "end": now, "limit": 5})
            else:
                continue
            raw = subprocess.run(["curl", "-fsS", "-u", "admin:admin", "http://localhost:3000" + endpoint], capture_output=True, text=True, check=True).stdout
            response = json.loads(raw)
            assert response["status"] == "success", (path, panel["title"], target["refId"], response)
            print("success", path, panel["title"], target["refId"])
PY
```

Expected: every Prometheus and Loki target prints `success`.

- [ ] **Step 6: Check and commit**

Run:

```bash
pnpm check
git add telemetry/dashboards/game-detail.json
git commit -m "feat(telemetry): add game drill-down"
```

Expected: the detail dashboard is committed alone.

### Task 5: Make Hub operations-only and document the telemetry

**Files:**
- Modify: `telemetry/dashboards/hub.json`
- Modify: `CONTEXT.md`
- Modify: `docs/technical-spec.md`

- [ ] **Step 1: Remove duplicated game-day panels from Hub**

In `telemetry/dashboards/hub.json`:

- remove the `matchup` template variable, leaving `templating.list` empty;
- remove panel 27 `Games`;
- remove row 50 `Plays` and panels 51 `Plays` and 52 `Scoring plays`;
- add this dashboard link:

```json
"links": [
  {
    "title": "Game Day",
    "type": "link",
    "url": "/d/sportal-game-day/game-day?from=${__from}&to=${__to}&refresh=10s",
    "targetBlank": false
  }
]
```

Move the remaining top-level panels without changing their queries:

| panel | new y |
| --- | ---: |
| row 12 `Live feed` | 0 |
| panel 17 `FastCast logs` | 1 |
| row 40 `Poll` | 11 |
| panel 53 `Pushes behind their listing by league` | 12 |
| panel 41 `Provider logs` | 20 |
| row 42 `Hub` | 28 |
| collapsed panels 1 and 2 | 29 |

Keep uid `sportal-hub`, title `Hub`, its 30-minute range, and 30-second refresh.

- [ ] **Step 2: Validate all three dashboards as one provisioned set**

Run:

```bash
for file in telemetry/dashboards/*.json; do python3 -m json.tool "$file" >/dev/null; done
sleep 12
python3 - <<'PY'
import json, subprocess
expected = {
    "sportal-game-day": "Game Day",
    "sportal-game-detail": "Game Detail",
    "sportal-hub": "Hub",
}
for uid, title in expected.items():
    raw = subprocess.run(["curl", "-fsS", "-u", "admin:admin", f"http://localhost:3000/api/dashboards/uid/{uid}"], capture_output=True, text=True, check=True).stdout
    dashboard = json.loads(raw)["dashboard"]
    assert dashboard["title"] == title, dashboard["title"]
    ids = []
    for panel in dashboard["panels"]:
        ids.append(panel["id"])
        ids.extend(child["id"] for child in panel.get("panels", []))
    assert len(ids) == len(set(ids)), (uid, ids)
    encoded = json.dumps(dashboard)
    if uid in {"sportal-game-day", "sportal-game-detail"}:
        assert "${__from}" in encoded and "${__to}" in encoded, uid
    if uid == "sportal-game-day":
        assert "var-game=" in encoded and '"repeat": "game"' in encoded, uid
    if uid == "sportal-game-detail":
        variable = dashboard["templating"]["list"][0]
        assert variable["name"] == "game", variable
        assert "?<value>" in variable["regex"] and "?<text>" in variable["regex"], variable
    print(uid, title, len(ids), "unique panel ids")
PY
```

Expected: all JSON parses, all dashboards load, every dashboard reports unique panel ids, drill links preserve the range, and game variables retain stable-id values with visible matchup text.

- [ ] **Step 3: Update the glossary's Director row**

In `CONTEXT.md`, extend the Director row so it names current game dashboard telemetry without introducing a new domain term. Replace the metric clause with:

```text
...gauges each listed game's progress and current dashboard values (`sportal_game_state`, status, scores, period, clock, kickoff, and accepted-at gauges), drops every series when the game is delisted, and logs each play a take adds.
```

Keep the rest of the Director definition unchanged.

- [ ] **Step 4: Update the technical spec**

In `docs/technical-spec.md`:

1. In the telemetry stack row, say the provisioned Sportal folder contains Game Day, Game Detail, and Hub.
2. In the repository tree, change the telemetry comment to `Local Grafana: compose file, Game Day, Game Detail, and Hub dashboards`.
3. In the Director design bullet, replace the single-gauge sentence with the exact seven current-game metrics, stable attributes, and delisting behavior.
4. In the Telemetry failure/behavior text, mention `sportal_hub_up` as the distinction between an empty slate and an unavailable Hub.
5. State that play logs remain the source for latest-five, scoring-only, and complete-in-range play panels; no play counter is added.

Do not add a glossary row: all code-level names remain private metrics, and every exported type is unchanged.

- [ ] **Step 5: Check and commit**

Run:

```bash
pnpm check
git add telemetry/dashboards/hub.json CONTEXT.md docs/technical-spec.md
git commit -m "docs(telemetry): split game day from Hub operations"
```

Expected: all checks pass and the operational dashboard has no duplicated game table or play panels.

### Task 6: End-to-end live verification

**Files:**
- Modify only if verification exposes a concrete query or display defect.

- [ ] **Step 1: Start the complete local stack**

Run:

```bash
pnpm dev
```

Expected: telemetry is healthy, the Hub exports to `localhost:4318`, and Grafana serves the three Sportal dashboards at `localhost:3000`.

- [ ] **Step 2: Verify Game Day during listed games**

Open `http://localhost:3000/d/sportal-game-day/game-day` and verify:

- Hub distinguishes unavailable, no games, and games listed;
- counts agree with the Games table;
- rows order live, upcoming, then over;
- score, status, period, clock, kickoff, and age are populated;
- live age normally remains at or below 30 seconds;
- each started game has one repeated panel with at most five plays;
- league filtering changes counts, rows, and repeated panels together.

- [ ] **Step 3: Verify drill-down links and history**

From a table matchup and a repeated panel, open Game Detail and verify:

- the URL carries the stable game id and selected time range;
- the variable displays matchup text;
- current values belong to the selected game;
- Full play log contains more than five entries when the game has them;
- Scoring timeline contains only logs with `scoring="true"`;
- Plays / 15 min agrees with the recent full-log entries;
- game-attributed warning/error logs do not include feed-wide failures;
- Game Day and Hub links preserve the range.

- [ ] **Step 4: Verify empty and delisted behavior**

When no game is live, verify `Stalest live update` says `No game live`. If a game is delisted while its detail URL is open, verify Listing changes to `Game no longer listed` while Loki history remains in range.

If live timing makes delisting impractical, verify the PromQL directly with a non-existent game id:

```bash
curl -fsSG -u admin:admin \
  --data-urlencode 'query=(count(sportal_game_state_ratio{game="not-listed"}) or vector(0)) + 2 * (max(sportal_hub_up_ratio) or vector(0))' \
  http://localhost:3000/api/datasources/proxy/uid/prometheus/api/v1/query
```

Expected: value 2 while the Hub is active, which maps to `Game no longer listed`.

- [ ] **Step 5: Run final verification and inspect the diff**

Stop the foreground dev process cleanly, then run:

```bash
pnpm check
git status --short
git diff --check
git log --oneline -5
```

Expected: `pnpm check` passes, `git diff --check` is silent, and only intentional verification fixes remain uncommitted.

- [ ] **Step 6: Commit any verification-only correction**

If Step 5 shows an intentional correction, run:

```bash
pnpm check
git add telemetry/dashboards/game-day.json telemetry/dashboards/game-detail.json telemetry/dashboards/hub.json CONTEXT.md docs/technical-spec.md
git commit -m "fix(telemetry): correct game dashboard queries"
```

If there is no correction, do not create an empty commit.
