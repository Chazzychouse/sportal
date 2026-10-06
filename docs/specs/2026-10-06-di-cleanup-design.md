# Dependency injection cleanup — design

Status: approved in brainstorming, 2026-10-06.

AGENTS.md says a service is yielded where it is used, never passed as an argument, and a layer that needs a
setting yields its config. The code mostly keeps that rule, but not everywhere: scenario speed and the
leagues to ingest are passed into layers, a recorded scenario is handed the decoder's method, FastCast is
handed its retry policy, and the desktop shell threads its Hub address and its window through every layer.
The Provider port has a second problem. Other modules name its parts by indexing it
(`Provider["Service"]["decode"]`, about a dozen times), and `decode` is declared twice, on `Provider` and
on `Decoder`. Every change to the port ripples through those indexed types. This spec fixes both.

## Scope

- **In:** the Hub's Provider port, FastCast, ScenarioProvider, ScenarioClock, Ingest and HubMode; the
  desktop shell's `main.ts`, `ProviderSession`, `TileViews` and `GuideReader`; test helpers that take a
  service value; one AGENTS.md rule and the CONTEXT.md rows the new names need.
- **Behaviour is preserved.** One new setting, `SPORTAL_LEAGUES`, whose default is today's behaviour.
- **Out:** `Database.at(filename)` (a constant for each store, not a setting); platform layers that take
  values (`NodeHttpServer.layer`, the static server's root); test harnesses that take *layers* as fixtures
  (`ingesting(providerLayer)`, `TestHubConfig.inEnv`). Those compose layers and do not pass a service. The
  web app is already clean.

## Delivery

One branch, `di-cleanup`, in the worktree `../sportal-di-cleanup`. The plan's phases are commits on it, each
passing `pnpm check`, all `refactor:`. Then `plannotator review` on the branch, and one merge to main. The
MLB branch rebases on top of it afterwards, so its spec's mention of "one Provider port" becomes two
services: `Provider` and `Decoder`.

## 1. The Provider port splits into Provider and Decoder

| Service | Members | Glossary |
|---|---|---|
| `Provider` | `poll(league)`, `push(leagues, wanted, resync)`, `polling: Polling` | **Provider** loses "its decode" |
| `Decoder` | `decode(frames): Stream<Decoded>` | **Decoder** becomes the one home of a provider's decode |

- `Provider.ts` exports a named type `Polling`, the Schedule from the slate and the failed leagues. Polling
  is already a glossary term. `Decoded`, `Notice` and `ProviderError` stay where they are.
- `Decoder.ts` writes out its own `decode` signature. It imports nothing from `Provider.ts` except
  `Decoded`.
- Nothing anywhere writes `X["Service"]`. AGENTS.md says so (see §5).

**Ingest** yields `Provider` and `Decoder`. Its replay-then-live decode goes through `Decoder.decode`
unchanged.

**EspnDecode** exports only `layer: Layer<Decoder>`. Its `decode` stays the private function the layer is
built from, and `EspnDecode.test.ts` yields `Decoder` from that layer.

**EspnProvider.layer** is `Layer<Provider | Decoder, never, FastCast>`. "ESPN as the provider" is its feed
and its decode together, so HubMode wires one layer for ESPN.

**ScenarioProvider.layer** is
`Layer<Provider | Decoder, ScenarioUnknown | ScenarioUnreadable, HubConfig | RecordedScenarios | Decoder>`:

- A *written* scenario provides its own `Decoder` (today's slate-as-JSON decode from `ofSlates`) beside its
  `Provider`.
- A *recorded* scenario yields the `Decoder` it is given (ESPN's, from HubMode) and provides it on unchanged.
  The layer both needs and provides `Decoder`. That is legal, `Layer.provide` resolves it, and the doc
  comment says so. `playedRecorded` stops taking `decode` as an argument.
- `ofSlates` and `pollingAt` take and return `Polling`, not indexed types.

**TestProvider** builds a `Layer<Provider | Decoder>`. Its push and polling options are typed with `Polling`
and with the push member's own signature, named once in the test file where it is needed.

## 2. FastCast becomes a service

```
FastCast: Context.Service<{
  push(leagues, wanted, resync): Stream<FeedFrame, ProviderError>
  readonly checkpointRetry: Schedule<unknown, CheckpointError>
}>
FastCast.layer: Layer<FastCast, never, HttpClient | Socket.WebSocketConstructor>
```

- The layer yields `HttpClient` and `WebSocketConstructor` once, and its `push` closes over them. The
  policy (every 30 s, five tries in all) is the layer's own value of `checkpointRetry`. `connect` reads it
  from the service it is part of, not from an argument.
- `EspnProvider` yields `FastCast`. Its `Effect.context` / `Stream.provideContext` capture goes away.
- `FastCast.test.ts` builds the service with a short retry (a test layer beside the real one, in the test
  file) instead of passing `checkpointRetry` to `push`.
- **FastCast** gets a glossary row (the ESPN live feed adapter), and **Checkpoint error**'s row says the
  retry is FastCast's `checkpointRetry`.

## 3. Settings come from HubConfig

- `ScenarioClock.layer` is a constant. It yields `HubConfig.scenarioSpeed`.
- `HubMode`'s `scripted()` takes no arguments. Only the `Option.match` on `scenario` stays in
  `HubMode.layer`.
- `HubConfig` gains `leagues: ReadonlyArray<LeagueId>`, read from `SPORTAL_LEAGUES` (comma-separated)
  with every `LeagueId` as the default. An unknown league stops the Hub at startup, like every bad setting.
  `Ingest.layer` is a constant that yields it. Ingest's tests set it to `fbs` through `TestHubConfig`
  instead of passing `["fbs"]`. When MLB lands, `mlb` joins the default with no change to Ingest.
- AGENTS.md's settings list (via HubConfig) needs no edit. The variable is documented on its field.

## 4. Desktop shell

| Service | What it is | Layer needs |
|---|---|---|
| `ShellConfig` (new) | `hubUrl`, from `SPORTAL_HUB_URL`, default `http://127.0.0.1:4400` | — |
| `ShellWindow` (new) | the shell's `BrowserWindow`: today's `openWindow`, acquired and released with the layer, confined to the Hub's origin | `ShellConfig` |
| `ProviderSession` | unchanged members, except `openSignIn` stops taking `parent` | `ShellConfig`, `ShellWindow` |
| `TileViews` | unchanged members | `ProviderSession`, `ShellWindow` |
| `GuideReader` | unchanged members | `ProviderSession` |

- `ProviderSession.layer` and `TileViews.layer` become constants.
- `ShellWindow`'s service is the `BrowserWindow` itself. Tests already mock `electron`
  (`ProviderSession.test.ts` mocks `BrowserWindow`), so `TileViews.test.ts` and `ProviderSession.test.ts`
  provide `Layer.succeed(ShellWindow, new BrowserWindow(…))` from that mock. The mocked class carries the
  `contentView` spies `TileViews.test.ts` asserts on today. No cast is needed, and `TileViews` no longer
  declares its own structural window type.
- `ProviderSession.test.ts` asserts the sign-in window's `parent` is the provided `ShellWindow`, as it
  asserts `shell` today.
- `main.ts`: the Electron readiness steps stay in `Shell`, and then the layers are piped: `ShellConfig` →
  `ShellWindow` → `ProviderSession` → `TileViews`, `GuideReader` → `serveHub`. `serveHub`, `forward` and
  `listen` yield `ShellWindow` (and `serveHub` yields `ShellConfig`) instead of taking `window` and
  `hubUrl`.
- `GuideReader`'s `readGuide` and `send` yield `ProviderSession` and read its `session`.
- CONTEXT.md gains **Shell config** and **Shell window** rows.

## 5. Tests and rules

- Test helpers that take a service value yield it: `LiveGames.replay.test.ts` `deliveriesOf` (FeedLog) and
  `heldAs` (LiveGames); `HubClient.test.ts` `onHub` becomes a layer over the base `HttpClient`;
  `Ingest.test.ts` `Context.get(services, FeedLog)` becomes a yield. `LiveGames.test.ts`'s `sleeping`
  callback receives a `Clock` because it *is* a fake Clock's sleep, so it stays as it is.
- AGENTS.md, under "How code is written": *A port's member types that other modules need are named and
  exported beside it (`Polling`); nothing indexes a service's type with `X["Service"]`.*

## Verification

- `pnpm check` passes at every commit.
- Ingest's and ScenarioProvider's tests, and the recorded scenarios through the real Ingest, pass with
  their expectations unchanged.
- `rg '\["Service"\]' apps packages` finds nothing.
- No exported function or layer in `apps/` takes a `Context.Service` value or a `HubConfig`/`ShellConfig`
  setting as a parameter, apart from the exceptions listed under Scope.
- The user runs `SPORTAL_SCENARIO=<recorded> SPORTAL_SCENARIO_SPEED=10 pnpm dev` and the desktop shell (the
  agent shell misreports Electron on this machine) and sees both work as before.
