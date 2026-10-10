# Hub ownership pass — design

Status: approved 2026-10-10.

## Goal

Make `apps/hub/` easier to navigate without changing how the Hub behaves. Every production declaration and test should live with the concept that owns it, and each touched file should open on its main behavior.

The pass covers file ownership, declaration order, test ownership, and test harness placement. It does not redesign module interfaces.

## Baseline

At `1e048ee`, `pnpm check` passes with 41 test files and 995 tests. The Hub already has a sound high-level shape:

- root modules own process-level concepts (`Director`, `Slate`, `HubServer`, `HubConfig`, and `Telemetry`);
- `provider/` owns the game-data port and its ESPN adapter;
- `source/` owns the video-source port, guides, and its YouTube TV adapter;
- `provider/espn/` is ESPN's one earned concept folder;
- `source/youtube-tv/` keeps YouTube TV's wire vocabulary private.

The pass repairs local ownership problems instead of replacing this structure.

## Constraints

- Preserve service interfaces, HTTP routes, wire schemas, logs, metrics, durations, stream ordering, and runtime behavior.
- Preserve every existing test assertion. A rewritten test commit records each old test name and its destination or new name.
- Keep one `Name.test.ts` beside each production module. Do not create concern-suffixed test files such as `FastCastReconnect.test.ts`.
- Use only concept-named `Test*.ts` modules for builders, fixtures, composed harnesses, and test adapters. Do not add generic test folders or helper files.
- Do not expose production members only for tests.
- Apply the inside-file layout rules only to touched files; avoid repository-wide formatting churn.
- `pnpm check` passes before every implementation commit.

## Production ownership

### Provider and ProviderFeed

`apps/hub/src/provider/Provider.ts` currently exports two service classes. Split `ProviderFeed` into `apps/hub/src/provider/ProviderFeed.ts` so both files satisfy the one-class module rule.

- `Provider`, `Delivery`, and `Provider.layerTest` stay in `Provider.ts`.
- `ProviderFeed` keeps the same service id and member interface.
- `Provider.ts` imports the `ProviderFeed` value to construct the test layer.
- `ProviderFeed.ts` imports `Delivery` as a type. The type-only cycle is allowed and does not create a runtime cycle.
- The queue, deferred acknowledgement, frame ordering, and ending behavior stay unchanged.
- `Provider.test.ts` becomes `ProviderFeed.test.ts`, because its behaviors are `ProviderFeed#deliver` and `ProviderFeed#end`.

### FastCast

`ProviderUnavailable` is used only by `FastCast`. Move the unchanged tagged error into `FastCast.ts` and delete `ProviderUnavailable.ts`; class modules may keep their expected errors beside the main class.

`FastCast.make` is public but used only to construct `FastCast.layer`. Inline its unchanged effect into `layer`, leaving the service in house order:

1. service interface;
2. `layer`;
3. `layerTest`;
4. member types and errors;
5. private implementation.

Keep `FastCast.follow`, `Wanted`, retry schedules, silence and checkpoint durations, error tags, log text, and recovery semantics unchanged.

Do not create a nested FastCast folder. `FastCast`, `FastCastMessage`, `Frame`, `Topic`, `FastCastDocuments`, and `GameTopics` are collaborating ESPN concepts, not private files hidden behind one module interface.

### ESPN namespace consistency

`EspnEvent.ts` is a namespace module, so its callers import it as `import * as EspnEvent` and call `EspnEvent.listingOf` or `EspnEvent.teamId`.

Rename its private capitalized schema builder to lower camel case. Keep the shared ESPN team-id conversion in `EspnEvent.ts`: a one-function `EspnTeam.ts` would be a shallower module than the dependency it removes.

No decoder table, payload schema, or provider behavior changes.

### YouTube TV declaration order

Move `YouTubeTvGuide.decode` ahead of the supporting `source` constant so the namespace module opens on its primary behavior. The effect reads `source` lazily, so this is an ordering-only change.

### Test-only import boundary

Replace the incomplete collection of Hub test-module dependency rules with one rule that forbids production modules from importing any `apps/hub/src/**/Test*.ts`. Tests and other `Test*.ts` modules may import them.

Keep the narrower cross-package test rules where they express a different boundary.

## Test ownership

Tests follow the production pipeline:

1. `FastCast` turns socket and checkpoint traffic into `Frame` values.
2. `FastCastDocuments` folds frames into topic documents and `DocumentChange` values.
3. `GameTopics` decodes changed play entities and emits `Delivery.Plays`.
4. `EspnEvent` decodes scoreboards.
5. `EspnProvider` schedules polls, merges feeds, retains topics, and computes `Wanted`.
6. `GuideReader` owns guide publication and freshness.
7. `YouTubeTvGuide` decodes YouTube TV responses into `Guide` values.
8. `Source` exposes and combines availability streams.
9. `HubServer` publishes the shared slate and availability.

