# Hub Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `SPORTAL_OTLP_URL` set, the Hub exports its spans, logs, and metrics over OTLP/HTTP to a local `grafana/otel-lgtm`, where a Hub dashboard shows polls, provider errors, and logs. Without it, the Hub behaves exactly as today.

**Architecture:** `Logging.ts` becomes `Telemetry.ts`: one layer that keeps today's log level and console format and, when `HubConfig.otlpUrl` is present, adds Effect's combined OTLP exporter (`Otlp.layerJson` from `effect/observability`) over the Hub's `HttpClient`. Each poll in `Ingest` becomes an `Ingest.poll` span, so the providers' spans (and the `http.client GET` spans `HttpClient` already makes) nest under it, and it records two metrics. A `telemetry/` folder at the repo root holds the compose file, Grafana provisioning, and the Hub dashboard; `pnpm telemetry` runs it.

**Tech Stack:** Effect 4 (`effect/observability` `Otlp`, `Metric`, `Tracer`, `Logger`, `Config`, `Schema.URLFromString`, `effect/http` `HttpClient`), `@effect/vitest`, Docker Compose, `grafana/otel-lgtm`.

**Spec:** `docs/specs/2026-10-04-telemetry-design.md`. Work only in the worktree `/home/chazzy/development/projects/sportal-telemetry` (branch `telemetry`), created with `git worktree add ../sportal-telemetry -b telemetry main` and then `pnpm install --frozen-lockfile --prefer-offline` inside it. Copy the spec and this plan into it as the first commit. Never touch the main checkout, and stop any stray Hub on port 4400 before running one.

## Global Constraints

