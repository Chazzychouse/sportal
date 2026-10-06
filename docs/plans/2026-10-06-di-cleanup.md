# Dependency injection cleanup — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry out `docs/specs/2026-10-06-di-cleanup-design.md`. Services and settings are yielded where they are
used, never passed in. The Provider port splits into `Provider` and `Decoder`. FastCast becomes a service. The
desktop shell gets `ShellConfig` and `ShellWindow`.

**Architecture:** One branch `di-cleanup` in the worktree `../sportal-di-cleanup` (it already exists, with the spec
committed). Tasks 1–7 run in order, one `refactor:` commit each. Behaviour is preserved. The one new setting,
`SPORTAL_LEAGUES`, defaults to today's behaviour.

**Tech Stack:** Effect 4 (`effect`, `@effect/platform-node`), Electron, Vitest with `@effect/vitest`, Biome,
dependency-cruiser, knip, pnpm workspaces.

## Global constraints

- Read `AGENTS.md` and `CONTEXT.md` before any task. Their rules apply to every line written here.
- Effect 4 is newer than training data. Before writing Effect code, read `node_modules/effect/ai-docs/src/index.md`
  and the example it points to for the API at hand. Copy the patterns of the file you are editing. `HubMode.ts` is
  the model for a `Layer.unwrap` that chooses a layer at build time.
- `pnpm check` passes before every commit. Run single tests with `pnpm vitest run <path>`.
- All commits are `refactor:`. Existing tests keep their assertions. Only their setup changes, unless a step says
  otherwise.
- Nothing writes `X["Service"]` after Task 3. A member type another module needs is named and exported beside its
  service.
- No exported function or layer takes a `Context.Service` value or a setting as a parameter. The exceptions are
  listed in the spec's Scope.
- No export lives only for its tests (`knip --production`). Static members of a service class are fine.
- Every new exported type name gets its `CONTEXT.md` row in the same commit.
- Comments: doc comments on major exports. Inline comments only for a non-obvious why.
- No `any`, non-null assertions, enums, default exports, or casts outside decoding.
- This plan gives signatures and test cases. Write bodies from the code you are replacing. Do not import a pattern
  from memory.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Setup

- [ ] `cd ../sportal-di-cleanup && pnpm install --frozen-lockfile --prefer-offline`
- [ ] `pnpm check` should PASS. Every task below runs in `../sportal-di-cleanup`.

## File map