### FastCastDocuments gets its own suite

Create `apps/hub/src/provider/espn/FastCastDocuments.test.ts`. Move the document-state behaviors currently exercised through `GameTopics.test.ts`:

- applying a JSON Patch copy from its source;
- resetting after a missed message;
- ignoring patch and idle messages before a checkpoint;
- resetting when a patch cannot apply;
- resetting a synced topic when a moving message does not decode;
- emitting one reset for a gap, unapplicable patch, or undecodable message;
- not resetting a topic that was never synced;
- syncing again on a later valid checkpoint;
- keeping reset isolation to one topic;
- ignoring changes outside `/entities/plays` while keeping the topic synced.

Move the downstream document-reset assertion from `FastCast.test.ts` here. `FastCast.test.ts` retains the assertion that malformed patch traffic is framed with the correct topic and mid.

Remain in `GameTopics.test.ts`:

- Warning logs added by `GameTopics`;
- play decoding, identity preservation, ordering, and `Delivery.Plays`;
- one delivery array per frame;
- combined document/play retention;
- recorded play-delivery behavior.

Where one old test asserted both document and delivery behavior, split its assertions between the two owning suites and record both destinations in the commit body.

### ESPN decoder suites

Move the first scoreboard-transformation behaviors from `EspnProvider.test.ts` to `EspnEvent.test.ts`, invoking `EspnEvent.listingOf` directly:

- live FBS scoreboard decoding;
- television/streaming filtering;
- team location and short name;
- team colors and absent colors;
- placeholder values;
- NFL league and team-id namespacing;
- yard-line orientation.

Keep non-2xx handling, undecodable-poll handling, cadence, merge order, wanted topics, retention, and FastCast integration in `EspnProvider.test.ts`.

Move the recorded snapshot JSON round trip from `GameTopics.test.ts` to `EspnEvent.test.ts`, and the recorded play JSON round trip to `EspnPlay.test.ts`. Keep the cached full-game replay in `TestEspn.ts` so the expensive recording is decoded once.

### YouTube TV suites

Move decoder-owned behaviors from `GuideReader.test.ts` to `youtube-tv/YouTubeTvGuide.test.ts`:

- the recorded response's channels, live addresses, and airings;
- an invalid live id leaving a channel without a live address;
- safe decoder diagnostics that omit the response body;
- malformed JSON, non-guide JSON, and a guide with no channels.

Move the recorded ESPN/YouTube matching matrix from `Source.test.ts` into `YouTubeTvGuide.test.ts` as recorded adapter acceptance coverage.

Keep in `GuideReader.test.ts`:

- change publication;
- freshness and expiry;
- replacement and rejected-read state preservation;
- overlapping-read and interruption behavior.

Keep in `Source.test.ts`:

- no-guide mapping;
- one representative present-guide delegation behavior;
- Twitch behavior;
- `Source.layerAll` ordering and change propagation.

### Test harness modules

Move only concept-specific builders and composed harnesses:

- `TestFastCast.ts`: fake socket plus shared frame, checkpoint, and message builders;
- new `TestGameTopics.ts`: replaying frames and obtaining the resulting `GameTopics`;
- `TestYouTubeTv.ts`: recorded and one-row guide responses;
- new `TestHubServer.ts`: server layer composition, live-stream client, SSE decoding, and publication harness;
- new `TestGuide.ts`: reusable Guide and airing scenario builders;
- `TestEspn.ts`: recorded ESPN payloads and the cached full-game replay.

One-off assertion projections stay at the bottom of their owning test file. Do not add `TestHelpers.ts`, generic fixtures, or a shared test folder.

### Retained large suites

Large suites remain single files where one deep module genuinely owns many behaviors. Improve their table of contents with nested `describe` sections:

- `FastCast.test.ts`: connection, framing, wanted topics, checkpoints, recovery, reconnect;
- `EspnProvider.test.ts`: polling, merged deliveries, wanted topics, retention/integration;
- `HubServer.test.ts`: HTTP endpoints, SSE transport, settling, projection, guide integration.

Move `Director.test.ts`'s play-log suite above its helper appendix. Keep the Director, Slate, Guide, HubServer, and FastCast production modules intact.

## Physical result

