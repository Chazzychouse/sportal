# One Test module per app

Each app's tests import their shared helpers from one module. Duplicated helpers inside test files move into it.

| Where | Module | Absorbs |
|---|---|---|
| Hub | `apps/hub/src/TestHub.ts` | `TestEspn`, `TestFastCast`, `TestGameTopics`, `TestProvider`, the YouTube TV guide fixtures, the Director/HubServer frame feeding |
| Web | `apps/web/src/TestWeb.ts` | `TestSlate`, `TestScreen`, `TestLiveStream` |
| Desktop | `apps/desktop/src/main/TestDesktop.ts` | `TestShell`, `TestWebContents` |
| Domain | `packages/domain/src/TestGame.ts` (stays, used by every app) | `snapshotIn`, `playsIn` from `Director.test.ts` and `Slate.test.ts` |

Tests import an app's module as a namespace (`import * as TestHub from "../TestHub.ts"`). `TestGame` keeps its named
imports. Only imports and helper locations change, and no assertion moves, so the commit body has no rewritten-test list.

## Task 1 — Hub

1. Create `TestHub.ts` from the four files, contents unchanged except:
   - fixture URLs gain their folder (`./provider/espn/fixtures/…`, `./source/youtube-tv/fixtures/…`);
   - `TestEspn.replayed`'s span becomes `TestHub.replayed`, and so on for each `Effect.fn` name;
   - order: ESPN recordings (`recordedEspn`, `recordedScoreboard`, `plays`, NE at BUF), FastCast, game topics,
     `listedBy`, YouTube TV guide, frame feeding.
2. Add the YouTube TV guide fixtures, defined today in both `Source.test.ts` and `YouTubeTvGuide.test.ts` (with
   `export` on test files): `recordedGuide`, `recordedAt`, `readRecordedGuide`, `oneRowGuide`, `cbsLive`, `onNews3`,
   `ohioStateAtIowa` (if both copies are equal; `Guide.test.ts`'s copy has short names and stays local), and the shared
   `now` helper renamed `availabilityNow`. Drop both test files' copies and their `export`s.
3. Add `type Frames` and `offered(frames, delivery)` (the three `Queue.offer`s). `HubServer.test.ts` uses
   `offered` in place of its `delivered`, and `Director.test.ts`'s `delivered` becomes `offered` then `latest`.
4. Delete `TestEspn.ts`, `TestFastCast.ts`, `TestGameTopics.ts`, `TestProvider.ts`.
5. Repoint the imports in `Espn`, `EspnEvent`, `EspnPlay`, `EspnProvider`, `FastCast`, `FastCastDocuments`,
   `GameTopics`, `YouTubeTvGuide`, `Source`, `Director` and `HubServer` tests. `EspnEvent.test.ts`'s uncommitted
   local `recordedScoreboard` goes back to `TestHub.recordedScoreboard`. It duplicates the existing `fixture`
   helper there, and `duringNeAtBuf`/`neAtBufDecoded` are currently undefined in it.

## Task 2 — Domain

Move `snapshotIn` and `playsIn` (identical in `Director.test.ts` and `Slate.test.ts`) into `TestGame.ts`. Both tests
import them.

## Task 3 — Web

Merge `TestSlate`, `TestScreen` and `TestLiveStream` into `TestWeb.ts`. Repoint `StripCards`, `Display`,
`LiveStream`, `DisplayScreen`, `TileActions`, `Screen` and `TileRects` tests to `TestWeb.*`.

## Task 4 — Desktop

Merge `TestShell` and `TestWebContents` into `TestDesktop.ts`. `TileViews`, `GuideReader`, `ProviderSession` and
`Navigation` tests import it.

Risk: `shellOf` needs `ShellWindow`, which imports `electron` at runtime. `Navigation.test.ts` mocks no `electron`,
so it would now load it. If that fails under Vitest, I stop and ask you; I don't work around it.

## Task 5 — Rules

- `.dependency-cruiser`: the eight per-file Test rules become one, "Test modules are imported only by tests and other
  Test modules", over `(^|/)Test[^/]*\.ts$`. The `TestGame` rule's exception moves from `TestSlate.ts` to `TestWeb.ts`
  (covered by the general rule). The stale `packages/domain/src/TestScreen.ts` rule goes.
- `AGENTS.md` → Tests: "A `Test*.ts` file is named for the concept it builds or fakes and sits beside its module"
  becomes "Each app has one Test module, `TestHub.ts`, `TestWeb.ts` or `TestDesktop.ts`, and the domain's builders are
  `TestGame.ts`. A test imports its app's module as a namespace." The Module-shapes row stays.
- `knip.json` already excludes `Test*.ts`, so it doesn't change.

## Verify

`pnpm check` passes. One commit per task.
