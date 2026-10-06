# Cleanup and organization — design

Status: approved in brainstorming, 2026-10-06.

Sportal was built mostly by agents with little human review. An audit of every package and app against
AGENTS.md found no leftovers of the actor design and few rule breaks in the small. The debt is in the
large: concepts that exist but have no name and so are re-derived or copied, files and folders by kind,
an ESPN adapter split along the wrong lines, guardrails that do not guard, and docs that describe a
mix of the built and the planned. This spec fixes that.

## Scope

- **In:** moves, renames, splits and merges; removing dead and duplicated code; naming missing concepts;
  applying AGENTS.md; reworking non-idiomatic Effect; docs brought back in line with the code.
- **Behavior is preserved**, with five listed exceptions (below), each its own `fix:` commit with a test.
- **Out:** the Watchability rules redesign, recorded scenarios as feed-log frame slices, the Director,
  any new feature.

## Delivery

One session of work: one plan covering every phase, one branch `cleanup` in one worktree
(`../sportal-cleanup`), the phases done in order as commits on it, then `plannotator review` on the whole
branch and one merge to main. The spec and plan are not put through `plannotator annotate`.

Every commit passes `pnpm check`. Behavior-preserving commits are `refactor:`; the bug fixes are `fix:`.
A moved file moves in a commit that changes nothing else in it, so `git log --follow` keeps its history.

## Bugs fixed in passing

| Bug | Where | Phase |
|---|---|---|
| Overtime shows as `Q5`; halftime and delayed show the raw lowercase status | `web/slate/StatusText.ts:6` | 1 |
| The fold's memory (`activeAt`, `breakUntil`, `boostUntil`) goes over the wire in a parallel array no client reads | `api/LiveMessage.ts:8-11` | 1 |
| `GET /slate` has no client and disagrees with the live stream | `api/SportalApi.ts:9-11` | 1 |
| The UI says "Reconnecting" at boot: never connected and lost are one boolean | `web/hub/Live.ts:112` | 3 |
| Stage command transport failures die silently in a forked fiber; defects become UI copy | `web/hub/HubClient.ts:23,73,82` | 3 |

## Target tree

Only what changes is shown.

```
packages/domain/src/
  Game.ts             + margin(), inOvertime(), scored(), networks(); eventsSince declarative
  Game.test.ts        absorbs GameEvent.test.ts
  GameEvent.ts        fromPlays becomes a static of GameEvent
  LiveGames.ts        NEW — the fold as a pure class
  Channel.ts          split from Source.ts
  Guide.ts            split from Source.ts
  Layout.ts           + divider axes and hold bounds; one record per layout
  TestGame.ts         − followed; + situation()
  Scenario.ts, scenarios/   → apps/hub/src/scenario/
packages/api/src/
  ShellBridge.ts      + the IPC channel map
  LiveMessage.ts      SlateChanged carries [{ game, watchability }] without fold memory
  SportalApi.ts       − GET /slate

apps/hub/src/
  main.ts HubConfig.ts HubMode.ts Telemetry.ts TestHubConfig.ts TestTelemetry.ts
  Database.ts                 ← database/
  StageSessions.ts            ← stage/
  Slate.ts GameHistory.ts
  LiveGames.ts                service: the timer and I/O around the domain fold
  LiveGamesTelemetry.ts       ← reports, gauges, log lines and metrics out of LiveGames.ts
  LiveGames.replay.test.ts    ← Replay.test.ts
  feed-log/   FeedLog.ts Frame.ts Gzip.ts                     ← feed/
  ingest/     Ingest.ts Cadence.ts
  hub-server/ HubServer.ts LanAddresses.ts                    ← http/
  provider/   Provider.ts LiveFeed.ts TestProvider.ts←
    espn/     EspnProvider.ts EspnDecode.ts EspnEvent.ts EspnPlay.ts
              FastCast.ts FastCastMessage.ts FastCastDocument.ts fixtures/
  source/     Source.ts ChannelStore.ts youtube-tv/
  scenario/   ScenarioIngest.ts ScenarioSource.ts ScenarioClock.ts Scenario.ts written/
  recording/  Recording.ts ImportRecording.ts CutScenario.ts  ← provider/espn/

apps/web/src/
  main.tsx  ScenarioStream.tsx←  theme.css←
  display/  Display.ts DisplayView.tsx(←App.tsx) TopBar.tsx FullScreen.ts OverlayHost.tsx
            CommandPalette.tsx Hotkeys.ts KeysDialog.tsx
  game/     TeamLogo.tsx GameStatus.tsx Score.tsx
  layout/   LayoutGlyph.tsx LayoutPicker.tsx
  hub/      HubClient.ts LiveStream.ts(←Live.ts)
  slate/    SlateView.tsx StripCards.ts
  stage/    StageView.tsx TileChrome.tsx TileBody.tsx TileRects.ts Dividers.tsx Rejections.ts TileActions.tsx
  remote/   RemoteView.tsx StageMap.tsx JoinRemote.tsx←
  (frame/, scenario/, theme/ and LocalTime.ts dissolved)

apps/desktop/src/main/
  YouTubeTv.ts   NEW — everything the shell knows about YouTube TV
  Navigation.ts  ← hostOf, load, confine out of ProviderSession.ts

docs/
  technical-spec.md   §4.2 tree from the code + a "not built" list; §6 → CONTEXT.md; §7 → AGENTS.md
  history.md          NEW — what shipped when, and the commit to read its plan and spec at
  specs/              only unbuilt designs (director) and this spec
  plans/              only the plans for this cleanup
```

