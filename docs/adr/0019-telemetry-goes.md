# 19. Telemetry goes; the Hub logs to its console

Date: 2026-10-15
Status: Accepted

## Context

The Hub exported traces, logs and metrics over OTLP to a collector named by `SPORTAL_OTLP_URL`, and a Display shipped
its logs through the Hub's `/api/telemetry/logs` relay. `pnpm telemetry` started a local Grafana in Docker with the
Game Day, Game Detail and Hub dashboards, and the Director kept seven gauges per listed game for them, removing each
game's series when it left the slate.

That was the right tool while the feeds were being learned on game days. It is not something a person who installs the
app runs: there is no collector beside an installed app, and the gauges, the relay and the Docker stack were code and
setup that only the dashboards read.

## Decision

Remove the OTLP export, the web UI's log shipping and the Hub's relay for it, the Director's game gauges and
`sportal_hub_up`, `SPORTAL_OTLP_URL`, and the `telemetry/` stack with its scripts. The Hub keeps its console logs, at
`SPORTAL_LOG_LEVEL` and in `SPORTAL_LOG_FORMAT` (`Logging.ts`), and its `Effect.fn` spans, which cost nothing with no
tracer. The installed app writes the Hub's output to `hub.log`.

## Consequences

- The game-day checks that read a dashboard are retired; the ones that matter read the Hub's log instead.
- The Director only logs: each play a take adds, and each game's new moment.
- Observability can come back as an opt-in, export-only layer when it is needed again. The removed dashboards are in
  git.