- Read `AGENTS.md` first. Effect 4 is newer than most training data: read `node_modules/effect/ai-docs/src/08_observability/20_otlp-tracing.ts` and the sources under `node_modules/effect/src/observability/` before writing exporter code. No OpenTelemetry SDK, no new dependency.
- Every exported type name is a `CONTEXT.md` term; this plan adds **Telemetry**.
- Main export first; private helpers below as hoisted `function` declarations; no options-bag type aliases; no `any`, casts outside decoding, non-null assertions, enums, default exports, or `index.ts` barrels.
- Comments: a doc comment on each major export; an inline comment only where the why is not clear from the code.
- Only `HubConfig.ts` reads the environment. A service is yielded where it is used; a choice between layers at startup is a `Layer.unwrap` that yields `HubConfig`.
- No booleans standing in for state, no `let` flags, no `for` loops in new or rewritten Effect code. Use Effect's combinators (`Effect.forEach`, `Effect.result`, `Effect.cached`, `Effect.timed`).
- Setting: `SPORTAL_OTLP_URL`, optional, an `http:` or `https:` URL (the collector's OTLP/HTTP base, e.g. `http://localhost:4318`). Anything else stops the Hub at startup naming the setting.
- Resource: `service.name` `sportal-hub`; `service.version` = `HubConfig.version`; `sportal.mode` = `live`, or `scenario:<name>` when `HubConfig.scenario` is set.
- Metric names: `sportal_poll_duration` (a `Metric.timer`, milliseconds), `sportal_provider_errors` (a counter, attribute `league`).
- Graceful shutdown stays within the 3-second bound with the collector down: exporter `shutdownTimeout` is `1 second`.
- Local backend: Grafana on `localhost:3000`, OTLP/HTTP on `localhost:4318`, image `grafana/otel-lgtm` at a pinned tag (never `latest`).
- Tests sit beside their file as `Name.test.ts`. Run one file with `pnpm vitest run <path>`. `pnpm check` must pass before every commit.
- Commit messages are conventional and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Spec refinements found while planning

Reading `effect/observability` changed three details. Task 5 writes them into the spec.

| Spec says | Effect does | This plan |
| --- | --- | --- |
| Collector down: "one warning on the console, not one per batch" | `OtlpExporter` catches a failed export, logs it at **Debug**, drops the batch, and stops exporting for 60 s, then tries again. At `Info` nothing shows | `Telemetry` gives the exporters an `HttpClient` that, on its first failed request, logs one warning naming the URL. Later failures stay at Effect's Debug line |
| Telemetry never slows the Hub | Each exporter's shutdown flush waits up to `shutdownTimeout`, default 3 s, which alone would use the Hub's whole shutdown bound | `shutdownTimeout: "1 second"`, proved by the process test with an unreachable collector |
| A scenario poll's trace shows its provider calls | `ScenarioProvider.slate` is not a span, so a scenario run's poll has no children | `ScenarioProvider.slate` becomes `Effect.fn("ScenarioProvider.slate")` |

Also: `new URL("localhost:4318")` parses, as scheme `localhost:`, so the setting checks the protocol as well as decoding.

## Files

| File | Responsibility |
| --- | --- |
| `apps/hub/src/HubConfig.ts` (modify) | `otlpUrl: Option.Option<URL>` |
| `apps/hub/src/HubConfig.test.ts` (modify) | Default none; reads a URL; refuses a non-URL and a non-HTTP URL |
| `apps/hub/src/Logging.ts` → `apps/hub/src/Telemetry.ts` (`git mv`) | Log level, console format, and the OTLP exporters when configured |
| `apps/hub/src/Telemetry.test.ts` (create) | No URL: no requests, today's logging. A URL: traces, logs, metrics reach a recording endpoint with the resource; one warning when it fails |
| `apps/hub/src/main.ts` (modify) | Provides `Telemetry.layer`; `FetchHttpClient.layer` moves below it so both it and `HubMode` get the client |
| `apps/hub/src/main.test.ts` (modify) | With an unreachable collector, the Hub still stops within the bound and exits 0 |
| `apps/hub/src/ingest/Ingest.ts` (modify) | A poll is an `Ingest.poll` span with its metrics; the sleep is outside the span |
| `apps/hub/src/ingest/Ingest.test.ts` (modify) | Span nesting, attributes, metrics |
| `apps/hub/src/scenario/ScenarioProvider.ts` (modify) | `slate` is a span |
| `telemetry/compose.yaml` (create) | `grafana/otel-lgtm`, ports, named volume, dashboard provisioning mount |
| `telemetry/dashboards.yaml` (create) | Grafana dashboard provider pointing at `/var/lib/sportal-dashboards` (the mount) |
| `telemetry/dashboards/hub.json` (create) | The Hub dashboard |
| `package.json` (modify) | `telemetry`, `telemetry:down` scripts |
| `CONTEXT.md`, `AGENTS.md`, `docs/technical-spec.md`, `docs/game-day-checklist.md` (modify) | As the spec's "Documents that change" |

---

### Task 1: `SPORTAL_OTLP_URL` is a setting

**Files:**
- Modify: `apps/hub/src/HubConfig.ts`
- Modify: `apps/hub/src/HubConfig.test.ts`
- Modify: `AGENTS.md` (Hub settings line)

**Interfaces:**
- Produces: `HubConfig` gains `readonly otlpUrl: Option.Option<URL>`.

- [ ] **Step 1: Write the failing tests** in `HubConfig.test.ts`, extending the existing cases rather than adding parallel ones:
  - "has a default for every setting": `assert.isTrue(Option.isNone(config.otlpUrl))`.
  - "reads each setting": env gains `SPORTAL_OTLP_URL: "http://localhost:4318"`; assert `Option.map(config.otlpUrl, (url) => url.href)` equals `Option.some("http://localhost:4318/")`.
  - The refusal table gains `["SPORTAL_OTLP_URL", "not a url"]` and `["SPORTAL_OTLP_URL", "localhost:4318"]` (parses as scheme `localhost:`; must be refused).
- [ ] **Step 2: Run** `pnpm vitest run apps/hub/src/HubConfig.test.ts`. Expected: the new assertions fail (`otlpUrl` does not exist; type error surfaces as a failed test).
- [ ] **Step 3: Implement.** Add `otlpUrl` to the service shape after `version`. Read it with `Config.schema(Schema.URLFromString.check(<protocol is "http:" or "https:">), "SPORTAL_OTLP_URL").pipe(Config.option)`. Find the check combinator the way `scenarioSpeed` does (`Schema.isGreaterThan`); if no ready-made check fits, use `Schema.makeFilter` with a predicate on `url.protocol`. No inline comment unless the protocol check needs one line on why (the `localhost:` parse).
- [ ] **Step 4: Run** the file again. Expected: PASS.
- [ ] **Step 5:** In `AGENTS.md`, add `SPORTAL_OTLP_URL` (the collector's OTLP/HTTP base URL; unset exports nothing) to the "Hub settings" line before `SPORTAL_VERSION`.
- [ ] **Step 6:** `pnpm check`, then commit `feat(hub): SPORTAL_OTLP_URL names the telemetry collector`.

---

### Task 2: `Telemetry` exports when the setting is present

**Files:**
- Rename: `apps/hub/src/Logging.ts` → `apps/hub/src/Telemetry.ts` (`git mv`, then edit)
- Create: `apps/hub/src/Telemetry.test.ts`
- Modify: `apps/hub/src/main.ts`, `apps/hub/src/main.test.ts`
- Modify: `CONTEXT.md` (glossary row), `docs/technical-spec.md` (§4.2 tree line `Logging.ts` → `Telemetry.ts  Log level and format; OTLP export when configured`, and wherever it describes logging)

**Interfaces:**
- Consumes: `HubConfig.otlpUrl`, `HubConfig.logLevel`, `HubConfig.logFormat`, `HubConfig.version`, `HubConfig.scenario`.
- Produces: `export const layer: Layer.Layer<never, never, HubConfig | HttpClient.HttpClient>` in `Telemetry.ts`, doc comment: the Hub's log level and console format, and, when `SPORTAL_OTLP_URL` is set, its spans, logs, and metrics exported over OTLP.

Shape of `Telemetry.layer` (a `Layer.unwrap` that yields `HubConfig`, like `Logging.layer` today):

```
Telemetry.layer
├─ References.MinimumLogLevel ← logLevel                  (as today)
├─ console: json → Logger.consoleJson, pretty → default    (as today)
└─ otlpUrl
   ├─ None    → Layer.empty
   └─ Some(u) → Otlp.layerJson({ baseUrl: u.href, resource, shutdownTimeout: "1 second" })
                 provided with the yielded HttpClient, wrapped so its first failed
                 request logs one warning (Effect.cached around Effect.logWarning)
```

The logger's `mergeWithExisting` defaults to `true` in `OtlpLogger`, which is what keeps the console. Do not pass it.

- [ ] **Step 1: Write the failing tests** in `Telemetry.test.ts`. Build a recording `HttpClient` with `HttpClient.make` that answers 200 and appends each request (URL and decoded JSON body) to a `Ref`. Provide `Telemetry.layer` with `HubConfig` built from `ConfigProvider.fromEnv` exactly as `HubConfig.test.ts`'s `withEnv` does (reuse that pattern; do not export the helper from the other test file). Run the work inside `Effect.scoped` + `Layer.build`, so closing the scope runs the exporters' final flush, then read the `Ref`.
  - "exports nothing without SPORTAL_OTLP_URL": log a line, run a span; no request is recorded.
  - "keeps the level as today": with `SPORTAL_LOG_LEVEL=Warning`, `References.MinimumLogLevel` read inside the layer is `"Warning"` (the old behaviour, which had no test).
  - "sends spans, logs, and metrics below the base URL": with `SPORTAL_OTLP_URL=http://collector:4318`, run `Effect.logInfo("hello").pipe(Effect.withSpan("test.span"))` and `Metric.update(Metric.counter("test_counter"), 1)`; requests are recorded to `http://collector:4318/v1/traces`, `/v1/logs`, and `/v1/metrics`; the trace body contains a span named `test.span`; the log body contains `hello`.
  - "names the Hub and its mode in the resource": in the trace body's `resourceSpans[0].resource.attributes`, `service.name` is `sportal-hub`, `service.version` is the `SPORTAL_VERSION` given, and `sportal.mode` is `live`; a second case with `SPORTAL_SCENARIO=two-minute-drill-tie` gives `scenario:two-minute-drill-tie`.
  - "warns once when the collector cannot be reached": an `HttpClient` that fails every request; capture logs with an extra `Logger.layer([recording logger], { mergeWithExisting: true })`; advance `TestClock` across several logger export intervals (1 s each) and past 60 s; exactly one Warning-level message, and it names the URL.
- [ ] **Step 2: Run** `pnpm vitest run apps/hub/src/Telemetry.test.ts`. Expected: FAIL (`Telemetry.ts` has no OTLP export; resource and warning cases fail).
- [ ] **Step 3: Implement** `Telemetry.layer` to the shape above. The resource attributes and the warn-once client are private helpers below the layer, as hoisted functions, only if they are more than a few lines; otherwise inline.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Wire it in `main.ts`.** Replace the `Logging` import and `Layer.provide(Logging.layer)` with `Telemetry`. Move `FetchHttpClient.layer` out of the `[Database.inDataDir, FetchHttpClient.layer]` provide and into the bottom `Layer.provide(HubConfig.layer)` line as `[HubConfig.layer, FetchHttpClient.layer]`, so `HubMode` and `Telemetry` both get it. `Telemetry` must stay provided below everything that logs or makes spans.
- [ ] **Step 6: Extend `main.test.ts`.** Add to the SIGTERM test a second case (or parametrise the existing one, if that reads more simply) with `SPORTAL_OTLP_URL: "http://127.0.0.1:<freePort()>"`: nothing listens there; the Hub still answers health, stops within 5 s of SIGTERM, and exits 0. Run `pnpm vitest run apps/hub/src/main.test.ts`. Expected: PASS. If it takes over 3 s to stop, the `shutdownTimeout` is not applied.
- [ ] **Step 7: Docs.** `CONTEXT.md`: the spec's **Telemetry** row (term, meaning, "Not: monitoring, observability stack"), in alphabetical place. `docs/technical-spec.md`: the tree line and the logging description.
- [ ] **Step 8:** `pnpm check` (knip will flag nothing if `Logging.ts` is fully gone), then commit `feat(hub): Telemetry exports spans, logs, and metrics over OTLP when SPORTAL_OTLP_URL is set`.

---

### Task 3: A poll is a trace, with its metrics

**Files:**
- Modify: `apps/hub/src/ingest/Ingest.ts`
- Modify: `apps/hub/src/ingest/Ingest.test.ts`
- Modify: `apps/hub/src/scenario/ScenarioProvider.ts`

**Interfaces:**
- Consumes: `Provider.slate(league): Effect<ReadonlyArray<GameSnapshot>, ProviderError>`.
- Produces: span `Ingest.poll` with attributes `sportal.leagues` (the leagues polled) and `sportal.failed_leagues` (those whose provider failed, empty when none); span `ScenarioProvider.slate`; metrics `sportal_poll_duration` (`Metric.timer`) and `sportal_provider_errors` (`Metric.counter`, `incremental: true`, attribute `league`). Both metrics are module-level constants beside `Ingest`, their only user, below the class.

The poll today is one `Effect.gen` that fetches, publishes, and sleeps. Split it so the span covers the work, not the wait:

```
forever:
  Ingest.poll (span, timed → sportal_poll_duration)
    forEach league: provider.slate(league) as Effect.result   ← ProviderError → warning + sportal_provider_errors{league}
    failed leagues = the failures                             ← replaces the `let anyFailed` flag
    byLeague updated with the successes; slate published
    annotate span: sportal.leagues, sportal.failed_leagues
  sleep Cadence.interval(slate, now, failed leagues non-empty)
```

`Cadence.interval` keeps its boolean parameter; only `Ingest` changes.

- [ ] **Step 1: Write the failing tests** in `Ingest.test.ts`. Capture spans with a recording tracer: `Tracer.make` whose `span` delegates to the native tracer and records each span on end; provide it with `Layer.succeed(Tracer.Tracer, …)`. Have the `scripted` provider's `slate` wrap its answer in `Effect.withSpan("provider.slate")` so the test sees a child.
  - "a poll is one span with the provider's span inside it": after `TestClock.adjust(0)`, exactly one `Ingest.poll` span has ended; a `provider.slate` span has it as parent; `sportal.leagues` is `["fbs"]` and `sportal.failed_leagues` is `[]`.
  - "the span ends before the poll sleeps": after `TestClock.adjust(0)` the `Ingest.poll` span has already ended (today's poll would still be open during its sleep).
  - "a failed league is on the span and counted": with `scripted(["fail"])`, the span's `sportal.failed_leagues` is `["fbs"]`, and `Metric.value` of `sportal_provider_errors` with `league: "fbs"` is 1. Export the metrics only if the test cannot reach them otherwise; prefer `Metric.snapshot` filtered by name so nothing is exported for a test.
  - "each poll records its duration": after two polls, the `sportal_poll_duration` histogram's count is 2.
  - The three existing tests stay unchanged and keep passing.
- [ ] **Step 2: Run** `pnpm vitest run apps/hub/src/ingest/Ingest.test.ts`. Expected: the new cases FAIL; the old ones PASS.
- [ ] **Step 3: Implement** the split above in `Ingest.ts`. Keep the `byLeague` cache and its comment; it is outside this piece. Keep the existing warning message.
- [ ] **Step 4:** In `ScenarioProvider.ts`, make `slate` an `Effect.fn("ScenarioProvider.slate")`. Run `pnpm vitest run apps/hub/src/scenario` to confirm nothing changed.
- [ ] **Step 5: Run** the Ingest tests. Expected: PASS.
- [ ] **Step 6:** `pnpm check`, then commit `feat(hub): each poll is an Ingest.poll span, timed, with provider errors counted by league`.

---

### Task 4: `pnpm telemetry` runs Grafana with the Hub dashboard

**Files:**
- Create: `telemetry/compose.yaml`, `telemetry/dashboards.yaml`, `telemetry/dashboards/hub.json`
- Modify: `package.json`
- Modify: `AGENTS.md` (Commands), `docs/game-day-checklist.md`

- [ ] **Step 1: Pick the tag.** Find the newest `grafana/otel-lgtm` release tag on Docker Hub and pull it. Confirm where its Grafana reads dashboard provisioning: `docker run --rm --entrypoint sh grafana/otel-lgtm:<tag> -c 'ls /otel-lgtm/grafana/conf/provisioning'` (adjust the path to what the image has). Record the tag in the compose file only.
- [ ] **Step 2: `telemetry/compose.yaml`**: one service `lgtm`, `image: grafana/otel-lgtm:<tag>`, ports `3000:3000` and `4318:4318` (bind to `127.0.0.1` so nothing on the home network reaches an unauthenticated Grafana), a named volume `lgtm-data` on the image's data directory, and two read-only mounts: `./dashboards.yaml` into the provisioning `dashboards/` folder, `./dashboards` at `/var/lib/sportal-dashboards`.
- [ ] **Step 3: `telemetry/dashboards.yaml`**: a Grafana dashboard provider named `sportal`, folder `Sportal`, path `/var/lib/sportal-dashboards`, `allowUiUpdates: false`.
- [ ] **Step 4: Scripts.** `package.json`: `"telemetry": "docker compose -f telemetry/compose.yaml up -d"`, `"telemetry:down": "docker compose -f telemetry/compose.yaml down"` (both run through pnpm's shell emulator; no bash syntax). Run `pnpm telemetry`; Grafana answers on `http://localhost:3000`.
- [ ] **Step 5: Produce data to build against.** In the worktree: `SPORTAL_OTLP_URL=http://localhost:4318 SPORTAL_SCENARIO=two-minute-drill-tie SPORTAL_SCENARIO_SPEED=10 pnpm --filter @sportal/hub dev`. In Grafana Explore, find the exact Prometheus names the two metrics arrive under (expect `sportal_poll_duration…_bucket` and `sportal_provider_errors_total`), and the Loki labels for `service_name` and `sportal.mode`.
- [ ] **Step 6: `telemetry/dashboards/hub.json`**: build the dashboard in Grafana, then export its JSON (with `uid` `sportal-hub`, no `id`, datasources referenced by the image's provisioned uids) and save it here. Panels, in this order:
  1. Hub log volume by level (Loki, `{service_name="sportal-hub"}`, `sum by (detected_level) (count_over_time(…[$__interval]))`).
  2. Recent warnings and errors (Loki logs panel, level Warning or above).
  3. Poll duration p50 and p95 (Prometheus, `histogram_quantile` over the bucket metric).
  4. Provider errors by league (Prometheus, `sum by (league) (increase(…[$__rate_interval]))`).
  5. Poll traces (a text or data link panel opening Tempo Explore on `{resource.service.name="sportal-hub" && name="Ingest.poll"}`).
  A dashboard variable `mode` over `sportal.mode` filters every panel, so a scenario run never mixes with a live one.
- [ ] **Step 7: Prove provisioning.** `pnpm telemetry:down && pnpm telemetry`; the Sportal folder holds the Hub dashboard without importing anything by hand, and its panels fill while the scenario Hub runs. Run `pnpm format` so Biome formats the JSON.
- [ ] **Step 8: Docs.** `AGENTS.md` Commands: `pnpm telemetry` / `pnpm telemetry:down` — start or stop a local Grafana (`localhost:3000`) with OTLP on `localhost:4318` and the Hub dashboard; run the Hub with `SPORTAL_OTLP_URL=http://localhost:4318` to send to it. `docs/game-day-checklist.md`: a row "Run `pnpm telemetry`, then a scenario at 10× with `SPORTAL_OTLP_URL=http://localhost:4318`, and open the Hub dashboard" → "The dashboard fills; a poll's trace shows its provider calls; logs filter by mode". Add, in Setup or in that row, that `pnpm telemetry` needs Docker.
- [ ] **Step 9:** `pnpm check`, then commit `feat: pnpm telemetry runs a local Grafana with the Hub dashboard`.

---

### Task 5: The spec matches what was built

**Files:**
- Modify: `docs/specs/2026-10-04-telemetry-design.md`

- [ ] **Step 1:** Amend the spec with the "Spec refinements found while planning" table above: the Failures row (one warning from the exporters' client on the first failure; Effect itself drops batches, stops for 60 s, and logs at Debug), a Decisions row for `shutdownTimeout` 1 s, the `ScenarioProvider.slate` span in "Polls as traces", and the setting's `http:`/`https:` check. Mark the status line "Approved 2026-10-04; refined while planning".
- [ ] **Step 2:** Commit `docs: telemetry spec refined while planning`.

## Self-review

- Spec coverage: setting (T1), `Telemetry.ts` replacing `Logging.ts` with console kept and resource (T2), polls as traces and metrics (T3), compose, scripts, dashboard, folder, dev opt-in (T4), failures (T2 warn-once, unreachable shutdown test), testing table rows (T1–T4), documents that change (T1, T2, T4, T5). Deployment and game-actor metrics are out of scope, per the spec.
- Names used across tasks: `HubConfig.otlpUrl`, `Telemetry.layer`, `Ingest.poll`, `ScenarioProvider.slate`, `sportal_poll_duration`, `sportal_provider_errors`, `sportal.leagues`, `sportal.failed_leagues`, `sportal.mode`.