## Phase 0 — guardrails and housekeeping

The checks must catch the defects this cleanup removes, or they come back.

- `.dependency-cruiser.cjs` `only-hub-mode-names-adapters` matches `scenario/Scenario(Provider|Source|Clock)`;
  there is no `ScenarioProvider.ts`. Match the real files and narrow `pathNot` to `HubMode.ts` and tests,
  as AGENTS.md says. Adapter-internal imports and the `Sql*` exemption go once `ChannelStore` merges (phase 3).
- `knip.json` configures only `packages/*`. Configure every workspace, add the Hub scripts and `Test*.ts`
  as entries, and run `knip --production` in `pnpm check`. It starts with an ignore list of today's
  test-only exports; phases 1–3 empty it.
- Typecheck `apps/web/vite.config.ts` and the root `vitest.config.ts`.
- The root `test` script repeats the tail of `check`; `dev:x11` and desktop `start:x11` set the X11 flag
  two ways. One each.
- Stale worktrees and branches (`game-actors-design`, `live-feed-design`, `director-lull-note`,
  `sportal-actor-spike`, `sportal-feed-lag`) and `spikes/`: list what is unmerged on each; remove each only
  after the user confirms it.

## Phase 1 — name the missing concepts

Test-first in domain. The Hub's existing tests and the replay-equals-live property test hold behavior.

**The fold: `packages/domain/src/LiveGames.ts`.** CONTEXT already says Live games *is* the fold. The pure
part of `apps/hub/src/LiveGames.ts` (lines 192–387: `tickTo`, `earliestDue`, `dueAt`, `applied`,
`snapshotTaken`, `settled`, `guarded`, the `Folded`/`Stepped`/`Report` types) becomes a domain class with
`take`, `tickTo`, `earliestDue` and `slate(leagues)`, each returning the next state and its reports. The
four copies of slate-from-fold go (`Slate.ts:41`, `Ingest.ts:141-143`, `ScenarioIngest.ts:44-48`,
`GameHistory.ts:172-176`), and so do `GameHistory`'s re-declared shape (`:104`, `:172`). The `reached`
field threaded and stripped by `published()` (`LiveGames.ts:57,199`) becomes a field of the class. The
Hub service keeps the name `LiveGames` and imports the domain class under a namespace or alias.
`TestGame.followed`, a second copy of the fold (`TestGame.ts:70-88`), is deleted; its tests drive the
domain class. `gameTimeOf`/`teamOf` (`LiveGames.ts:589-595`) become `GameSnapshot` methods; the
`lastUpdatedAt` match (`:544-549`) becomes a `LiveGameState` method, with `Live.updatedAt` and
`Stale.lastUpdatedAt` given one name.

**Provider output.** `Provider.decode` returns a named `Data.taggedEnum` (Delivered | Resync) instead of an
inline union recovered as `Stream.Success<ReturnType<…>>` (`Ingest.ts:55,214`, `TestProvider.ts:101`,
`EspnDecode.ts:63`). The `as const` assertions in `TestProvider.ts` go with it.

