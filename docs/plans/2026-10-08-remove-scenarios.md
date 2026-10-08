# Remove scenarios: implementation plan

**Goal:** The Hub has one mode, the live day. Scenarios, scenario time and the synthetic stream page are gone, with
every constraint they put on the rest of the code, so offline play can be designed again from nothing.

## Constraints

- Branch `remove-scenarios` off main. The live Hub's behaviour does not change.
- Every test of a removed behaviour goes with it. Coverage of what stays is kept, notably the decoder, play and
  Director tests that read NE at BUF's recorded frames.
- `AGENTS.md` governs. Each task ends with `pnpm check` passing, and a commit.

---

## Task 1: The Hub plays only the live day

- [ ] Delete `apps/hub/src/scenario/` (`Scenarios`, `ScenarioClock`, `ScenarioSource`, their tests),
  `provider/espn/ScenarioProvider.ts` (+ test, and any file in `espn/fixtures/` that only it reads),
  `HubMode.test.ts`, and `main.test.ts`.
- [ ] `Espn.ts`: drop `layerScenario`. `HubMode.ts`: `layer` is the live wiring alone, without `Layer.unwrap`, the
  annotated `chosen`, or `HubConfig`.
- [ ] `HubConfig`: drop `scenario` (`SPORTAL_SCENARIO`) and `scenarioSpeed` (`SPORTAL_SCENARIO_SPEED`), plus their
  assertions and refusal cases in `HubConfig.test.ts`. The fixture `everySetting` loses them.
- [ ] `Telemetry`: drop the `sportal.mode` attribute and the test "should name a scenario's mode in the resource". Keep
  `service.instance.id`. Its comment changes to "two Hubs at once stay apart", and its test compares two live starts.
  The "live" assertion on `sportal.mode` goes.
- [ ] `Frame.movedTo` goes, since only `ScenarioProvider` used it.
- [ ] `TestEspn.ts`: `recordedNeAtBuf` reads `espn/fixtures/nfl-2026-10-04-ne-buf.frames.jsonl.gz` directly, as
  gunzipped lines each decoded as a `Frame`. This is a few lines over `Gzip` and `Schema.fromJsonString(Frame)`, and
  it imports nothing from `scenario/`. `EspnDecoder.test`, `EspnPlay.test` and `Director.test` keep every assertion.
- [ ] `Gzip.ts`'s doc names only FastCast's deflated patches. Remove `EspnPlay.ts:73`'s mention of the recorded
  scenarios.
- [ ] `.dependency-cruiser.cjs`: drop the `scenario/Scenario(Source|Clock)` and `ScenarioProvider` paths. If knip then
  reports a dependency as unused, drop it too.
- [ ] Commit `refactor(hub): the Hub plays only the live day`.

## Task 2: The synthetic stream page goes

- [ ] Web: delete `ScenarioStream.tsx` and `ScenarioStrip.tsx`, the `/scenario-stream/` route and its comment in
  `main.tsx`, and the `scenario-pan` keyframes in `theme.css`.
  - `TileRects.ts`: drop the doc's mention of a scenario stream. The resolution of a path against the page's origin
    goes too, unless a source other than scenarios still gives one; check before removing.
  - Rewrite `TileRects.test`'s "scenario stream's path" test, or remove it with that behaviour.
  - `TestScreen.ts`: its channel becomes a YouTube TV one.
- [ ] Domain: `SourceName` is only `"YouTube TV"`. Check whether `Channel.ts` still needs the literal union.
- [ ] Desktop: `ProviderSession`'s `allows` loses its exception for the UI's own `/scenario-stream/`, and its two
  scenario-stream test tables go. `ShellConfig`'s hub URL is still used for the UI.
- [ ] Commit `refactor: the synthetic stream page goes`.

## Task 3: Recordings, scripts, telemetry and docs

- [ ] Delete `fixtures/scenarios/`. `fixtures/espn-recordings/` stays as material for the redesign.
- [ ] `package.json`: drop `dev:golden`.
- [ ] `telemetry/dashboards/hub.json`: drop the `mode` variable, and the `sportal_mode="$mode"` filters from its
  queries.
- [ ] Docs:
  - ADR 0013, "Scenarios go; offline play is designed again". It supersedes ADR 0011, and ADR 0011's and ADR 0012's
    status lines say so.
  - `CONTEXT.md`: drop Scenario, Scenarios, Scenario unknown, Scenario unreadable and Scenario time. Hub mode goes
    unless the code still has a mode. Add "scenario" under Planned if it is to come back.
  - `AGENTS.md`: replace the `Scenario`/`ScenarioUnknown` and `Scenarios.layerFrom(dir)` examples with live ones (for
    instance `Provider`'s member types and `FramesDecoded.layerOf`). Drop the `SPORTAL_SCENARIO` and `dev:golden`
    command lines.
  - `docs/technical-spec.md`: drop the tree rows, the scenario mode in the Hub section, and `fixtures/scenarios`.
  - `docs/game-day-checklist.md`, rows 33 and 38: rewrite them against the live day, or remove them.
- [ ] `git grep -ni "scenario"` over `apps packages AGENTS.md CONTEXT.md docs/technical-spec.md telemetry
  package.json .dependency-cruiser.cjs knip.json` finds nothing except ADRs and history.
- [ ] Commit `docs: scenarios go`.

## Afterwards

- `pnpm dev` with no game on shows an empty slate. That is accepted until offline play is designed again.
- The Hub's process test returns with that design.