```text
apps/hub/src/
├── Director.ts
├── HubServer.ts
├── Slate.ts
├── TestDirector.ts
├── TestHubServer.ts                 new
├── provider/
│   ├── Provider.ts
│   ├── ProviderFeed.ts              new, split from Provider.ts
│   ├── ProviderFeed.test.ts         renamed from Provider.test.ts
│   ├── TestProvider.ts
│   └── espn/
│       ├── Espn.ts
│       ├── EspnEvent.ts
│       ├── EspnPayload.ts
│       ├── EspnPlay.ts
│       ├── EspnProvider.ts
│       ├── FastCast.ts              absorbs ProviderUnavailable
│       ├── FastCastDocuments.ts
│       ├── FastCastDocuments.test.ts new
│       ├── FastCastMessage.ts
│       ├── Frame.ts
│       ├── GameTopics.ts
│       ├── TestEspn.ts
│       ├── TestFastCast.ts
│       ├── TestGameTopics.ts         new
│       └── Topic.ts
└── source/
    ├── Guide.ts
    ├── GuideReader.ts
    ├── Source.ts
    ├── TestGuide.ts                  new
    ├── TestSource.ts
    └── youtube-tv/
        ├── TestYouTubeTv.ts
        ├── YouTubeTvGuide.ts
        └── YouTubeTvPayload.ts
```

`ProviderUnavailable.ts` and `Provider.test.ts` no longer exist.

## Execution order

Each numbered unit is independently green and normally one commit.

1. **Baseline:** save affected test names and counts, Hub/workspace coverage, and the current `pnpm check` result.
2. **Provider module shape:** split `ProviderFeed`, rename its test, and enforce the general Hub test-module boundary.
3. **FastCast and local order:** absorb `ProviderUnavailable`, inline `FastCast.make`, normalize `EspnEvent` namespace imports, and reorder YouTube TV's main export.
4. **Document test ownership:** add `FastCastDocuments.test.ts`, shared FastCast/GameTopics test builders, and move document-state assertions before deleting their originals.
5. **ESPN test ownership:** move scoreboard transformations and recorded schema round trips.
6. **Source test ownership:** move YouTube TV decoding and recorded-adapter acceptance coverage.
7. **Harness and reading order:** extract `TestHubServer.ts` and `TestGuide.ts`, regroup large suites, and move Director's play-log suite.
8. **Documentation and final verification:** update paths, regenerate the technical tree, compare coverage, run the full check, and review the final diff for contract drift.

## Verification

### Baseline

Before edits:

- `pnpm check`;
- `pnpm coverage`;
- record the test names and assertion-bearing blocks in every rewritten test file.

The accepted design baseline is 41 passing test files and 995 passing tests.

### Focused checks

Run the smallest owning suite after each move, then its integration dependents:

- Provider: `ProviderFeed.test.ts`, `Director.test.ts`;
- FastCast documents: `FastCastDocuments.test.ts`, `GameTopics.test.ts`, `FastCast.test.ts`, `EspnProvider.test.ts`;
- ESPN decoders: `EspnEvent.test.ts`, `EspnPlay.test.ts`, `EspnProvider.test.ts`, `Espn.test.ts`;
- YouTube TV: `YouTubeTvGuide.test.ts`, `GuideReader.test.ts`, `Source.test.ts`, `HubServer.test.ts`;
- core harnesses: `Guide.test.ts`, `Director.test.ts`, `HubServer.test.ts`.

### Structural checks

The final tree must satisfy:

- `Provider.ts` exports only the `Provider` class plus its member type/value `Delivery`;
- `ProviderFeed.ts` owns the `ProviderFeed` class;
- no `ProviderUnavailable.ts` or `FastCast.make` remains;
- namespace modules touched by the pass are imported as namespaces;
- no production file imports a Hub `Test*.ts` module;
- no behavior-suffixed test files, generic helper files, or new barrels exist.

### Coverage and final gate

After the final move:

- run `pnpm coverage`;
- unchanged production files lose no line or branch coverage;
- manually pair coverage for `ProviderFeed` across its old and new path;
- confirm every old assertion appears in its commit's migration ledger;
- run `pnpm check`;
- inspect the final production diff for changes to wire shapes, routes, service interfaces, logs, metrics, durations, or ordering.

No live probe is required. The affected socket, polling, SSE, clock, guide, and shutdown lifecycles already have deterministic tests, and this pass intentionally changes no runtime contract.

## Rejected changes

- No root `services/`, `schemas/`, `helpers/`, or shared-test directory.
- No `director/`, `hub-server/`, or nested FastCast folder.
- No split of `Director`, `HubServer`, `Guide`, `FastCast`, `FastCastDocuments`, or `EspnProvider` merely to reduce line count.
- No generic league-decoder table helper or shared `noDeliveries` constant.
- No `EspnState`, persistence, recording, replay, or provider redesign.
- No new production export used only by tests.
- No deletion of cross-module acceptance assertions without an explicit destination.