**On `GameSnapshot`.** `margin()` (three copies in `Watchability.ts:155,198,216`), `inOvertime()` (six
`period >= 5` checks in `Game.ts` and `Watchability.ts`), `scored()` (the web disagrees today: `live ||
final` in SlateView and RemoteView, `progress !== upcoming` in StageMap, always in TileChrome/TileBody —
the slate's rule wins), `networks()` (the " · " join in four web files). `progress()` gets a CONTEXT row.

**Web names.** `StripCard` — a class with `pickable()` — replaces `ReturnType<typeof stripCards>` and the
loose `pickable`/`nextPick` exports. The Display step result `{ display, commands }`, written five times,
is a `Display` method's return. `{ game, event }` (`LiveGames.ts:48,63,393`) gets a name in domain.

**Layout.** Which layouts have which divider axes and the 0.2/0.8 hold bounds move from
`web/stage/Dividers.tsx:17-33,52` onto `Layout`. `Stage.splits`, `Stage.initial`, `LayoutName` and
`Layout.slotCount` list every layout by hand; derive them from one record over `LayoutName.literals`.
The drag preview (`StageView.tsx:33-36`) and the on-air/soloed checks (`TileChrome.tsx:24-25`,
`StageMap.tsx:237-238`) become `Stage` methods.

**Smaller.** `GameEvent.fromPlays` becomes a static; `GameEvent.test.ts` merges into `Game.test.ts`;
`Scenario.ts`'s private `Frame` is renamed (it collides with the feed-log Frame). Scenarios keep building
on `TestGame`: `.dependency-cruiser.cjs` allows it on purpose (scenarios are test data), and owning a
second set of builders would duplicate them; the rule's paths follow the move to the Hub.

**Fixes:** overtime and status text; SlateChanged without fold memory; `GET /slate` removed.

## Phase 2 — physical layout

Mechanical: the moves, renames, splits and merges in the target tree, imports updated, no logic changed.
One commit per package or app. Includes moving `Scenario.ts`, `scenarios/`, `Scenarios.test.ts` and the
recorded-scenario part of `Watchability.test.ts` (lines 340–411) to the Hub, so the domain package no
longer reads the repo's `fixtures/`. `Source.ts` splits into `Channel.ts` and `Guide.ts` here.
`TestProvider`'s `game()` builder moves to `TestGame`.

## Phase 3 — quality per area

May be planned as 3a Hub, 3b web, 3c desktop. Done means the knip ignore list is empty.

### Hub

- **ESPN event.** `EspnDecode.toSnapshot` (`:87-126`) and `FastCastPayload.Event`/`side` (`:126-193`) both
  turn an ESPN event into a `GameSnapshot`, one by hand and one by `Schema.decodeTo`. `EspnEvent.ts` holds
  one transform for both spellings and absorbs `EspnPayload.ts` and `EspnSnapshot.ts` (which holds no
  snapshot). The poll path counts skipped events as the push path does.
- **FastCast protocol.** `FastCastMessage.ts` takes Message/Envelope/Patch/Host/checkpoints from
  `FastCastPayload.ts`, plus `topic()`/`owner()` from `FastCastDocument.ts`. Envelope derives from Message
  instead of re-listing five of its six members. A transforming Envelope schema yields
  `{channel, sourceId, sentAt}` instead of the `Option.flatMap` chains in `FastCast.ts:188-207`. `inflate`
  uses `Gzip` with a format parameter. Message-id gaps are tracked once, not in both
  `FastCast.ts:233-251` and `FastCastDocument.ts:166-168`. `FastCastDocument`'s owner and change shapes
  become tagged unions instead of a string discriminator plus an `Option`.
- **FeedLog.** The ~250-line `Effect.gen` (`FeedLog.ts:52-306`) splits into hoisted writer and replay
  functions below the service; the table format sits together. Hashing uses Effect `Crypto`, not
  `crypto.subtle` (`:436-444`). The gap has one schema both ways (`:423`, `:450`). "poll response" is a
  `Frame` method (`:107`, `:292`). One SELECT column list.
- **ChannelStore.** Port and SQL merge into `source/ChannelStore.ts`; the row↔`ChannelCarriage` mapping
  (`SqlChannelStore.ts:128-154`) is one Schema transform; the error mapping is written once.
- **YouTube TV.** `toGuide` (`YouTubeTv.ts:152-186`) is a `Schema.decodeTo` from the guide response,
  with `NumberFromString`, not loops with `push`. The source name appears once.
- **Ingest.** The empty `Ingest` marker service becomes an `effectDiscard` layer, unless the plan finds a
  reason it must stay. The duplicated `onExitIf(!stopping, …)` (`Ingest.ts:90-97,182-189`) is written
  once. `HubMode`'s hard-coded `["nfl","fbs"]` uses `LeagueId.literals`.
- **HubServer.** `serve` comes first; `layer`/`ApiHandlers` stop being exported for tests if tests can
  use `serve`. `catchTag("ChannelStoreError", Effect.die)` is written once.
- **Tests.** One "take this delivery now" helper instead of three; `TestHubConfig.withEnv` instead of
  hand-rolled `ConfigProvider.fromEnv` (three files); one live-snapshot builder in `TestGame` instead of
  five; `counted`/`gauged` in `TestTelemetry` merge. `TestProvider` counts with a `Ref`.

### Web

- **`game/`.** `Score` is the one team-side row (logo, rank, abbreviation, score, trailing muted), replacing
  six copies (`SlateView:494`, `RemoteView:128-171`, `StageMap:283-289`, `TileChrome:66-72`,
  `TileBody:51-60`, `ScenarioStream:446-455`). `GameStatus` is the live-coloured status label, replacing
  six copies, and absorbs `StatusText.ts` and `LocalTime.ts`. Place badge and scoreline are written once;
  the local `matchup` (it means something else in domain) is renamed.
- **`stage/TileActions.tsx`.** The one tile action list (hear, promote, solo/unsolo, clear) replacing
  `TileChrome.tsx:85-127`, `StageMap.tsx:329-357` and `CommandPalette.tsx:74-110`.
- **`layout/LayoutPicker.tsx`.** Replaces three pickers (TopBar, `RemoteView:64-79`, `CommandPalette:113-125`).
- **`hub/LiveStream.ts`.** An Effect stream with a `Connecting | Connected | Lost` state union instead of a
  module-level mutable store and listener `Set`; a malformed message is a handled failure, not a throw in
  `onmessage`. `HubClient`'s listener `Set` becomes a `PubSub`/`Stream`. Fix: boot no longer says
  "Reconnecting".
- **`HubClient`.** Transport failures reach the UI as failures; defects are not turned into copy; the
  user-facing strings leave the transport module; `learnChannel`/`markNotCarried`/`forgetChannel` return
  Effects, so components stop chaining `.then`.
- **States as unions.** `StageMap` `Idle | Actions | Swapping{from}` (`:204-205`); `JoinRemote`
  `Asking | NoAnswer | Answered` (`:205`), with the reopen race cancelled.
- **Smaller.** `TileRects` helpers below their user and its `header = 28` tied to `TileChrome`'s height;
  `Display.open`'s overlay literals derived from `Overlay`; `GameId` instead of `string` in
  `CommandPalette` and `ScenarioStream`; source names from the source, not a hard-coded "YouTube TV";
  `Display.test.ts` reuses `StripCards.test.ts`'s fixtures; the brand mark and connection pill written
  once with one wording; `ScenarioStream`'s keyframes in `theme.css`.

### Desktop

- One IPC channel map in `packages/api/src/ShellBridge.ts`; the 11 `"sportal:*"` literals in
  `preload/ShellBridge.ts:7-52` and `main/main.ts:104-163` use it.
- `main.ts`: one `listen(window, channel, handler)` for the five copies of sender-check plus
  `acquireRelease` (`:96-163`). Preload: one `subscribe(channel)` for its five copies. One
  `webPreferences` constant for three copies.
- `YouTubeTv.ts` holds the sign-in URL, allowed hosts, guide origin and browse id, and the `/watch/` rule,
  now spread over `ProviderSession.ts:99,113`, `GuideReader.ts:107` and `TileViews.ts:225-229`.
- `Navigation.ts` holds `hostOf`, `load`, `confine`. Test-only exports (`allows`, `grantsPermission`,
  `loadErrorCode`) are tested through the service.
- `TileViews`: `Option` instead of `""` sentinels, a role union instead of `role` + `interactive`, a
  named `TileBounds` schema in api shared with `Transition.ts`.
- The Hub URL default in `main.ts:12` and the `dev` script agree. The `externalizeDeps` list is
  justified or dropped.

### Domain

`Game.eventsSince` (`Game.ts:133-176`) builds its list declaratively like `Play.eventsOf`;
`Watchability.situation` and `stakes`, `Stage.nextEmptySlot`, `Stage.settle` and
`ChannelLineup.availabilityOf` use `Arr`; time math in `Watchability.ts:111`, `Guide`'s `nearKickoff` and
`Scenario.ts:97,109` uses `DateTime`/`Duration`. `LiveGame.tick`'s always-empty `events` and the public
`staleAt` go if nothing needs them. `LiveGame.test.ts` uses `assert` like every other test.
`Delivery.test.ts`, which tests `$match`, is deleted.

## Phase 4 — recording tooling

- `recording/Recording.ts` owns a recorded day: the league folders and their check, the polls, filename to
  instant, the sort. `CutScenario` and `ImportRecording` stop duplicating these and stop importing each
  other (`leagueOf`/`instantOf`) and `ScenarioIngest.folder`.
- `CutScenario` uses Effect `FileSystem`, `Path` and `Gzip`, and `effect/cli` like `ImportRecording`;
  no `for`/`push`, `console.error` or `process.exitCode`. `ScenarioIngest`'s `node:path` goes too.
- `ImportRecording.ts:282`'s `INIT_CWD` read is either allowed in AGENTS.md beside `scenario:cut`'s or
  removed. The "deviation 5" comments (`:26`, `:229`) say what they mean.
- `EspnDecode.slateOf`, exported for CutScenario, is reached through the provider or kept private.
- Recorded scenarios stay snapshot timelines.
- The recorders retire: `fixtures/espn-recordings/record.sh` is deleted and the `record.py` references
  removed — the feed log and `feed:import` replace them. The raw recordings stay as gitignored local data,
  documented as such. `fixtures/scenarios/` stays.
- Tests that read another adapter's fixtures (`YouTubeTv.test.ts:417`, `StageSessions.test.ts:243`,
  `LiveGames.replay.test.ts`) build their input from `TestGame` or read through the owning adapter.