| File | Change |
|---|---|
| `apps/hub/src/HubConfig.ts` | + `leagues` (`SPORTAL_LEAGUES`) |
| `apps/hub/src/ingest/Ingest.ts` | `layer` constant; yields `HubConfig`, `Provider`, `Decoder` |
| `apps/hub/src/scenario/ScenarioClock.ts` | `layer` constant; yields `HubConfig` |
| `apps/hub/src/HubMode.ts` | no arguments threaded; wires `Provider \| Decoder` layers |
| `apps/hub/src/provider/Provider.ts` | loses `decode`; + exported `Polling` type |
| `apps/hub/src/provider/Decoder.ts` | own `decode` signature |
| `apps/hub/src/provider/espn/EspnDecode.ts` | exports only `layer` |
| `apps/hub/src/provider/espn/EspnProvider.ts` | `Layer<Provider \| Decoder, never, FastCast>` |
| `apps/hub/src/provider/espn/FastCast.ts` | becomes the `FastCast` service |
| `apps/hub/src/scenario/ScenarioProvider.ts` | `Layer<Provider \| Decoder, …, HubConfig \| RecordedScenarios \| Decoder>` |
| `apps/hub/src/provider/TestProvider.ts` | builds `Layer<Provider \| Decoder>`; + `decoder` |
| `apps/desktop/src/main/ShellConfig.ts` | new service |
| `apps/desktop/src/main/ShellWindow.ts` | new service (today's `openWindow`) |
| `apps/desktop/src/main/{ProviderSession,TileViews,GuideReader,main}.ts` | yield instead of take |
| `AGENTS.md`, `CONTEXT.md` | one rule; rows for Provider, Decoder, FastCast, Checkpoint error, Shell config, Shell window |

---

### Task 1: Ingest's leagues come from HubConfig

**Files:**
- Modify: `apps/hub/src/HubConfig.ts`, `apps/hub/src/HubConfig.test.ts`
- Modify: `apps/hub/src/ingest/Ingest.ts`, `apps/hub/src/ingest/Ingest.test.ts` (`over`)
- Modify: `apps/hub/src/HubMode.ts` (both `Ingest.layer(LeagueId.literals)` calls)
- Modify: `apps/hub/src/hub-server/HubServer.test.ts` (`hubUnderTest`), `apps/hub/src/scenario/ScenarioProvider.test.ts` (`ingestOver`)

**Interfaces:**
- Produces: `HubConfig["leagues"]: ReadonlyArray<LeagueId>`, a non-empty list from `SPORTAL_LEAGUES`
  (comma-separated, surrounding spaces ignored), defaulting to `LeagueId.literals`.
- Produces: `Ingest.layer: Layer.Layer<never, never, HubConfig | Provider | FeedLog | LiveGames | …>`, a constant.
  (Its other requirements stay as today. `Decoder` joins them in Task 3.)

- [ ] **Step 1: Write the failing tests** in `HubConfig.test.ts`:
  - "has a default for every setting": add `leagues` equal to `LeagueId.literals`.
  - "reads each setting": `SPORTAL_LEAGUES: "fbs"` reads `["fbs"]`, and `" nfl , fbs "` reads `["nfl", "fbs"]`
    (add whichever of the two fits the existing table, and the other as its own case).
  - The "refuses NAME=value, naming the setting" table: add `SPORTAL_LEAGUES=mlb` (unknown league) and
    `SPORTAL_LEAGUES=` (empty).
- [ ] **Step 2:** `pnpm vitest run apps/hub/src/HubConfig.test.ts` should FAIL (no `leagues`).
- [ ] **Step 3:** Add the field. Decode it with `Config.schema` as the neighbouring fields do: a Schema from the
  string to a non-empty array of `LeagueId`. Check `ai-docs` for the Effect 4 way to split a string in a Schema
  transformation. Put a doc comment on the field naming the variable and its default.
- [ ] **Step 4:** HubConfig tests should PASS.
- [ ] **Step 5:** Make `Ingest.layer` a constant that reads `const { leagues } = yield* HubConfig` first. Update its
  callers:
  - `HubMode` calls `Ingest.layer`. HubConfig is already provided above HubMode in `main.ts`.
  - `Ingest.test.ts` `over`: remove `Ingest.layer(options.leagues ?? ["fbs"])` and provide
    `withEnv({ SPORTAL_LEAGUES: (options.leagues ?? ["fbs"]).join(",") })` from `TestHubConfig.ts` (with
    `Layer.orDie`, as `ScenarioProvider.test.ts` does).
  - `HubServer.test.ts`: `hubUnderTest` already provides `withEnv`, so add `SPORTAL_LEAGUES: "fbs"` to that env.
  - `ScenarioProvider.test.ts`: `ingestOver` gets HubConfig from the `scenario` layer's `provideMerge(withEnv…)`.
    Check that it reaches `Ingest.layer`. If it does not, move the `withEnv` up to `ingestOver`. Leagues stay at the
    default.
- [ ] **Step 6:** `pnpm check` should PASS. Every Ingest, HubServer and ScenarioProvider test is unchanged.
- [ ] **Step 7:** Commit `refactor(hub): Ingest's leagues are a HubConfig setting`.

### Task 2: ScenarioClock yields its speed

**Files:**
- Modify: `apps/hub/src/scenario/ScenarioClock.ts`, `ScenarioClock.test.ts`
- Modify: `apps/hub/src/HubMode.ts` (`scripted` takes no argument; `layer` stops destructuring `scenarioSpeed`)
- Modify: `apps/hub/src/scenario/ScenarioProvider.test.ts:219`

**Interfaces:**
- Produces: `ScenarioClock.layer: Layer.Layer<Clock.Clock, never, HubConfig>`, a constant that reads
  `scenarioSpeed`. The doc comment says "runs `SPORTAL_SCENARIO_SPEED` times faster".

- [ ] **Step 1:** Change both `ScenarioClock.test.ts` cases to build
  `ScenarioClock.layer.pipe(Layer.provide(withEnv({ SPORTAL_SCENARIO_SPEED: "10" }).pipe(Layer.orDie)))`.
  Keep the assertions (60 000 then 70 000, and the sleeper waking).
- [ ] **Step 2:** Run the test. It should FAIL to typecheck (`layer` is a function).
- [ ] **Step 3:** Make `layer` a constant that yields `HubConfig`. In `HubMode`, `scripted()` takes no arguments and
  provides `ScenarioClock.layer`. `HubMode.layer` keeps only `const { scenario } = yield* HubConfig` and the
  `Option.match`.
- [ ] **Step 4:** In `ScenarioProvider.test.ts:219`, `Layer.provide(ScenarioClock.layer(10))` becomes
  `ScenarioClock.layer` with `SPORTAL_SCENARIO_SPEED: "10"` in that test's `env`. Its HubConfig must be the one the
  clock reads. Check the order of `provide` calls.
- [ ] **Step 5:** `pnpm check` should PASS.
- [ ] **Step 6:** Commit `refactor(hub): ScenarioClock reads its speed from HubConfig`.

### Task 3: Provider and Decoder split

**Files:**
- Modify: `apps/hub/src/provider/Provider.ts`, `Decoder.ts`, `TestProvider.ts`
- Modify: `apps/hub/src/provider/espn/EspnDecode.ts`, `EspnDecode.test.ts`, `EspnProvider.ts`, `EspnProvider.test.ts`
- Modify: `apps/hub/src/scenario/ScenarioProvider.ts`, `ScenarioProvider.test.ts`
- Modify: `apps/hub/src/ingest/Ingest.ts`, `Ingest.test.ts`
- Modify: `apps/hub/src/HubMode.ts`
- Modify: `apps/hub/src/LiveGames.replay.test.ts` (`deliveriesOf` decodes through `Decoder`; see Task 5 for its other
  argument)
- Modify: every other user of `TestProvider` (`Slate.test.ts`, `LiveGames.test.ts`, `GameHistory.test.ts`,
  `hub-server/HubServer.test.ts`, `source/youtube-tv/YouTubeTv.test.ts`). Find them with `rg TestProvider apps/hub`.
- Modify: `CONTEXT.md` (Provider row loses "its decode"; Decoder row: "the one home of a provider's decode, which its
  adapter provides beside it, …")

**Interfaces:**
- Produces, in `Provider.ts`:
  ```ts
  export type Polling = Schedule.Schedule<
    unknown,
    { readonly slate: ReadonlyArray<GameSnapshot>; readonly failed: ReadonlyArray<LeagueId> }
  >
  export class Provider extends Context.Service<Provider, {
    poll(league: LeagueId): Effect.Effect<FeedFrame, ProviderError>
    push(leagues: ReadonlyArray<LeagueId>, wanted: Stream.Stream<ReadonlyArray<GameSnapshot>>,
         resync: Stream.Stream<string>): Stream.Stream<FeedFrame, ProviderError>
    readonly polling: Polling
  }>()("sportal/hub/Provider") {}
  ```
  `Decoded`, `Notice` and `ProviderError` are unchanged.
- Produces, in `Decoder.ts`:
  `Decoder: Context.Service<{ decode(frames: Stream.Stream<Frame>): Stream.Stream<Decoded> }>`. The doc comment from
  today's `Provider.decode` moves here.
- Produces: `EspnDecode.layer: Layer.Layer<Decoder>`. `decode` is no longer exported.
- Produces: `EspnProvider.layer: Layer.Layer<Provider | Decoder, never, HttpClient.HttpClient | Socket.WebSocketConstructor>`.
  It merges `EspnDecode.layer`. Task 4 changes its requirements to `FastCast`.
- Produces:
  `ScenarioProvider.layer: Layer.Layer<Provider | Decoder, ScenarioUnknown | ScenarioUnreadable, HubConfig | RecordedScenarios | Decoder>`.
  A written scenario provides its own slate decoder. A recorded one yields `Decoder` and provides it on. The doc
  comment says both.
- Produces: `Ingest.layer` requires `Decoder` too, and calls `(yield* Decoder).decode` where it called
  `provider.decode`.
- Produces, in `TestProvider.ts`:
  - `decoder: Layer.Layer<Decoder>`: today's `polling(...).decode` (the private `said` logic).
  - `polling(games, options?): Layer.Layer<Provider | Decoder>` and
    `scripted(responses, options?): Layer.Layer<Provider | Decoder>`, each merged with `decoder`.
  - `options: { readonly polling?: Polling; readonly push?: () => Stream.Stream<FeedFrame, ProviderError> }`, with
    the push signature inline (the tests' pushes ignore their arguments).
  - `listedBy(league)` yields `Provider` and `Decoder`.

- [ ] **Step 1: Make the tests use the new shape first** (they will not compile yet):
  - `Ingest.test.ts`:
    - `ingesting` and `over` take `Layer.Layer<Provider | Decoder>`.
    - Every `Layer.succeed(Provider, polling(…))` becomes `polling(…)`.
    - `counting` becomes `Layer.mergeAll(Layer.succeed(Provider, …never polls…), Layer.succeed(Decoder, …the counting decode…))`.
    - `espnDecoding` becomes a failing `Provider` merged with `EspnDecode.layer`.
    - `feeding` drops its `Provider["Service"]["push"]` annotation.
    - `pollOf(games)` becomes `Effect.flatMap(Provider.asEffect(), (p) => p.poll("fbs")).pipe(Effect.provide(polling(() => Effect.succeed(games))), Effect.orDie)`.
      Use whatever accessor the file already uses for a service. `TestProvider.taken` uses `LiveGames.use`.
  - `HubServer.test.ts`: `Layer.succeed(Provider, polling(…))` becomes `polling(…)`.
  - `ScenarioProvider.test.ts`: `Options.decode` becomes `decoder?: Layer.Layer<Decoder>`. `scenario()` provides
    `options.decoder ?? EspnDecode.layer`. `slates` becomes `TestProvider.decoder`. The call sites pass
    `{ decoder: slates }`.
  - `EspnDecode.test.ts` `outputs` and `LiveGames.replay.test.ts` `deliveriesOf`: decode through
    `Decoder.use((d) => …)` or a yield, with `EspnDecode.layer` provided. Keep the stream they return as an
    `Effect`/`Stream` that requires `Decoder`, and provide `EspnDecode.layer` once at the test's top level.
  - `EspnProvider.test.ts`: if it reads `decode` off the provider, read it from `Decoder`.
- [ ] **Step 2:** `pnpm typecheck` (or `pnpm check`) should FAIL only where production code still has the old
  shape.
- [ ] **Step 3:** Change the production files to the interfaces above:
  - `Provider.ts`, `Decoder.ts`.
  - `EspnDecode.ts`: drop the `export` on `decode` and its `Provider["Service"]` annotation. `layer` stays.
  - `EspnProvider.ts`: drop `decode` from `Provider.of` and `Layer.merge` `EspnDecode.layer` into the result.
  - `ScenarioProvider.ts`: `Layer.unwrap` over today's `Effect.gen`. The written branch returns
    `Layer.mergeAll(Layer.succeed(Provider, …), Layer.succeed(Decoder, …slates decode…))`. The recorded branch
    yields `Decoder` itself (`playedRecorded` takes no `decode`) and returns `Provider` merged with
    `Layer.succeed(Decoder, decoder)`.
  - `ofSlates` returns the poll-only `Provider` and the slate decoder separately, as two values, so both branches
    stay readable. `pollingAt` and `ofSlates` use `Polling`.
  - `Ingest.ts`: yield `Decoder`.
  - `HubMode.ts`: `live()` provides `EspnProvider.layer` (no separate decode layer). `scripted()` provides
    `ScenarioProvider.layer.pipe(Layer.provide([RecordedScenarios.layer, EspnDecode.layer]))` as today. The
    scenario layer's own `Decoder` output is what Ingest sees.
  - `TestProvider.ts` as above.
- [ ] **Step 4:** `rg '\["Service"\]' apps/hub/src` finds only `LiveGames.replay.test.ts` (`heldAs`, which goes in
  Task 5) and `FastCast` (Task 4), if any.
- [ ] **Step 5:** `pnpm check` should PASS. The written and recorded scenario tests in `ScenarioProvider.test.ts`
  and every Ingest test keep their assertions.
- [ ] **Step 6:** Update the two `CONTEXT.md` rows.
- [ ] **Step 7:** Commit `refactor(hub): the Provider port is the feed; Decoder alone decodes`.

### Task 4: FastCast is a service

**Files:**
- Modify: `apps/hub/src/provider/espn/FastCast.ts`, `FastCast.test.ts`
- Modify: `apps/hub/src/provider/espn/EspnProvider.ts`, `EspnProvider.test.ts`
- Modify: `apps/hub/src/HubMode.ts` (`live()` provides `FastCast.layer`, over `NodeSocket.layerWebSocketConstructorWS`, to `EspnProvider.layer`)
- Modify: `CONTEXT.md` (new **FastCast** row: "ESPN's live feed, as the ESPN provider's push: one socket following
  each league's scoreboard and each wanted game, with its checkpoint retry". The **Checkpoint error** row names
  `checkpointRetry` on FastCast.)

**Interfaces:**
- Produces, in `FastCast.ts` (service declaration, its layer, then private helpers, in that order):
  ```ts
  export class FastCast extends Context.Service<FastCast, {
    push(leagues: ReadonlyArray<LeagueId>, wanted: Stream.Stream<ReadonlyArray<GameSnapshot>>,
         resync: Stream.Stream<string>): Stream.Stream<FeedFrame, ProviderError>
    /** How a topic whose checkpoint failed is followed again. */
    readonly checkpointRetry: Schedule.Schedule<unknown, CheckpointError>
  }>()("sportal/hub/FastCast") {
    /** FastCast following topics again on `checkpointRetry`. */
    static readonly make: (checkpointRetry: Schedule.Schedule<unknown, CheckpointError>) =>
      Effect.Effect<FastCastShape, never, HttpClient.HttpClient | Socket.WebSocketConstructor>
    // FastCastShape stands for the shape above. In code, leave make's return type to inference from FastCast.of.
    /** Every 30 s, five tries in all, then left to polling. */
    static readonly layer: Layer.Layer<FastCast, never, HttpClient.HttpClient | Socket.WebSocketConstructor>
  }
  ```
  `make`'s return type is left to inference from `FastCast.of`. Do not write an indexed type for it. Inside `make`,
  yield the two clients once and give `push`'s stream the context with `Stream.provideContext`, the way
  `EspnProvider` does today. That capture moves here from `EspnProvider`. `connect` takes the retry from `make`'s
  closure. `CheckpointError` stays exported. The module-level `checkpointRetry` constant and the exported `push`
  function go away.
- Produces: `EspnProvider.layer: Layer.Layer<Provider | Decoder, never, FastCast | HttpClient.HttpClient>`. It does `const fastCast = yield* FastCast`
  and `push: fastCast.push`. Its `Effect.context` capture and its `WebSocketConstructor` requirement go away. The
  poll still yields `HttpClient`.

- [ ] **Step 1:** In `FastCast.test.ts`, `nflFrames(server, checkpointRetry = <the 30 s schedule>)` builds the
  service with `FastCast.make(checkpointRetry)` (provided `fastCast(server)` as today) and calls `.push(["nfl"], …)`.
  Tests that pass a short retry keep passing it to `nflFrames`. The default case uses `FastCast.layer` instead of
  restating the schedule. Assertions are unchanged.
- [ ] **Step 2:** `EspnProvider.test.ts` provides `FastCast.layer` (over the fakes it already provides) under
  `EspnProvider.layer`.
- [ ] **Step 3:** Run both test files. They should FAIL to compile.
- [ ] **Step 4:** Implement `FastCast` and the `EspnProvider` change. In `HubMode.live()`:
  `EspnProvider.layer.pipe(Layer.provide(FastCast.layer), Layer.provide(NodeSocket.layerWebSocketConstructorWS))`.
- [ ] **Step 5:** `pnpm check` should PASS. `knip --production` must not flag `FastCast.make` (it is a static the
  layer uses).
- [ ] **Step 6:** Commit `refactor(hub): FastCast is a service that owns its checkpoint retry`.

### Task 5: Test helpers yield their services

**Files:**
- Modify: `apps/hub/src/LiveGames.replay.test.ts` (`deliveriesOf`, `heldAs`)
- Modify: `apps/hub/src/ingest/Ingest.test.ts:380` (`Context.get(services, FeedLog)`)

**Interfaces:**
- Produces (test-private): `deliveriesOf(from?)`: a stream that requires `FeedLog | Decoder`. `heldAs(held)`: an
  `Effect<void, never, LiveGames>`.

- [ ] **Step 1:** Rewrite each helper to yield (`FeedLog`, `Decoder`, `LiveGames`) instead of taking a service.
  Update the call sites (`:169`, `:180`, `:181`, `:182`, `:206`). If a call site runs where the service is not in
  context (inside a `Layer.build` result), provide it from the built context there, once, rather than threading the
  value.
- [ ] **Step 2:** In `Ingest.test.ts:380`, replace `Context.get(services, FeedLog)` with a yield inside an
  `Effect.provide` of the built layer, if the test's shape allows it. If the test checks *which* instance (the
  merged one), keep `Context.get` and leave a one-line reason. A built context is not a service passed as an
  argument.
- [ ] **Step 3:** `pnpm vitest run apps/hub/src/LiveGames.replay.test.ts apps/hub/src/ingest/Ingest.test.ts` should
  PASS with unchanged assertions.
- [ ] **Step 4:** `rg '\["Service"\]' apps packages` should find nothing outside `node_modules`.
- [ ] **Step 5:** `pnpm check`, then commit `refactor(hub): test helpers yield the services they read`.

### Task 6: Desktop shell — ShellConfig and ShellWindow

**Files:**
- Create: `apps/desktop/src/main/ShellConfig.ts`, `apps/desktop/src/main/ShellWindow.ts`
- Modify: `apps/desktop/src/main/main.ts`, `ProviderSession.ts`, `TileViews.ts`, `GuideReader.ts`
- Modify: `ProviderSession.test.ts`, `TileViews.test.ts`, `GuideReader.test.ts`
- Modify: `CONTEXT.md` (**Shell config**: "Every setting the desktop shell reads from its environment: the Hub's
  address"; **Shell window**: "The shell's one window, showing the Hub's web UI, confined to the Hub's origin")

**Interfaces:**
- Produces:
  ```ts
  export class ShellConfig extends Context.Service<ShellConfig, { readonly hubUrl: string }>()("sportal/desktop/ShellConfig") {
    /** SPORTAL_HUB_URL, default http://127.0.0.1:4400. */
    static readonly layer: Layer.Layer<ShellConfig, Config.ConfigError>
  }
  export class ShellWindow extends Context.Service<ShellWindow, BrowserWindow>()("sportal/desktop/ShellWindow") {
    /** Today's openWindow: acquired with the layer, destroyed with it, confined to the Hub's origin. */
    static readonly layer: Layer.Layer<ShellWindow, never, ShellConfig>
  }
  ```
  Check `ai-docs` for the Config error type's Effect 4 name.
- Produces: `ProviderSession.layer: Layer.Layer<ProviderSession, never, ShellConfig | ShellWindow>`, a constant.
  `openSignIn: Effect.Effect<void>` (no `parent`; the layer yields `ShellWindow` and uses it as the parent).
- Produces: `TileViews.layer: Layer.Layer<TileViews, never, ProviderSession | ShellWindow>`, a constant. Its inline
  structural window type goes away.
- Produces: `GuideReader`: `readGuide()` and `send(url, init)` are private and yield `ProviderSession`. The layer's
  requirements are unchanged.
- Produces: `main.ts`. `Shell` keeps the readiness and Widevine waits, then returns
  `Layer.effectDiscard(serveHub).pipe(Layer.provide([TileViews.layer, GuideReader.layer]), Layer.provideMerge(ProviderSession.layer), Layer.provideMerge(ShellWindow.layer), Layer.provideMerge(ShellConfig.layer))`
  or the equivalent `provide` chain. `serveHub` is a constant `Effect` that yields `ShellWindow` and `ShellConfig`.
  `forward(channel, stream)` and `listen(channel, handler)` yield `ShellWindow`.

- [ ] **Step 1: Tests first.**
  - `ProviderSession.test.ts`: the layer is
    `ProviderSession.layer.pipe(Layer.provide([Layer.succeed(ShellConfig, ShellConfig.of({ hubUrl: ui })), Layer.succeed(ShellWindow, shell)]))`.
    `shell` is the mocked `new BrowserWindow(…)` it already makes. `providers.openSignIn(shell)` becomes
    `providers.openSignIn`. The `parent` assertion (`toBe(shell)`) stays.
  - `TileViews.test.ts`: add a `BrowserWindow` class to its `vi.mock("electron")` carrying `contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }`
    and `isDestroyed: () => false`. `fakeWindow()` becomes `new BrowserWindow({})` from the mock. Provide it as
    `ShellWindow`, and provide `ShellConfig` for `ProviderSession`. The `window.contentView.*` assertions stay.
  - `GuideReader.test.ts`: provide `ShellConfig` and a mocked `ShellWindow` under `ProviderSession.layer`. Add a
    `BrowserWindow` to its mock if it lacks one.
- [ ] **Step 2:** `pnpm vitest run apps/desktop` should FAIL to compile.
- [ ] **Step 3:** Create `ShellConfig.ts` and `ShellWindow.ts`. Move `openWindow` into `ShellWindow.layer` as is
  (sandboxed preload, `confine` to the Hub origin, `acquireRelease` destroy).
- [ ] **Step 4:** Change `ProviderSession`, `TileViews`, `GuideReader` and `main.ts` to the interfaces above. The
  private `allows(url, ui)` helper in `ProviderSession` keeps its `ui` argument: it is a pure function of a value
  read from `ShellConfig` in the layer.
- [ ] **Step 5:** `pnpm check` should PASS.
- [ ] **Step 6:** Commit `refactor(desktop): the shell's address and window are services`.

### Task 7: The rule, and verification

**Files:**
- Modify: `AGENTS.md` ("How code is written")

- [ ] **Step 1:** Add after the "A service is yielded where it is used…" bullet: *A port's member types that other
  modules need are named and exported beside it (`Polling`). Nothing indexes a service's type with `X["Service"]`.*
  Also update that bullet to name the desktop: "…a layer that needs a setting yields `HubConfig` (in the shell,
  `ShellConfig`)…".
- [ ] **Step 2:** Run the checks:
  - `rg '\["Service"\]' apps packages -g '!node_modules'` should find nothing.
  - `rg 'static readonly layer = \(|export const layer = \(' apps` should find nothing. (`Database.at` and
    `fileInDataDir` are `function`s and are expected.)
  - `pnpm check` should PASS.
- [ ] **Step 3:** Commit `docs(agents): name a port's shared member types; never index X["Service"]`.
- [ ] **Step 4:** Ask the user to run, from the worktree:
  `SPORTAL_SCENARIO=<a recorded scenario> SPORTAL_SCENARIO_SPEED=10 pnpm dev` and confirm that games play and the
  shell opens, signs in and tiles as before. The agent shell misreports Electron on this machine.
- [ ] **Step 5:** `plannotator review` on the branch. Then use superpowers:finishing-a-development-branch.

---

## Not changed, on purpose

- `apps/web/src/hub/HubClient.test.ts` `onHub(client)`: a combinator over an `HttpClient` the test builds, not a
  service passed in. (The spec listed it. On reading, it already composes into a `Layer.succeed`.)
- `LiveGames.test.ts` `sleeping(sleep(…, clock, …))`: it is a fake Clock's own sleep.
- `Database.at`/`fileInDataDir`, `NodeHttpServer.layer({ port, host })`, `HttpStaticServer.layer({ root })`,
  `TestHubConfig.inEnv`, and test harnesses taking layers.
