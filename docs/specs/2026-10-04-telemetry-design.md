# Hub Telemetry — Design

Date: 2026-10-04
Status: Approved 2026-10-04

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
| Setting | `SPORTAL_OTLP_URL`, a field on `HubConfig`: the collector's OTLP/HTTP base URL (`http://localhost:4318`). Optional; unset exports nothing. Not a URL stops the Hub at startup, like every other setting |
| Where | `Logging.ts` becomes `Telemetry.ts`: one layer owning the log level, the console format, and, when the setting is present, the OTLP exporters. One concept, one file; `main.ts` provides it where it provides `Logging.layer` today |
| Exporters | Effect's own: `OtlpTracer`, `OtlpLogger`, and `OtlpMetrics` from `effect/observability`, over the `HttpClient` `main.ts` already provides. Pattern: `node_modules/effect/ai-docs/src/08_observability/20_otlp-tracing.ts`. No OpenTelemetry SDK |
| Console | Kept alongside the export, at the same level and format, so a terminal still shows what the Hub is doing |
| Resource | `service.name` `sportal-hub`; `service.version` from `HubConfig.version`; `sportal.mode` `live` or `scenario:<name>`, so a scenario run never mixes with a real one in Grafana |
| Polls as traces | Each poll in `Ingest` is a span, `Ingest.poll`, annotated with the leagues and whether any failed, so the existing `EspnProvider.slate` spans nest under it |
| Metrics now | `sportal_poll_duration` (histogram), `sportal_provider_errors` (counter, by league). Game actors add theirs in their own piece |
| Local backend | `telemetry/compose.yaml` runs `grafana/otel-lgtm` at a pinned tag, with Grafana on `localhost:3000` and OTLP/HTTP on `localhost:4318`, data in a named volume so it survives a restart. `pnpm telemetry` starts it detached; `pnpm telemetry:down` stops it |
| Dashboard | `telemetry/dashboards/hub.json`, provisioned into Grafana by the compose file: Hub log volume by level, recent warnings and errors, poll duration, provider errors by league, and a link to the poll traces. Later pieces add their own rows |
| Folder | `telemetry/` at the repo root holds the compose file, the provisioning file, and the dashboards: several files private to one concept |
| In dev | Export only when `SPORTAL_OTLP_URL` is set: `pnpm dev` stays as today; run `pnpm telemetry` and set the URL to use Grafana |
| Deployment | The home-box `compose.yaml` (hosting piece 2) runs the same image beside the Hub and sets `SPORTAL_OTLP_URL`; that is designed there |

## Failures

| What happens | Behaviour |
| --- | --- |
| The collector is down or unreachable | The exporters drop what they cannot send and the Hub carries on; one warning on the console, not one per batch. Telemetry never stops or slows the Hub |
| The setting is not a URL | The Hub stops at startup naming `SPORTAL_OTLP_URL` |

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