## Phase 5 — docs

- `technical-spec.md`: the §4.2 tree regenerated from the code, with planned files in a separate "not
  built" list; §6 (a stale copy of the glossary) replaced by a link to CONTEXT.md; §7 (a copy of
  AGENTS.md rules) replaced by a link; §8–§9 (spikes and build order, finished) to `history.md`; the
  StageSessions description (one Stage, nothing persisted) corrected; "Draft 2" headers dropped here and in
  `product-plan.md`.
- `CONTEXT.md`: built terms only in the main tables; a "Planned" section for GameDetail, Drive, Follow,
  Rule, Alert, Preset, Tile delay, Spoiler shield, Season, Conference, StreamBudget, Desk/Couch mode, Lull.
  New rows for every concept phases 1–3 name. AGENTS.md states that `*Payload.ts` and
  `FastCastMessage.ts` wire schemas are exempt from the glossary rule.
- `history.md`: one line per shipped piece — what, when, the merge commit — then the 37 shipped plans and
  specs are deleted. `director-design` stays.
- `AGENTS.md`: back to the rules that are easiest to break. Hub settings point at `HubConfig.ts`; commands
  stay short; `feed:import` is listed; the recorder references go.
- `stage-control-design`'s "spike pending" and similar stale status lines go with their files.

## Risks

- **Phase 1 moves the fold.** The replay-equals-live property test and the LiveGames tests run unchanged
  against the new class before the Hub copies are deleted.
- **Phase 2 touches every import.** No other branch should be open across the cleanup branch.
- **One long branch.** Main may move while it runs; the branch rebases onto main before review.
- **Wire change.** SlateChanged's shape changes; the web and the Hub change in the same commit. No client
  outside the repo exists.
- **The user runs the app from main.** Work happens in worktrees; merges land between game days.
