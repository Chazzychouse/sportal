# Hub Telemetry — Design

Date: 2026-10-04
Status: Approved 2026-10-04; refined while planning

The Hub exports its traces, logs, and metrics over OTLP to a `grafana/otel-lgtm` backend, so a game day can be read
in Grafana instead of in a terminal. This comes before [game actors](./2026-10-04-game-actors-design.md), which keep
no stored messages and rely on telemetry as their record.

## Goal

- With one setting, the Hub sends every span, log line, and metric it produces to an OTLP endpoint. Without it, the
  Hub behaves exactly as today.
- One command starts a local Grafana with Loki, Tempo, and Prometheus behind an OTLP collector, with a Hub dashboard
  already in it.
- In Grafana, the Hub's logs are searchable by their annotations, and a poll is one trace with its provider calls
  inside it.

## Today

| What | Where |
| --- | --- |
| Log level and format (`pretty` or `json`) from `HubConfig`; console only | `apps/hub/src/Logging.ts` |
| Some functions are `Effect.fn` spans (`EspnProvider.slate`, `StageSessions.dispatch`, `SqlChannelStore.record`); nothing exports them | various |
| A poll is not a span; its provider calls have no parent | `ingest/Ingest.ts` |
| No metrics | — |

## Glossary

| Term | Meaning | Not |
| --- | --- | --- |
| **Telemetry** | The traces, logs, and metrics the Hub exports for people to read in Grafana. | monitoring, observability stack |

## Decisions

| Question | Decision |
| --- | --- |
| Setting | `SPORTAL_OTLP_URL`, a field on `HubConfig`: the collector's OTLP/HTTP base URL (`http://localhost:4318`). Optional; unset exports nothing. Not a URL, or a URL whose scheme is not `http:` or `https:` (`localhost:4318` parses, as scheme `localhost:`), stops the Hub at startup, like every other setting |
| Where | `Logging.ts` becomes `Telemetry.ts`: one layer owning the log level, the console format, and, when the setting is present, the OTLP exporters. One concept, one file; `main.ts` provides it where it provides `Logging.layer` today |
| Exporters | Effect's own: `OtlpTracer`, `OtlpLogger`, and `OtlpMetrics` from `effect/observability`, over the `HttpClient` `main.ts` already provides. Pattern: `node_modules/effect/ai-docs/src/08_observability/20_otlp-tracing.ts`. No OpenTelemetry SDK |
| Console | Kept alongside the export, at the same level and format, so a terminal still shows what the Hub is doing. The console layer is fed into the OTLP layer, so JSON console output and OTLP logs coexist, and the collector warning follows `SPORTAL_LOG_LEVEL` |
| Shutdown | Each exporter's `shutdownTimeout` is 1 s, not Effect's 3 s, which alone would use the Hub's whole shutdown bound. An unreachable collector is tested in the process test |
| Resource | `service.name` `sportal-hub`; `service.version` from `HubConfig.version`; `service.instance.id` a UUID per process, so a live run's and a scenario run's metrics stay separate series in Prometheus; `sportal.mode` `live` or `scenario:<name>`, so a scenario run never mixes with a real one in Grafana |
| Polls as traces | Each poll in `Ingest` is a span, `Ingest.poll`, carrying `sportal.leagues` and `sportal.failed_leagues`, so the provider spans nest under it: `EspnProvider.slate` live, and `ScenarioProvider.slate`, made a span for this, in a scenario run |
| Metrics now | `sportal_poll_duration` (histogram), `sportal_provider_errors` (counter, by league); Prometheus names them `sportal_poll_duration_milliseconds_bucket` and `sportal_provider_errors_total`. Game actors add theirs in their own piece |
| Local backend | `telemetry/compose.yaml` runs `grafana/otel-lgtm:0.35.0`, compose project `sportal-telemetry`, with Grafana on `localhost:3000` and OTLP/HTTP on `localhost:4318`, both ports bound to `127.0.0.1`; data in a named volume so it survives a restart. `pnpm telemetry` starts it detached; `pnpm telemetry:down` stops it |
| Dashboard | `telemetry/dashboards/hub.json`, provisioned into Grafana by the compose file: Hub log volume by level, recent warnings and errors, poll duration, provider errors by league, and a table of poll traces (TraceQL, by mode) whose trace IDs open the trace. Every panel filters by a `mode` variable; Prometheus panels do so by joining `target_info` on job and instance. Later pieces add their own rows |
| Folder | `telemetry/` at the repo root holds the compose file, the provisioning file, and the dashboards: several files private to one concept |
| In dev | Export only when `SPORTAL_OTLP_URL` is set: `pnpm dev` stays as today; run `pnpm telemetry` and set the URL to use Grafana |
| Deployment | The home-box `compose.yaml` (hosting piece 2) runs the same image beside the Hub and sets `SPORTAL_OTLP_URL`; that is designed there |

## Failures

| What happens | Behaviour |
| --- | --- |
| The collector is down or unreachable | Effect's exporters drop each batch they cannot send, stop exporting for 60 s, then try again, logging only at Debug; the Hub carries on. `Telemetry` gives them an `HttpClient` that logs one warning, naming the URL, on the first transport failure (collector unreachable); a collector that answers with an error status is dropped at Debug only. Telemetry never stops or slows the Hub |
| The setting is not an `http:` or `https:` URL | The Hub stops at startup naming `SPORTAL_OTLP_URL` |

## Testing

| What | How |
| --- | --- |
| Setting | `HubConfig.test.ts`: absent gives none; a URL is read; anything else stops startup |
| Layer | With no URL, `Telemetry.layer` installs no exporter: the console logger and level are as today (the existing logging behaviour, unchanged). With a URL, spans, logs, and metrics reach a fake OTLP endpoint (an `HttpClient` test layer recording requests) with the resource attributes above |
| Polls | `Ingest.test.ts`: a poll produces one `Ingest.poll` span with the provider's span inside it |
| By hand | `pnpm telemetry`, then a scenario at 10× with `SPORTAL_OTLP_URL=http://localhost:4318`: the Hub dashboard fills, a poll's trace shows its provider calls, and logs filter by `sportal.mode`. A row in `docs/game-day-checklist.md` |

## Not in this piece

- Game actor metrics and dashboard rows: in [game actors](./2026-10-04-game-actors-design.md).
- Alerts. Grafana can alert later, once there are days of data to set thresholds from.
- Telemetry from the web UI or the desktop shell.
- The deployed backend: hosting piece 2.

## Documents that change

- `CONTEXT.md`: the row above.
- `AGENTS.md`: `SPORTAL_OTLP_URL` in the Hub settings line; `pnpm telemetry` in Commands.
- `docs/technical-spec.md`: the Hub's telemetry, where it describes logging.
- `docs/game-day-checklist.md`: the row above.
