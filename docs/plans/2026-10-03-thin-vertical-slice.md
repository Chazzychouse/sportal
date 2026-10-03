# Thin Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live NFL + FBS slate in the browser where clicking a game puts it in a tile, and in the desktop shell that tile plays the game on YouTube TV.

**Architecture:** A local Hub (Effect 4 on Node) polls ESPN, decodes payloads into `GameSnapshot`s, and owns the `Stage`. It serves a typed HTTP API plus a server-sent-events live stream. One React web UI renders the slate and a 2×2 Stage and sends stage commands. An Electron shell loads that UI and lays one unmodified YouTube TV web view over each stream tile.

**Tech Stack:** TypeScript 6, Effect 4.0.0 (`effect`, `@effect/platform-node`, `@effect/vitest`), Node 24, pnpm 12 workspaces, React 19, Vite 8, Tailwind 4, Electron 44 (castlabs Widevine build) with electron-vite 5, Vitest 5, Biome 2.5, dependency-cruiser 18, knip 6, Lefthook 2.

**Provenance of the code in this plan:** Every code block in Tasks 1–7 and 9 was assembled in a scratch workspace on 2026-10-03 and passed `pnpm check` there (format, lint, typecheck, import boundaries, unused-code check, 15 tests). The Hub was also run against the live ESPN feed and returned 75 games (59 FBS, 16 NFL) and a working live stream. The desktop shell typechecks and builds; **it has not been run** — whether YouTube TV plays inside it is exactly what Task 8 finds out.

## Global Constraints

- Read `AGENTS.md` (created in Task 1) before every task. Its rules on file layout and in-file order are requirements, not style.
- Effect is pinned to exactly `4.0.0`. Do not write Effect code from memory; consult `node_modules/effect/ai-docs/src/`.
- TypeScript stays on `^6`. dependency-cruiser 18 does not support TypeScript 7.
- Node 24 via `mise`. dependency-cruiser refuses Node 25. Run every command through the pinned toolchain (`mise exec -- <command>` if your shell has not activated mise).
- `pnpm check` must pass before every commit.
- Domain vocabulary is binding: every exported type name is a term in `CONTEXT.md`.
- Banned file and folder names: `utils`, `helpers`, `common`, `shared`, `misc`, `lib`, `types`, `constants`, `models`, `interfaces`, `index.ts`.
- Provider web players are loaded unmodified: no script injection, no request rewriting, no capture.
- The Hub binds to `127.0.0.1` in this slice. Do not expose it to the network; that waits for the access token in a later plan.
- Poll ESPN no faster than `Cadence` allows (10 seconds while games are live).

## Out of scope for this slice

Deferred to later plans, deliberately: persistence (the `Store` port and SQL), `GameEvent` and snapshot diffing, the Director and watchability, game detail, follows, presets, layouts other than 2×2, stream budget enforcement, more than one Display, the network access token, couch mode, CollegeFootballData, the Hub container image, TanStack Router.

## File map

```
sportal/
├── AGENTS.md, CLAUDE.md, CONTEXT.md          Task 1
├── mise.toml, package.json, pnpm-workspace.yaml, tsconfig.base.json
├── biome.json, .dependency-cruiser.cjs, knip.json, lefthook.yml
├── packages/
│   ├── domain/src/
│   │   ├── League.ts, Team.ts, Situation.ts, Game.ts     Task 2
│   │   ├── Slate.ts (+ test)                             Task 2
│   │   ├── Stream.ts                                     Task 3
│   │   └── Stage.ts (+ test)                             Task 3
│   └── api/src/
│       ├── SportalApi.ts, LiveMessage.ts                 Task 6
│       └── ShellBridge.ts                                Task 7
├── apps/
│   ├── hub/src/
│   │   ├── provider/Provider.ts                          Task 4
│   │   ├── provider/espn/EspnPayload.ts, EspnProvider.ts (+ test), fixtures/   Task 4
│   │   ├── ingest/Cadence.ts, Ingest.ts (+ test)         Task 5
│   │   ├── source/Source.ts, YouTubeTv.ts, youtube-tv-channels.json   Task 6
│   │   ├── stage/StageSessions.ts                        Task 6
│   │   ├── http/HubServer.ts (+ test)                    Task 6
│   │   └── main.ts                                       Task 6
│   ├── web/                                              Task 7
│   │   ├── index.html, vite.config.ts
│   │   └── src/main.tsx, App.tsx, theme/theme.css
│   │       ├── hub/HubClient.ts, Live.ts (+ test)
│   │       ├── slate/SlateView.tsx
│   │       └── stage/StageView.tsx
│   └── desktop/                                          Task 9
│       ├── electron.vite.config.ts
│       └── src/main/main.ts, TileViews.ts, ProviderSession.ts
│           src/preload/ShellBridge.ts
└── docs/
    ├── adr/0001 … 0005                                   Tasks 8 and 10
    └── game-day-checklist.md                             Task 10
```

---

### Task 1: Workspace foundation

**Files:**
- Create: `mise.toml`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `.dependency-cruiser.cjs`, `knip.json`, `lefthook.yml`, `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: the root scripts `pnpm check`, `pnpm format`, `pnpm test`, `pnpm typecheck`, `pnpm structure`; the shared `tsconfig.base.json` every package extends; the import-boundary rules every later task must satisfy.

- [ ] **Step 1: Pin the toolchain**

Create `mise.toml`:

```toml
[tools]
node = "24"
pnpm = "12"
```

Run: `mise install && mise exec -- node --version && mise exec -- pnpm --version`
Expected: a `v24.x` Node version and a `12.x` pnpm version.

- [ ] **Step 2: Create the workspace manifest files**

Create `package.json`:

```json
{
  "name": "sportal",
  "private": true,
  "type": "module",
  "scripts": {
    "check": "biome check . && pnpm typecheck && pnpm structure && vitest run",
    "typecheck": "pnpm -r --parallel exec tsc --noEmit",
    "structure": "depcruise apps packages && knip",
    "test": "vitest run",
    "format": "biome check --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.15",
    "@effect/vitest": "4.0.0",
    "@types/node": "^24",
    "dependency-cruiser": "^18.5.0",
    "knip": "^6.39.0",
    "lefthook": "^2.1.16",
    "typescript": "^6.0.3",
    "vitest": "^5.0.3"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
  - apps/*
allowBuilds:
  electron: true
  esbuild: true
  lefthook: true
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

`erasableSyntaxOnly` guarantees Node can run the Hub's TypeScript directly. `allowImportingTsExtensions` is why relative imports are written with `.ts`.

- [ ] **Step 3: Create the lint, structure, and hook configuration**

Create `biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.15/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!**/fixtures", "!fixtures"] },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 110 },
  "javascript": { "formatter": { "semicolons": "asNeeded", "trailingCommas": "none" } },
  "linter": {
    "rules": {
      "preset": "recommended",
      "style": { "noDefaultExport": "error", "noNonNullAssertion": "error", "noEnum": "error" },
      "suspicious": { "noExplicitAny": "error" }
    }
  },
  "overrides": [
    {
      "includes": ["**/*.config.ts", "**/.dependency-cruiser.cjs"],
      "linter": { "rules": { "style": { "noDefaultExport": "off" } } }
    }
  ]
}
```

Create `.dependency-cruiser.cjs`:

```js
/** Import boundaries and banned names. See docs/technical-spec.md section 4. */
module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      comment: "packages/domain imports only Effect.",
      severity: "error",
      from: { path: "^packages/domain/" },
      to: { path: "^(apps|packages/api)/" }
    },
    {
      name: "api-imports-only-domain",
      severity: "error",
      from: { path: "^packages/api/" },
      to: { path: "^apps/" }
    },
    {
      name: "nothing-imports-an-app",
      comment: "Apps compose packages; they never import each other.",
      severity: "error",
      from: { path: "^(packages|apps)/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^$1/$2/" }
    },
    {
      name: "provider-payloads-are-private",
      comment: "A provider's wire vocabulary stays inside its folder.",
      severity: "error",
      from: { pathNot: "^apps/hub/src/provider/([^/]+)/" },
      to: { path: "^apps/hub/src/provider/[^/]+/[^/]*Payload\\.ts$" }
    },
    {
      name: "only-main-names-adapters",
      comment: "Only the composition root and tests know which concrete adapters exist.",
      severity: "error",
      from: {
        path: "^apps/hub/src/",
        pathNot: "(^apps/hub/src/main\\.ts$|\\.test\\.ts$|^apps/hub/src/provider/[^/]+/)"
      },
      to: { path: "^apps/hub/src/(provider/[^/]+/|source/YouTubeTv\\.ts$)" }
    },
    {
      name: "no-junk-drawers",
      comment: "Name a file for the concept it owns.",
      severity: "error",
      from: {},
      to: {
        path: "(^|/)(utils|helpers|common|shared|misc|lib|types|constants|models|interfaces)(/|\\.tsx?$)",
        pathNot: "node_modules"
      }
    },
    {
      name: "no-barrels",
      severity: "error",
      from: {},
      to: { path: "(^|/)index\\.tsx?$", pathNot: "node_modules" }
    },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } }
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "default"] }
  }
}
```

Create `knip.json`:

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "workspaces": {
    "packages/*": { "entry": ["src/*.ts"], "project": ["src/**/*.ts"] }
  }
}
```

Create `lefthook.yml`:

```yaml
pre-commit:
  commands:
    lint:
      run: pnpm exec biome check --staged --no-errors-on-unmatched
pre-push:
  commands:
    check:
      run: pnpm check
```

Append to `.gitignore`:

```
spikes/
```

- [ ] **Step 4: Write the agent rules and the domain language**

Create `AGENTS.md`:

````markdown
# Working in Sportal

Sportal tracks live football and multi-views games. Read `CONTEXT.md` for the vocabulary and
`docs/technical-spec.md` for the architecture. This file is the short version of the rules that are
easiest to break.

## Before you write anything

- **Search first.** Before adding a function, type, or file, look for the one that already exists.
  Duplicated logic is a defect even when it works.
- **Effect 4 is newer than most training data.** Do not write Effect code from memory. The package ships
  its own current examples: read `node_modules/effect/ai-docs/src/` (start with `index.md`) and
  `node_modules/effect/AGENTS.md`. Services are `Context.Service`, HTTP lives in `effect/http` and
  `effect/http-api`, the test clock in `effect/testing`.
- **Use the words in `CONTEXT.md`.** Every exported type name must be a term there. A new concept adds
  its glossary row in the same commit.

## Where code goes

- Two packages, three apps. `packages/domain` is pure and imports only Effect. `packages/api` is the
  contract between the Hub and its clients. Apps never import each other.
- A package exists only when two apps need the same code. A folder exists only when a concept has
  several files private to it. Do not add either for symmetry or for later.
- A module is a file named for the concept it owns (`Game.ts`, `Ingest.ts`), imported as a namespace or
  by name. Organize by concept, never by kind: no `components/`, `hooks/`, `services/`, `schemas/`.
- Banned file and folder names: `utils`, `helpers`, `common`, `shared`, `misc`, `lib`, `types`,
  `constants`, `models`, `interfaces`, and `index.ts` barrels.
- No mirror types. There is no `GameDto`, `GameRow`, `GameResponse`, or `GameProps`. The domain schema is
  the wire format. Derive a variant at the point of use; do not name it.
- In the Hub, only `main.ts` and tests name concrete adapters. Everything else depends on the port.

## Inside a file

A reader opens a file to see the thing it is named for. Keep it that way.

1. The main export comes first. No preamble of types, constants, and small helpers above it.
2. Private helpers go **below** the code that uses them, as hoisted `function` declarations, in the
   order they are first used.
3. A helper used once and a few lines long is inlined. A helper that is really an operation on another
   concept lives in that concept's module.
4. Do not declare an interface or type alias for an options bag, a return shape, a callback, or
   component props used in one place. Write the shape inline in the signature.
5. A service file reads: service declaration, its layer, then private helpers.
6. A constant lives beside its only user.
7. When a file needs a table of contents, split it by concept — never into `FooTypes.ts` and
   `FooHelpers.ts`.

## How code is written

- Logic is a pure function or an `Effect`. No bare promises or `async` outside framework edges (React
  handlers, Electron callbacks).
- Expected failures are tagged errors in the error channel. Nothing is caught and ignored.
- Time comes from Effect's `Clock`. No `Date.now()` in `packages/domain` or the Hub.
- No `any`, no non-null assertions, no enums, no default exports, no casts outside decoding.
- Tests sit beside the file as `Name.test.ts`. Domain logic and provider decoding are written test-first.
  Provider tests run against recorded real payloads in the adapter's `fixtures/` folder.

## Commands

- `pnpm check` — format check, lint, typecheck, import boundaries, unused code, tests. Must pass before
  every commit; the push hook runs it.
- `pnpm format` — apply formatting and safe lint fixes.
- `pnpm --filter @sportal/hub dev` — run the Hub on http://127.0.0.1:4400.
- `pnpm --filter @sportal/web dev` — run the web UI on http://127.0.0.1:4401, proxying `/api` to the Hub.
- `pnpm --filter @sportal/desktop dev` — run the desktop shell against the Hub.

## Limits that are deliberate

- Provider web players are loaded unmodified. Never inject scripts into them, rewrite their requests, or
  capture their video.
- Poll the data feed no faster than `Cadence` allows.
````

Create `CLAUDE.md`:

````markdown
Read [AGENTS.md](./AGENTS.md) before doing anything in this repository.
````

Create `CONTEXT.md` from section 6 of the spec, which is the single source for the glossary:

```bash
{ printf '# Sportal — Domain Language\n\nOne word per concept, used identically in code, UI, documents, and conversation.\nEvery exported type name must be a term here.\n\n'; \
  awk '/^## 6\. Domain language/{on=1; next} /^## 7\./{on=0} on' docs/technical-spec.md \
  | sed '1,/^### Competition/{/^### Competition/!d}'; } > CONTEXT.md
```

Run: `grep -c '^### ' CONTEXT.md && grep -n 'Tile placement\|Shell bridge' CONTEXT.md`
Expected: `6`, then one line for each of the two terms.

Then edit `docs/technical-spec.md`: replace the sentence `This section becomes \`CONTEXT.md\`.` in section 6 with `\`CONTEXT.md\` is the living copy of this section; when they differ, \`CONTEXT.md\` is right.`

- [ ] **Step 5: Install and verify the tools run**

Run: `pnpm install`
Expected: completes; Lefthook reports `sync hooks: ✔️`.

Run: `pnpm format && pnpm exec biome check .`
Expected: `Checked N files … No fixes applied.` with no errors. (`pnpm check` as a whole cannot pass until Task 2 adds the first package and test.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: workspace foundation, agent rules, and domain language"
```

---

### Task 2: Domain — competition and game state

**Files:**
- Create: `packages/domain/package.json`, `packages/domain/tsconfig.json`
- Create: `packages/domain/src/League.ts`, `Team.ts`, `Situation.ts`, `Game.ts`, `Slate.ts`
- Test: `packages/domain/src/Slate.test.ts`

**Interfaces:**
- Consumes: `tsconfig.base.json` from Task 1.
- Produces, importable as `@sportal/domain/<Module>`:
  - `League.LeagueId` — schema and type, `"nfl" | "fbs"`.
  - `Team.TeamId` (branded string, formatted `<league>:<provider id>`), `Team.Team` (`id`, `abbreviation`, `name`, optional `logo`).
  - `Situation.Situation` — `isRedZone`, `homeTimeouts`, `awayTimeouts`, optional `possession`, `down`, `distance`, `yardLine`, `lastPlay`.
  - `Game.GameId` (branded string), `Game.GameStatus`, `Game.GameSnapshot` (`id`, `league`, `kickoff: DateTime.Utc`, `status`, `period`, `clock`, `home`, `away`, `broadcasts`, optional `situation`; each side is `{ team, score, ranking? }`), `Game.isLive(game): boolean`.
  - `Slate.inWatchOrder(slate): ReadonlyArray<GameSnapshot>`.

- [ ] **Step 1: Create the package**

Create `packages/domain/package.json`:

```json
{
  "name": "@sportal/domain",
  "private": true,
  "type": "module",
  "exports": {
    "./*": "./src/*.ts"
  },
  "dependencies": {
    "effect": "4.0.0"
  }
}
```

Create `packages/domain/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

The `exports` map makes each file in `src/` a public module (`@sportal/domain/Game`). There is no barrel file and no build step: consumers import the TypeScript source.

- [ ] **Step 2: Define the schemas**

These are declarations, not behaviour; they are exercised by the tests in this and later tasks.

Create `packages/domain/src/League.ts`:

```ts
import { Schema } from "effect"

export const LeagueId = Schema.Literals(["nfl", "fbs"])
export type LeagueId = typeof LeagueId.Type
```

Create `packages/domain/src/Team.ts`:

```ts
import { Schema } from "effect"

export const TeamId = Schema.String.pipe(Schema.brand("TeamId"))
export type TeamId = typeof TeamId.Type

export class Team extends Schema.Class<Team>("sportal/Team")({
  id: TeamId,
  abbreviation: Schema.String,
  name: Schema.String,
  logo: Schema.optional(Schema.String)
}) {}
```

Create `packages/domain/src/Situation.ts`:

```ts
import { Schema } from "effect"
import { TeamId } from "./Team.ts"

export class Situation extends Schema.Class<Situation>("sportal/Situation")({
  possession: Schema.optional(TeamId),
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  yardLine: Schema.optional(Schema.Int),
  isRedZone: Schema.Boolean,
  homeTimeouts: Schema.Int,
  awayTimeouts: Schema.Int,
  lastPlay: Schema.optional(Schema.String)
}) {}
```

Create `packages/domain/src/Game.ts`:

```ts
import { Schema } from "effect"
import { LeagueId } from "./League.ts"
import { Situation } from "./Situation.ts"
import { Team } from "./Team.ts"

export const GameId = Schema.String.pipe(Schema.brand("GameId"))
export type GameId = typeof GameId.Type

export const GameStatus = Schema.Literals([
  "scheduled",
  "live",
  "halftime",
  "delayed",
  "final",
  "postponed",
  "canceled"
])
export type GameStatus = typeof GameStatus.Type

export class GameSnapshot extends Schema.Class<GameSnapshot>("sportal/GameSnapshot")({
  id: GameId,
  league: LeagueId,
  kickoff: Schema.DateTimeUtcFromString,
  status: GameStatus,
  period: Schema.Int,
  clock: Schema.String,
  home: Schema.Struct({ team: Team, score: Schema.Int, ranking: Schema.optional(Schema.Int) }),
  away: Schema.Struct({ team: Team, score: Schema.Int, ranking: Schema.optional(Schema.Int) }),
  broadcasts: Schema.Array(Schema.String),
  situation: Schema.optional(Situation)
}) {}

export function isLive(game: GameSnapshot): boolean {
  return game.status === "live" || game.status === "halftime"
}
```

`kickoff` is `Schema.DateTimeUtcFromString`: a `DateTime.Utc` in memory, an ISO string on the wire. The two sides are written inline rather than as a named type because "side" is not a glossary term.

- [ ] **Step 3: Write the failing test for slate ordering**

Create `packages/domain/src/Slate.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { GameId, GameSnapshot, type GameStatus } from "./Game.ts"
import * as Slate from "./Slate.ts"
import { Team, TeamId } from "./Team.ts"

function game(id: string, status: GameStatus, kickoff: string) {
  const team = (abbreviation: string) =>
    new Team({ id: TeamId.make(`fbs:${abbreviation}`), abbreviation, name: abbreviation })
  return new GameSnapshot({
    id: GameId.make(id),
    league: "fbs",
    kickoff: DateTime.makeUnsafe(kickoff),
    status,
    period: 0,
    clock: "0:00",
    home: { team: team("HOME"), score: 0 },
    away: { team: team("AWAY"), score: 0 },
    broadcasts: []
  })
}

describe("Slate.inWatchOrder", () => {
  it("puts live games first, then upcoming by kickoff, then finished", () => {
    const ordered = Slate.inWatchOrder([
      game("final", "final", "2026-10-03T16:00:00Z"),
      game("late", "scheduled", "2026-10-03T23:30:00Z"),
      game("halftime", "halftime", "2026-10-03T19:30:00Z"),
      game("early", "scheduled", "2026-10-03T20:00:00Z"),
      game("live", "live", "2026-10-03T16:00:00Z")
    ])
    assert.deepStrictEqual(
      ordered.map((g) => g.id),
      ["live", "halftime", "early", "late", "final"]
    )
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm install && pnpm exec vitest run packages/domain/src/Slate.test.ts`
Expected: FAIL — cannot resolve `./Slate.ts`.

- [ ] **Step 5: Implement slate ordering**

Create `packages/domain/src/Slate.ts`:

```ts
import { DateTime, Order } from "effect"
import { type GameSnapshot, isLive } from "./Game.ts"

/** Live games first, then upcoming by kickoff, then everything that is over. */
export function inWatchOrder(slate: ReadonlyArray<GameSnapshot>): ReadonlyArray<GameSnapshot> {
  return [...slate].sort(Order.combine(byPhase, byKickoff))
}

const byPhase = Order.mapInput(Order.Number, (game: GameSnapshot) =>
  isLive(game) ? 0 : game.status === "scheduled" || game.status === "delayed" ? 1 : 2
)

const byKickoff = Order.mapInput(DateTime.Order, (game: GameSnapshot) => game.kickoff)
```

- [ ] **Step 6: Run the test and the full check**

Run: `pnpm exec vitest run packages/domain/src/Slate.test.ts`
Expected: PASS, 1 test.

Run: `pnpm format && pnpm check`
Expected: Biome clean, typecheck clean, `no dependency violations found`, knip silent, tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(domain): league, team, game snapshot, situation, and slate ordering"
```

---

### Task 3: Domain — Stream and Stage

**Files:**
- Create: `packages/domain/src/Stream.ts`, `packages/domain/src/Stage.ts`
- Test: `packages/domain/src/Stage.test.ts`

**Interfaces:**
- Consumes: `Game.GameId` from Task 2.
- Produces:
  - `Stream.StreamLocator` — tagged union with one member, `{ _tag: "WebView", url: string }`.
  - `Stage.Tile` — `{ _tag: "Empty" } | { _tag: "StreamTile", game, locator } | { _tag: "DataTile", game }`.
  - `Stage.Stage` — class with `tiles: ReadonlyArray<Tile>` and `audioFocus: number`.
  - `Stage.StageCommand` — `{ _tag: "Assign", tile, game } | { _tag: "Clear", tile } | { _tag: "FocusAudio", tile }`.
  - `Stage.StageRejection` — tagged error, `reason: "no-such-tile"`, HTTP status 422.
  - `Stage.initial: Stage` — four empty tiles, audio focus on tile 0.
  - `Stage.apply(stage, command, locate): Result.Result<Stage, StageRejection>` where `locate: (game: GameId) => Option.Option<StreamLocator>`.

- [ ] **Step 1: Define the stream locator**

Create `packages/domain/src/Stream.ts`:

```ts
import { Schema } from "effect"

export const StreamLocator = Schema.Union([Schema.TaggedStruct("WebView", { url: Schema.String })])
export type StreamLocator = typeof StreamLocator.Type
```

- [ ] **Step 2: Write the failing tests for the Stage state machine**

Create `packages/domain/src/Stage.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { Option, Result } from "effect"
import { GameId } from "./Game.ts"
import * as Stage from "./Stage.ts"

const bama = GameId.make("401856707")
const irish = GameId.make("401858250")
const onFox = () => Option.some({ _tag: "WebView" as const, url: "https://tv.youtube.com/watch/fox" })
const nowhere = () => Option.none()

describe("Stage.apply", () => {
  it("assigns a streamable game as a stream tile", () => {
    const stage = Result.getOrThrow(
      Stage.apply(Stage.initial, { _tag: "Assign", tile: 1, game: bama }, onFox)
    )
    assert.deepStrictEqual(stage.tiles[1], {
      _tag: "StreamTile",
      game: bama,
      locator: { _tag: "WebView", url: "https://tv.youtube.com/watch/fox" }
    })
  })

  it("assigns a game with no stream as a data tile", () => {
    const stage = Result.getOrThrow(
      Stage.apply(Stage.initial, { _tag: "Assign", tile: 0, game: bama }, nowhere)
    )
    assert.deepStrictEqual(stage.tiles[0], { _tag: "DataTile", game: bama })
  })

  it("moves a game rather than showing it twice", () => {
    const first = Result.getOrThrow(
      Stage.apply(Stage.initial, { _tag: "Assign", tile: 0, game: bama }, onFox)
    )
    const second = Result.getOrThrow(Stage.apply(first, { _tag: "Assign", tile: 2, game: bama }, onFox))
    assert.strictEqual(second.tiles[0]?._tag, "Empty")
    assert.strictEqual(second.tiles[2]?._tag, "StreamTile")
  })

  it("clears a tile and leaves the others", () => {
    const a = Result.getOrThrow(Stage.apply(Stage.initial, { _tag: "Assign", tile: 0, game: bama }, onFox))
    const b = Result.getOrThrow(Stage.apply(a, { _tag: "Assign", tile: 1, game: irish }, onFox))
    const c = Result.getOrThrow(Stage.apply(b, { _tag: "Clear", tile: 0 }, onFox))
    assert.strictEqual(c.tiles[0]?._tag, "Empty")
    assert.strictEqual(c.tiles[1]?._tag, "StreamTile")
  })

  it("moves audio focus", () => {
    const stage = Result.getOrThrow(Stage.apply(Stage.initial, { _tag: "FocusAudio", tile: 3 }, nowhere))
    assert.strictEqual(stage.audioFocus, 3)
  })

  it("rejects a tile that does not exist", () => {
    const result = Stage.apply(Stage.initial, { _tag: "FocusAudio", tile: 4 }, nowhere)
    assert.isTrue(Result.isFailure(result))
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/domain/src/Stage.test.ts`
Expected: FAIL — cannot resolve `./Stage.ts`.

- [ ] **Step 4: Implement the Stage**

Create `packages/domain/src/Stage.ts`:

```ts
import { Option, Result, Schema } from "effect"
import { GameId } from "./Game.ts"
import { StreamLocator } from "./Stream.ts"

export const Tile = Schema.Union([
  Schema.TaggedStruct("Empty", {}),
  Schema.TaggedStruct("StreamTile", { game: GameId, locator: StreamLocator }),
  Schema.TaggedStruct("DataTile", { game: GameId })
])
export type Tile = typeof Tile.Type

export class Stage extends Schema.Class<Stage>("sportal/Stage")({
  tiles: Schema.Array(Tile),
  audioFocus: Schema.Int
}) {}

export const StageCommand = Schema.Union([
  Schema.TaggedStruct("Assign", { tile: Schema.Int, game: GameId }),
  Schema.TaggedStruct("Clear", { tile: Schema.Int }),
  Schema.TaggedStruct("FocusAudio", { tile: Schema.Int })
])
export type StageCommand = typeof StageCommand.Type

export class StageRejection extends Schema.TaggedError<StageRejection>()(
  "StageRejection",
  { reason: Schema.Literals(["no-such-tile"]) },
  { httpApiStatus: 422 }
) {}

const empty: Tile = { _tag: "Empty" }

export const initial = new Stage({ tiles: [empty, empty, empty, empty], audioFocus: 0 })

/**
 * Applies a command. `locate` says where a game can be streamed from, if anywhere;
 * a game with no stream becomes a data tile.
 */
export function apply(
  stage: Stage,
  command: StageCommand,
  locate: (game: GameId) => Option.Option<StreamLocator>
): Result.Result<Stage, StageRejection> {
  if (command.tile < 0 || command.tile >= stage.tiles.length) {
    return Result.fail(new StageRejection({ reason: "no-such-tile" }))
  }
  switch (command._tag) {
    case "Assign": {
      const tile: Tile = Option.match(locate(command.game), {
        onNone: () => ({ _tag: "DataTile", game: command.game }),
        onSome: (locator) => ({ _tag: "StreamTile", game: command.game, locator })
      })
      // A game appears in at most one tile: assigning it elsewhere moves it.
      const tiles = stage.tiles.map((existing, index) =>
        index === command.tile
          ? tile
          : existing._tag !== "Empty" && existing.game === command.game
            ? empty
            : existing
      )
      return Result.succeed(new Stage({ tiles, audioFocus: stage.audioFocus }))
    }
    case "Clear":
      return Result.succeed(
        new Stage({
          tiles: stage.tiles.map((existing, index) => (index === command.tile ? empty : existing)),
          audioFocus: stage.audioFocus
        })
      )
    case "FocusAudio":
      return Result.succeed(new Stage({ tiles: stage.tiles, audioFocus: command.tile }))
  }
}
```

`apply` is the only place Stage invariants live. It is pure: where a game can be streamed from is passed in as `locate`, so the Hub can supply real availability and tests can supply a stub.

- [ ] **Step 5: Run the tests and the full check**

Run: `pnpm exec vitest run packages/domain/src/Stage.test.ts`
Expected: PASS, 6 tests.

Run: `pnpm format && pnpm check`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(domain): stage state machine with stream and data tiles"
```

---

### Task 4: Hub — Provider port and ESPN adapter

**Files:**
- Create: `apps/hub/package.json`, `apps/hub/tsconfig.json`
- Create: `apps/hub/src/provider/Provider.ts`
- Create: `apps/hub/src/provider/espn/EspnPayload.ts`, `apps/hub/src/provider/espn/EspnProvider.ts`
- Create: `apps/hub/src/provider/espn/fixtures/fbs-scoreboard-live.json`, `nfl-scoreboard-pregame.json`
- Test: `apps/hub/src/provider/espn/EspnProvider.test.ts`

**Interfaces:**
- Consumes: `GameSnapshot`, `GameId`, `GameStatus`, `LeagueId`, `Situation`, `Team`, `TeamId` from Task 2.
- Produces:
  - `Provider` — Effect service with `slate(league: LeagueId): Effect<ReadonlyArray<GameSnapshot>, ProviderError>`.
  - `ProviderError` — tagged error with `league` and `cause`.
  - `EspnProvider.layer: Layer<Provider, never, HttpClient.HttpClient>`.

- [ ] **Step 1: Create the app**

Create `apps/hub/package.json`:

```json
{
  "name": "@sportal/hub",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch src/main.ts",
    "start": "node src/main.ts"
  },
  "dependencies": {
    "@effect/platform-node": "4.0.0",
    "@sportal/domain": "workspace:*",
    "effect": "4.0.0"
  }
}
```

Create `apps/hub/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Run: `pnpm install`

- [ ] **Step 2: Copy the recorded payloads in as fixtures**

Both were recorded from ESPN on 2026-10-03 and sit, uncommitted, under `fixtures/espn-recordings/`.

```bash
mkdir -p apps/hub/src/provider/espn/fixtures
gzip -dc fixtures/espn-recordings/2026-10-03/college-football/scoreboard/20261003T160848Z.json.gz \
  > apps/hub/src/provider/espn/fixtures/fbs-scoreboard-live.json
gzip -dc fixtures/espn-recordings/2026-10-03/nfl/scoreboard-pregame.json.gz \
  > apps/hub/src/provider/espn/fixtures/nfl-scoreboard-pregame.json
```

Run: `jq '.events | length' apps/hub/src/provider/espn/fixtures/*.json`
Expected: `59` then `16`.

- [ ] **Step 3: Define the port**

Create `apps/hub/src/provider/Provider.ts`:

```ts
import type { GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Context, type Effect, Schema } from "effect"

export class Provider extends Context.Service<
  Provider,
  {
    slate(league: LeagueId): Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderError>
  }
>()("sportal/hub/Provider") {}

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  league: LeagueId,
  cause: Schema.Defect()
}) {}
```

- [ ] **Step 4: Write the failing adapter tests**

Create `apps/hub/src/provider/espn/EspnProvider.test.ts`:

```ts
import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Provider } from "../Provider.ts"
import * as EspnProvider from "./EspnProvider.ts"

// Real payloads recorded from ESPN. A payload that breaks decoding gets added here before the fix.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")
const fbsLive = fixture("fbs-scoreboard-live")
const nflPregame = fixture("nfl-scoreboard-pregame")

const RecordedEspn = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(request.url.includes("/nfl/") ? nflPregame : fbsLive))
    )
  )
)

const TestLayer = EspnProvider.layer.pipe(Layer.provide(RecordedEspn))

describe("EspnProvider", () => {
  it.effect("decodes a live FBS scoreboard into snapshots", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      const slate = yield* provider.slate("fbs")

      assert.strictEqual(slate.length, 59)
      const game = slate.find((g) => g.id === "401862787")
      assert.strictEqual(game?.status, "live")
      assert.strictEqual(game?.away.team.abbreviation, "MEM")
      assert.strictEqual(game?.away.team.id, "fbs:235")
      assert.strictEqual(game?.away.score, 27)
      assert.deepStrictEqual(game?.broadcasts, ["ESPN+"])
      assert.strictEqual(game?.situation?.isRedZone, true)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("leaves out what ESPN reports with placeholder values", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      const game = (yield* provider.slate("fbs")).find((g) => g.id === "401862787")

      // ESPN sends rank 99 for an unranked team and down -1 between plays.
      assert.strictEqual(game?.home.ranking, undefined)
      assert.strictEqual(game?.situation?.down, undefined)
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("decodes an NFL scoreboard, namespacing team ids by league", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      const slate = yield* provider.slate("nfl")

      assert.strictEqual(slate.length, 16)
      assert.isTrue(slate.every((game) => game.league === "nfl" && game.home.team.id.startsWith("nfl:")))
      assert.isTrue(slate.some((game) => game.status === "scheduled" && game.situation === undefined))
    }).pipe(Effect.provide(TestLayer))
  )
})
```

The test replaces the HTTP client with one that answers from the recorded payloads, so the adapter's real request and decoding code runs.

- [ ] **Step 5: Run the tests to verify they fail**

Run: `pnpm exec vitest run apps/hub/src/provider/espn/EspnProvider.test.ts`
Expected: FAIL — cannot resolve `./EspnProvider.ts`.

- [ ] **Step 6: Describe ESPN's wire format**

Create `apps/hub/src/provider/espn/EspnPayload.ts`:

```ts
import { Schema } from "effect"

const Competitor = Schema.Struct({
  homeAway: Schema.Literals(["home", "away"]),
  score: Schema.optional(Schema.String),
  curatedRank: Schema.optional(Schema.Struct({ current: Schema.Int })),
  team: Schema.Struct({
    id: Schema.String,
    abbreviation: Schema.String,
    displayName: Schema.String,
    logo: Schema.optional(Schema.String)
  })
})

const Situation = Schema.Struct({
  possession: Schema.optional(Schema.String),
  down: Schema.optional(Schema.Int),
  distance: Schema.optional(Schema.Int),
  yardLine: Schema.optional(Schema.Int),
  isRedZone: Schema.optional(Schema.Boolean),
  homeTimeouts: Schema.optional(Schema.Int),
  awayTimeouts: Schema.optional(Schema.Int),
  lastPlay: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) }))
})

export const Event = Schema.Struct({
  id: Schema.String,
  date: Schema.String,
  status: Schema.Struct({
    period: Schema.Int,
    displayClock: Schema.String,
    type: Schema.Struct({
      name: Schema.String,
      state: Schema.Literals(["pre", "in", "post"])
    })
  }),
  competitions: Schema.NonEmptyArray(
    Schema.Struct({
      broadcasts: Schema.optional(Schema.Array(Schema.Struct({ names: Schema.Array(Schema.String) }))),
      situation: Schema.optional(Situation),
      competitors: Schema.Array(Competitor)
    })
  )
})

export const Scoreboard = Schema.Struct({
  events: Schema.Array(Schema.Unknown)
})
```

This is ESPN's vocabulary ("event", "competition", "competitor") and the only file allowed to use it; the import-boundary rule `provider-payloads-are-private` enforces that. `Scoreboard.events` is `Unknown` on purpose: each event is decoded separately so one malformed game cannot fail the whole slate.

- [ ] **Step 7: Implement the adapter**

Create `apps/hub/src/provider/espn/EspnProvider.ts`:

```ts
import { GameId, GameSnapshot, type GameStatus } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Situation } from "@sportal/domain/Situation"
import { Team, TeamId } from "@sportal/domain/Team"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Provider, ProviderError } from "../Provider.ts"
import * as EspnPayload from "./EspnPayload.ts"

export const layer = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)

    const slate = Effect.fn("EspnProvider.slate")(function* (league: LeagueId) {
      const scoreboard = yield* client.get(scoreboardUrl(league)).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(EspnPayload.Scoreboard)),
        Effect.mapError((cause) => new ProviderError({ league, cause }))
      )
      const snapshots: Array<GameSnapshot> = []
      for (const raw of scoreboard.events) {
        const event = decodeEvent(raw)
        if (Option.isNone(event)) {
          yield* Effect.logWarning("EspnProvider: skipped an event that failed to decode", raw)
          continue
        }
        const snapshot = toSnapshot(league, event.value)
        if (Option.isSome(snapshot)) snapshots.push(snapshot.value)
      }
      return snapshots
    })

    return Provider.of({ slate })
  })
)

const decodeEvent = Schema.decodeUnknownOption(EspnPayload.Event)

function scoreboardUrl(league: LeagueId): string {
  const base = "https://site.api.espn.com/apis/site/v2/sports/football"
  return league === "nfl"
    ? `${base}/nfl/scoreboard`
    : `${base}/college-football/scoreboard?groups=80&limit=300`
}

function toSnapshot(league: LeagueId, event: typeof EspnPayload.Event.Type): Option.Option<GameSnapshot> {
  const competition = event.competitions[0]
  const home = competition.competitors.find((c) => c.homeAway === "home")
  const away = competition.competitors.find((c) => c.homeAway === "away")
  const kickoff = DateTime.make(event.date)
  if (home === undefined || away === undefined || Option.isNone(kickoff)) return Option.none()

  const side = (competitor: typeof home) => ({
    team: new Team({
      id: TeamId.make(`${league}:${competitor.team.id}`),
      abbreviation: competitor.team.abbreviation,
      name: competitor.team.displayName,
      ...(competitor.team.logo === undefined ? {} : { logo: competitor.team.logo })
    }),
    score: Number.parseInt(competitor.score ?? "0", 10) || 0,
    // ESPN reports 99 for unranked teams.
    ...(competitor.curatedRank === undefined || competitor.curatedRank.current > 25
      ? {}
      : { ranking: competitor.curatedRank.current })
  })

  const s = competition.situation
  return Option.some(
    new GameSnapshot({
      id: GameId.make(event.id),
      league,
      kickoff: DateTime.toUtc(kickoff.value),
      status: toStatus(event.status.type),
      period: event.status.period,
      clock: event.status.displayClock,
      home: side(home),
      away: side(away),
      broadcasts: (competition.broadcasts ?? []).flatMap((b) => b.names),
      ...(s === undefined
        ? {}
        : {
            situation: new Situation({
              isRedZone: s.isRedZone ?? false,
              homeTimeouts: s.homeTimeouts ?? 0,
              awayTimeouts: s.awayTimeouts ?? 0,
              ...(s.possession === undefined ? {} : { possession: TeamId.make(`${league}:${s.possession}`) }),
              // ESPN reports down -1 between plays (after a score, before a kickoff).
              ...(s.down === undefined || s.down < 1 ? {} : { down: s.down }),
              ...(s.distance === undefined ? {} : { distance: s.distance }),
              ...(s.yardLine === undefined ? {} : { yardLine: s.yardLine }),
              ...(s.lastPlay?.text === undefined ? {} : { lastPlay: s.lastPlay.text })
            })
          })
    })
  )
}

function toStatus(type: { readonly name: string; readonly state: "pre" | "in" | "post" }): GameStatus {
  switch (type.name) {
    case "STATUS_HALFTIME":
      return "halftime"
    case "STATUS_DELAYED":
      return "delayed"
    case "STATUS_POSTPONED":
      return "postponed"
    case "STATUS_CANCELED":
      return "canceled"
  }
  return type.state === "pre" ? "scheduled" : type.state === "in" ? "live" : "final"
}
```

- [ ] **Step 8: Run the tests and the full check**

Run: `pnpm exec vitest run apps/hub/src/provider/espn/EspnProvider.test.ts`
Expected: PASS, 3 tests.

Run: `pnpm format && pnpm check`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(hub): provider port and ESPN scoreboard adapter"
```

---

### Task 5: Hub — Cadence and Ingest

**Files:**
- Create: `apps/hub/src/ingest/Cadence.ts`, `apps/hub/src/ingest/Ingest.ts`
- Test: `apps/hub/src/ingest/Ingest.test.ts`

**Interfaces:**
- Consumes: `Provider`, `ProviderError` from Task 4; `GameSnapshot`, `isLive`, `LeagueId` from Task 2.
- Produces:
  - `Cadence.interval(slate, now: DateTime.Utc): Duration.Duration` — 10 seconds if any game is live, 1 minute if a kickoff is within 30 minutes, otherwise 15 minutes.
  - `Ingest` — Effect service with `slate: Effect<ReadonlyArray<GameSnapshot>>` and `changes: Stream<ReadonlyArray<GameSnapshot>>` (emits the current slate to a new subscriber, then every update).
  - `Ingest.layer(leagues: ReadonlyArray<LeagueId>): Layer<Ingest, never, Provider>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/hub/src/ingest/Ingest.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { Team, TeamId } from "@sportal/domain/Team"
import { DateTime, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Provider, ProviderError } from "../provider/Provider.ts"
import { Ingest } from "./Ingest.ts"

function liveGame(homeScore: number) {
  const team = (abbreviation: string) =>
    new Team({ id: TeamId.make(`fbs:${abbreviation}`), abbreviation, name: abbreviation })
  return new GameSnapshot({
    id: GameId.make("1"),
    league: "fbs",
    kickoff: DateTime.makeUnsafe("2026-10-03T16:00:00Z"),
    status: "live",
    period: 1,
    clock: "10:00",
    home: { team: team("MSST"), score: homeScore },
    away: { team: team("ALA"), score: 0 },
    broadcasts: ["ESPN"]
  })
}

/** A provider that answers each poll with the next scripted response. */
function scripted(responses: ReadonlyArray<ReadonlyArray<GameSnapshot> | "fail">) {
  let call = 0
  return Layer.succeed(
    Provider,
    Provider.of({
      slate: (league) => {
        const response = responses[Math.min(call++, responses.length - 1)]
        return response === "fail" || response === undefined
          ? Effect.fail(new ProviderError({ league, cause: "down" }))
          : Effect.succeed(response)
      }
    })
  )
}

describe("Ingest", () => {
  it.effect("polls again after the live cadence and publishes the new slate", () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      yield* TestClock.adjust(0)
      assert.strictEqual((yield* ingest.slate)[0]?.home.score, 0)

      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* ingest.slate)[0]?.home.score, 7)
    }).pipe(
      Effect.provide(Ingest.layer(["fbs"]).pipe(Layer.provide(scripted([[liveGame(0)], [liveGame(7)]]))))
    )
  )

  it.effect("keeps the last slate when the provider fails", () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      yield* TestClock.adjust(0)
      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* ingest.slate)[0]?.home.score, 7)
    }).pipe(Effect.provide(Ingest.layer(["fbs"]).pipe(Layer.provide(scripted([[liveGame(7)], "fail"])))))
  )
})
```

`it.effect` runs under Effect's test clock: time only moves when the test calls `TestClock.adjust`, so the polling loop is exercised without waiting. `TestClock.adjust(0)` lets the loop's first poll run.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run apps/hub/src/ingest/Ingest.test.ts`
Expected: FAIL — cannot resolve `./Ingest.ts`.

- [ ] **Step 3: Implement the cadence**

Create `apps/hub/src/ingest/Cadence.ts`:

```ts
import { type GameSnapshot, isLive } from "@sportal/domain/Game"
import { DateTime, Duration } from "effect"

/** How long to wait before the next poll, given what the last one saw. */
export function interval(slate: ReadonlyArray<GameSnapshot>, now: DateTime.Utc): Duration.Duration {
  if (slate.some(isLive)) return Duration.seconds(10)
  const soon = DateTime.add(now, { minutes: 30 })
  const kickoffSoon = slate.some(
    (game) => game.status === "scheduled" && DateTime.isLessThanOrEqualTo(game.kickoff, soon)
  )
  return kickoffSoon ? Duration.minutes(1) : Duration.minutes(15)
}
```

- [ ] **Step 4: Implement the ingest loop**

Create `apps/hub/src/ingest/Ingest.ts`:

```ts
import type { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Context, DateTime, Effect, Layer, type Stream, SubscriptionRef } from "effect"
import { Provider } from "../provider/Provider.ts"
import * as Cadence from "./Cadence.ts"

export class Ingest extends Context.Service<
  Ingest,
  {
    readonly slate: Effect.Effect<ReadonlyArray<GameSnapshot>>
    readonly changes: Stream.Stream<ReadonlyArray<GameSnapshot>>
  }
>()("sportal/hub/Ingest") {
  static readonly layer = (leagues: ReadonlyArray<LeagueId>) =>
    Layer.effect(
      Ingest,
      Effect.gen(function* () {
        const provider = yield* Provider
        const current = yield* SubscriptionRef.make<ReadonlyArray<GameSnapshot>>([])
        // The last good slate per league, so one league failing does not blank the other.
        const byLeague = new Map<LeagueId, ReadonlyArray<GameSnapshot>>()

        const poll = Effect.gen(function* () {
          for (const league of leagues) {
            yield* provider.slate(league).pipe(
              Effect.map((slate) => byLeague.set(league, slate)),
              Effect.catchTag("ProviderError", (error) =>
                Effect.logWarning("Ingest: keeping the last slate after a provider failure", error)
              )
            )
          }
          const slate = leagues.flatMap((league) => byLeague.get(league) ?? [])
          yield* SubscriptionRef.set(current, slate)
          yield* Effect.sleep(Cadence.interval(slate, yield* DateTime.now))
        })

        yield* Effect.forkScoped(Effect.forever(poll))

        return Ingest.of({
          slate: SubscriptionRef.get(current),
          changes: SubscriptionRef.changes(current)
        })
      })
    )
}
```

- [ ] **Step 5: Run the tests and the full check**

Run: `pnpm exec vitest run apps/hub/src/ingest/Ingest.test.ts`
Expected: PASS, 2 tests.

Run: `pnpm format && pnpm check`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(hub): ingest loop with adaptive polling cadence"
```

---

### Task 6: API contract and the Hub server

**Files:**
- Create: `packages/api/package.json`, `packages/api/tsconfig.json`
- Create: `packages/api/src/SportalApi.ts`, `packages/api/src/LiveMessage.ts`
- Create: `apps/hub/src/source/Source.ts`, `apps/hub/src/source/YouTubeTv.ts`, `apps/hub/src/source/youtube-tv-channels.json`
- Create: `apps/hub/src/stage/StageSessions.ts`
- Create: `apps/hub/src/http/HubServer.ts`, `apps/hub/src/main.ts`
- Test: `apps/hub/src/http/HubServer.test.ts`

**Interfaces:**
- Consumes: `Ingest` (Task 5); `Stage`, `StageCommand`, `StageRejection`, `Stage.apply`, `Stage.initial` (Task 3); `GameSnapshot` (Task 2); `EspnProvider.layer` (Task 4).
- Produces:
  - `SportalApi` — `GET /api/slate` → `GameSnapshot[]`; `GET /api/stage` → `Stage`; `POST /api/stage/commands` with body `{ command: StageCommand }` → `Stage`, or 422 `StageRejection`.
  - `LiveMessage` — `{ _tag: "SlateChanged", slate } | { _tag: "StageChanged", stage }`; `LiveMessageJson` — the same as a JSON-string codec.
  - `GET /api/live` — server-sent events, one `LiveMessage` JSON object per event; a new connection first receives the current slate and stage.
  - `Source` — Effect service with `locate(game: GameSnapshot): Option<StreamLocator>`.
  - `YouTubeTv.layer(channels: Record<string, string>): Layer<Source>`.
  - `StageSessions` — Effect service with `stage`, `changes`, `dispatch(command)`.
  - `HubServer.ApiHandlers`, `HubServer.layer`.
  - A runnable Hub: `pnpm --filter @sportal/hub dev`, configured by `SPORTAL_PORT` (default 4400), `SPORTAL_HOST` (default 127.0.0.1), `SPORTAL_WEB_ROOT` (optional path to the built web UI).

- [ ] **Step 1: Create the api package and declare the contract**

Create `packages/api/package.json`:

```json
{
  "name": "@sportal/api",
  "private": true,
  "type": "module",
  "exports": {
    "./*": "./src/*.ts"
  },
  "dependencies": {
    "@sportal/domain": "workspace:*",
    "effect": "4.0.0"
  }
}
```

Create `packages/api/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Add `"@sportal/api": "workspace:*"` to the `dependencies` of `apps/hub/package.json`, directly above `@sportal/domain`, then run `pnpm install`.

Create `packages/api/src/SportalApi.ts`:

```ts
import { GameSnapshot } from "@sportal/domain/Game"
import { Stage, StageCommand, StageRejection } from "@sportal/domain/Stage"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

export class SportalApi extends HttpApi.make("sportal")
  .add(
    HttpApiGroup.make("slate").add(
      HttpApiEndpoint.get("current", "/slate", { success: Schema.Array(GameSnapshot) })
    )
  )
  .add(
    HttpApiGroup.make("stage").add(
      HttpApiEndpoint.get("current", "/stage", { success: Stage }),
      HttpApiEndpoint.post("dispatch", "/stage/commands", {
        payload: Schema.Struct({ command: StageCommand }),
        success: Stage,
        error: StageRejection
      })
    )
  )
  .prefix("/api") {}
```

The command is wrapped as `{ command }` rather than sent bare. A bare union payload makes the generated client's parameter type distribute over the union, so a caller holding a `StageCommand` variable cannot pass it.

Create `packages/api/src/LiveMessage.ts`:

```ts
import { GameSnapshot } from "@sportal/domain/Game"
import { Stage } from "@sportal/domain/Stage"
import { Schema } from "effect"

/** A message on the live stream at GET /api/live, sent as one JSON object per server-sent event. */
export const LiveMessage = Schema.Union([
  Schema.TaggedStruct("SlateChanged", { slate: Schema.Array(GameSnapshot) }),
  Schema.TaggedStruct("StageChanged", { stage: Stage })
])
export type LiveMessage = typeof LiveMessage.Type

export const LiveMessageJson = Schema.fromJsonString(LiveMessage)
```

- [ ] **Step 2: Write the failing server test**

Create `apps/hub/src/http/HubServer.test.ts`:

```ts
import { assert, layer } from "@effect/vitest"
import { SportalApi } from "@sportal/api/SportalApi"
import { GameId, GameSnapshot } from "@sportal/domain/Game"
import { Team, TeamId } from "@sportal/domain/Team"
import { DateTime, Effect, Layer } from "effect"
import { HttpServer } from "effect/http"
import { HttpApiTest } from "effect/http-api"
import { Ingest } from "../ingest/Ingest.ts"
import { Provider } from "../provider/Provider.ts"
import * as YouTubeTv from "../source/YouTubeTv.ts"
import { StageSessions } from "../stage/StageSessions.ts"
import { ApiHandlers } from "./HubServer.ts"

const game = new GameSnapshot({
  id: GameId.make("401856707"),
  league: "fbs",
  kickoff: DateTime.makeUnsafe("2026-10-03T16:00:00Z"),
  status: "scheduled",
  period: 0,
  clock: "0:00",
  home: {
    team: new Team({ id: TeamId.make("fbs:344"), abbreviation: "MSST", name: "Mississippi State" }),
    score: 0
  },
  away: { team: new Team({ id: TeamId.make("fbs:333"), abbreviation: "ALA", name: "Alabama" }), score: 0 },
  broadcasts: ["ESPN"]
})

const TestHub = ApiHandlers.pipe(
  Layer.provide(StageSessions.layer),
  Layer.provide(YouTubeTv.layer({ ESPN: "https://tv.youtube.com/watch/espn" })),
  Layer.provide(Ingest.layer(["fbs"])),
  Layer.provide(Layer.succeed(Provider, Provider.of({ slate: () => Effect.succeed([game]) })))
)

const makeClient = HttpApiTest.groups(SportalApi, ["slate", "stage"])

layer(Layer.mergeAll(TestHub, HttpServer.layerServices))("Hub API", (it) => {
  it.effect("serves the slate and turns an assignment into a stream tile", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      // Let the ingest loop's first poll run.
      yield* Effect.yieldNow

      const slate = yield* client.slate.current()
      assert.strictEqual(slate[0]?.away.team.abbreviation, "ALA")
      assert.isTrue(DateTime.isDateTime(slate[0]?.kickoff))

      const stage = yield* client.stage.dispatch({
        payload: { command: { _tag: "Assign", tile: 0, game: game.id } }
      })
      assert.deepStrictEqual(stage.tiles[0], {
        _tag: "StreamTile",
        game: game.id,
        locator: { _tag: "WebView", url: "https://tv.youtube.com/watch/espn" }
      })

      const rejected = yield* client.stage
        .dispatch({ payload: { command: { _tag: "Clear", tile: 9 } } })
        .pipe(Effect.flip)
      assert.strictEqual(rejected._tag, "StageRejection")
    })
  )
})
```

`HttpApiTest.groups` builds a typed client wired straight to the handlers: real request encoding, routing, and response decoding, with no socket.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run apps/hub/src/http/HubServer.test.ts`
Expected: FAIL — cannot resolve `../source/YouTubeTv.ts`.

- [ ] **Step 4: Implement the Source port and the YouTube TV source**

Create `apps/hub/src/source/Source.ts`:

```ts
import type { GameSnapshot } from "@sportal/domain/Game"
import type { StreamLocator } from "@sportal/domain/Stream"
import { Context, type Option } from "effect"

export class Source extends Context.Service<
  Source,
  {
    locate(game: GameSnapshot): Option.Option<StreamLocator>
  }
>()("sportal/hub/Source") {}
```

Create `apps/hub/src/source/YouTubeTv.ts`:

```ts
import { Layer, Option } from "effect"
import { Source } from "./Source.ts"

/** `channels` maps a broadcast network name, as the provider reports it, to that channel's YouTube TV address. */
export const layer = (channels: Readonly<Record<string, string>>) =>
  Layer.succeed(
    Source,
    Source.of({
      locate: (game) => {
        const url = game.broadcasts.map((network) => channels[network]).find((found) => found !== undefined)
        return url === undefined ? Option.none() : Option.some({ _tag: "WebView", url })
      }
    })
  )
```

Create `apps/hub/src/source/youtube-tv-channels.json` — empty until Task 8 fills it in. With no channels every assignment becomes a data tile, which is the correct behaviour for an unknown channel:

```json
{}
```

- [ ] **Step 5: Implement stage sessions**

Create `apps/hub/src/stage/StageSessions.ts`:

```ts
import * as Stage from "@sportal/domain/Stage"
import { Context, Effect, Layer, Option, Result, type Stream, SubscriptionRef } from "effect"
import { Ingest } from "../ingest/Ingest.ts"
import { Source } from "../source/Source.ts"

export class StageSessions extends Context.Service<
  StageSessions,
  {
    readonly stage: Effect.Effect<Stage.Stage>
    readonly changes: Stream.Stream<Stage.Stage>
    dispatch(command: Stage.StageCommand): Effect.Effect<Stage.Stage, Stage.StageRejection>
  }
>()("sportal/hub/StageSessions") {
  static readonly layer = Layer.effect(
    StageSessions,
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const source = yield* Source
      const current = yield* SubscriptionRef.make(Stage.initial)

      const dispatch = Effect.fn("StageSessions.dispatch")(function* (command: Stage.StageCommand) {
        const slate = yield* ingest.slate
        const result = Stage.apply(yield* SubscriptionRef.get(current), command, (id) =>
          Option.fromNullishOr(slate.find((game) => game.id === id)).pipe(Option.flatMap(source.locate))
        )
        if (Result.isFailure(result)) return yield* result.failure
        yield* SubscriptionRef.set(current, result.success)
        return result.success
      })

      return StageSessions.of({
        stage: SubscriptionRef.get(current),
        changes: SubscriptionRef.changes(current),
        dispatch
      })
    })
  )
}
```

This slice has one Stage for one Display, held in memory. The name is plural because the spec's design is one session per Display; that arrives with multi-display support.

- [ ] **Step 6: Implement the server**

Create `apps/hub/src/http/HubServer.ts`:

```ts
import { type LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import { SportalApi } from "@sportal/api/SportalApi"
import { Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Ingest } from "../ingest/Ingest.ts"
import { StageSessions } from "../stage/StageSessions.ts"

/** The handlers for every endpoint group in SportalApi. Exported so tests can drive them without a socket. */
export const ApiHandlers = Layer.mergeAll(slateHandlers(), stageHandlers())

/** Every route the Hub serves: the API, and the live stream. */
export const layer = Layer.mergeAll(
  HttpApiBuilder.layer(SportalApi).pipe(Layer.provide(ApiHandlers)),
  liveRoute()
)

function slateHandlers() {
  return HttpApiBuilder.group(
    SportalApi,
    "slate",
    Effect.fn(function* (handlers) {
      const ingest = yield* Ingest
      return handlers.handleAll({ current: () => ingest.slate })
    })
  )
}

function stageHandlers() {
  return HttpApiBuilder.group(
    SportalApi,
    "stage",
    Effect.fn(function* (handlers) {
      const sessions = yield* StageSessions
      return handlers.handleAll({
        current: () => sessions.stage,
        dispatch: ({ payload }) => sessions.dispatch(payload.command)
      })
    })
  )
}

/** GET /api/live — the current slate and stage, then every change, as server-sent events. */
function liveRoute() {
  return HttpRouter.add(
    "GET",
    "/api/live",
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const sessions = yield* StageSessions
      const messages: Stream.Stream<LiveMessage> = Stream.merge(
        ingest.changes.pipe(Stream.map((slate) => ({ _tag: "SlateChanged" as const, slate }))),
        sessions.changes.pipe(Stream.map((stage) => ({ _tag: "StageChanged" as const, stage })))
      )
      const encode = Schema.encodeSync(LiveMessageJson)
      return HttpServerResponse.stream(
        messages.pipe(
          Stream.map((message) => `data: ${encode(message)}\n\n`),
          Stream.encodeText
        ),
        { contentType: "text/event-stream", headers: { "cache-control": "no-cache" } }
      )
    })
  )
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm exec vitest run apps/hub/src/http/HubServer.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 8: Write the composition root**

Create `apps/hub/src/main.ts`:

```ts
import { createServer } from "node:http"
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpRouter, HttpStaticServer } from "effect/http"
import * as HubServer from "./http/HubServer.ts"
import { Ingest } from "./ingest/Ingest.ts"
import * as EspnProvider from "./provider/espn/EspnProvider.ts"
import * as YouTubeTv from "./source/YouTubeTv.ts"
import channels from "./source/youtube-tv-channels.json" with { type: "json" }
import { StageSessions } from "./stage/StageSessions.ts"

const Hub = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port("SPORTAL_PORT").pipe(Config.withDefault(4400))
    const host = yield* Config.String("SPORTAL_HOST").pipe(Config.withDefault("127.0.0.1"))
    // The built web UI, served by the Hub outside development.
    const webRoot = yield* Config.String("SPORTAL_WEB_ROOT").pipe(Config.option)

    const routes = Option.match(webRoot, {
      onNone: () => HubServer.layer,
      onSome: (root) => Layer.mergeAll(HubServer.layer, HttpStaticServer.layer({ root, spa: true }))
    })

    return HttpRouter.serve(routes).pipe(
      Layer.provide(StageSessions.layer),
      Layer.provide(YouTubeTv.layer(channels)),
      Layer.provide(Ingest.layer(["nfl", "fbs"])),
      Layer.provide(EspnProvider.layer),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(NodeHttpServer.layer(createServer, { port, host })),
      Layer.provide(NodeServices.layer)
    )
  })
)

Layer.launch(Hub).pipe(NodeRuntime.runMain)
```

This is the only non-test file that names `EspnProvider` and `YouTubeTv`; the rule `only-main-names-adapters` enforces it.

- [ ] **Step 9: Run the Hub against the real feed**

Run: `pnpm format && pnpm check`
Expected: all green.

Run in one terminal: `pnpm --filter @sportal/hub dev`
Run in another:

```bash
curl -s localhost:4400/api/slate | jq 'length, (group_by(.league) | map("\(.[0].league): \(length)"))'
curl -s -X POST localhost:4400/api/stage/commands -H 'content-type: application/json' \
  -d '{"command":{"_tag":"FocusAudio","tile":2}}' | jq .audioFocus
curl -s -m 3 -N localhost:4400/api/live | cut -c1-80
```

Expected: a game count with an `fbs` and an `nfl` group; `2`; then two lines beginning `data: {"_tag":"SlateChanged"` and `data: {"_tag":"StageChanged"`. Stop the Hub.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(hub): typed API, live stream, stage sessions, and YouTube TV source"
```

---

### Task 7: Web UI — slate and Stage

**Files:**
- Create: `packages/api/src/ShellBridge.ts`
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/index.html`, `apps/web/vite.config.ts`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/theme/theme.css`
- Create: `apps/web/src/hub/HubClient.ts`, `apps/web/src/hub/Live.ts`
- Create: `apps/web/src/slate/SlateView.tsx`, `apps/web/src/stage/StageView.tsx`
- Test: `apps/web/src/hub/Live.test.ts`

**Interfaces:**
- Consumes: `SportalApi`, `LiveMessage`, `LiveMessageJson` (Task 6); `Stage`, `Tile`, `StageCommand`, `Stage.initial` (Task 3); `GameSnapshot`, `isLive`, `Slate.inWatchOrder` (Task 2).
- Produces:
  - `ShellBridge.TilePlacement` — `{ tile, url, bounds: { x, y, width, height }, muted }`, as a schema and a type.
  - `ShellBridge.ShellBridge` — `{ syncTiles(placements: ReadonlyArray<TilePlacement>): void }`, which the web UI calls as `window.sportalShell?.syncTiles(...)`. Task 9 implements it.
  - `HubClient.dispatch(command: StageCommand): void`.
  - `Live.useLive()` → `{ slate, stage, connected }`; `Live.reduce(live, message)`; `Live.disconnected`.
  - A web UI at http://127.0.0.1:4401 in development.

- [ ] **Step 1: Declare the shell bridge contract**

Create `packages/api/src/ShellBridge.ts`:

```ts
import { Schema } from "effect"

/** Where one stream tile sits in the Display's window, in CSS pixels, and what it plays. */
export const TilePlacement = Schema.Struct({
  tile: Schema.Int,
  url: Schema.String,
  bounds: Schema.Struct({ x: Schema.Int, y: Schema.Int, width: Schema.Int, height: Schema.Int }),
  muted: Schema.Boolean
})
export type TilePlacement = typeof TilePlacement.Type

/** What the desktop shell exposes to the web UI as `window.sportalShell`. Absent in a plain browser. */
export interface ShellBridge {
  /** Replaces the full set of provider views: views not listed are closed. */
  syncTiles(placements: ReadonlyArray<TilePlacement>): void
}
```

- [ ] **Step 2: Create the app**

Create `apps/web/package.json`:

```json
{
  "name": "@sportal/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "@sportal/api": "workspace:*",
    "@sportal/domain": "workspace:*",
    "effect": "4.0.0",
    "react": "^19.3.0",
    "react-dom": "^19.3.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.3",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "latest",
    "tailwindcss": "^4.3.3",
    "vite": "^8.3.2"
  }
}
```

Create `apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

Create `apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sportal</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `apps/web/vite.config.ts`:

```ts
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4401,
    // In development the Hub runs separately; in production it serves this app itself.
    proxy: { "/api": "http://127.0.0.1:4400" }
  }
})
```

Create `apps/web/src/theme/theme.css`:

```css
@import "tailwindcss";
```

Run: `pnpm install`

- [ ] **Step 3: Write the failing test for the live store**

Create `apps/web/src/hub/Live.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import * as Stage from "@sportal/domain/Stage"
import { disconnected, reduce } from "./Live.ts"

describe("Live.reduce", () => {
  it("replaces the stage and keeps the slate", () => {
    const stage = new Stage.Stage({ tiles: Stage.initial.tiles, audioFocus: 2 })
    const next = reduce(disconnected, { _tag: "StageChanged", stage })
    assert.strictEqual(next.stage.audioFocus, 2)
    assert.strictEqual(next.slate, disconnected.slate)
  })

  it("replaces the slate and keeps the stage", () => {
    const next = reduce(disconnected, { _tag: "SlateChanged", slate: [] })
    assert.deepStrictEqual(next.slate, [])
    assert.strictEqual(next.stage, disconnected.stage)
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm exec vitest run apps/web/src/hub/Live.test.ts`
Expected: FAIL — cannot resolve `./Live.ts`.

- [ ] **Step 5: Implement the live store and the Hub client**

Create `apps/web/src/hub/Live.ts`:

```ts
import { type LiveMessage, LiveMessageJson } from "@sportal/api/LiveMessage"
import type { GameSnapshot } from "@sportal/domain/Game"
import * as Stage from "@sportal/domain/Stage"
import { Schema } from "effect"
import { useSyncExternalStore } from "react"

/** Everything the Hub has told this client, kept current by the live stream at /api/live. */
export function useLive() {
  return useSyncExternalStore(subscribe, () => state)
}

export const disconnected = {
  slate: [] as ReadonlyArray<GameSnapshot>,
  stage: Stage.initial,
  connected: false
}

export function reduce(live: typeof disconnected, message: LiveMessage): typeof disconnected {
  switch (message._tag) {
    case "SlateChanged":
      return { ...live, slate: message.slate }
    case "StageChanged":
      return { ...live, stage: message.stage }
  }
}

let state = disconnected
let events: EventSource | undefined
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (events === undefined) events = connect()
  return () => {
    listeners.delete(listener)
  }
}

// EventSource reconnects by itself, and the Hub replays the current slate and stage on every connection.
function connect() {
  const source = new EventSource("/api/live")
  source.onopen = () => publish({ ...state, connected: true })
  source.onerror = () => publish({ ...state, connected: false })
  source.onmessage = (event) => publish(reduce(state, decodeLiveMessage(event.data)))
  return source
}

function publish(next: typeof disconnected) {
  state = next
  for (const listener of listeners) listener()
}

const decodeLiveMessage = Schema.decodeUnknownSync(LiveMessageJson)
```

Create `apps/web/src/hub/HubClient.ts`:

```ts
import { SportalApi } from "@sportal/api/SportalApi"
import type { StageCommand } from "@sportal/domain/Stage"
import { Context, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"

class HubClient extends Context.Service<HubClient, HttpApiClient.ForApi<typeof SportalApi>>()(
  "sportal/web/HubClient"
) {
  static readonly layer = Layer.effect(HubClient, HttpApiClient.make(SportalApi)).pipe(
    Layer.provide(FetchHttpClient.layer)
  )
}

const runtime = ManagedRuntime.make(HubClient.layer)

/** Sends a stage command. The resulting stage arrives on the live stream, not from this call. */
export function dispatch(command: StageCommand): void {
  runtime.runFork(HubClient.use((hub) => hub.stage.dispatch({ payload: { command } })))
}
```

The client is derived from `SportalApi`; there are no hand-written request or response types. The UI holds no copy of the Stage: a command goes to the Hub and the new Stage comes back on the live stream.

Run: `pnpm exec vitest run apps/web/src/hub/Live.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Build the views**

Create `apps/web/src/slate/SlateView.tsx`:

```tsx
import { type GameSnapshot, isLive } from "@sportal/domain/Game"
import * as Slate from "@sportal/domain/Slate"
import { DateTime } from "effect"

export function SlateView(props: {
  slate: ReadonlyArray<GameSnapshot>
  connected: boolean
  onPick: (game: GameSnapshot) => void
}) {
  return (
    <aside className="flex min-h-0 flex-col border-neutral-800 border-r">
      <header className="flex items-baseline justify-between px-3 py-2">
        <h1 className="font-semibold text-lg">Slate</h1>
        <span className={props.connected ? "text-emerald-400 text-xs" : "text-amber-400 text-xs"}>
          {props.connected ? "live" : "reconnecting…"}
        </span>
      </header>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {Slate.inWatchOrder(props.slate).map((game) => (
          <li key={game.id}>
            <button
              type="button"
              onClick={() => props.onPick(game)}
              className="grid w-full grid-cols-[1fr_auto] gap-x-3 px-3 py-2 text-left hover:bg-neutral-900"
            >
              <SideLine side={game.away} />
              <span className="row-span-2 self-center text-right text-neutral-400 text-xs">
                <span className={isLive(game) ? "block text-emerald-400" : "block"}>{statusText(game)}</span>
                {game.broadcasts.join(" · ")}
              </span>
              <SideLine side={game.home} />
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}

function SideLine(props: { side: GameSnapshot["home"] }) {
  return (
    <span className="flex justify-between tabular-nums">
      <span>
        {props.side.ranking !== undefined && (
          <span className="mr-1 text-neutral-500 text-xs">{props.side.ranking}</span>
        )}
        {props.side.team.abbreviation}
      </span>
      <span>{props.side.score}</span>
    </span>
  )
}

function statusText(game: GameSnapshot): string {
  switch (game.status) {
    case "live":
      return `Q${game.period} ${game.clock}`
    case "scheduled":
      return DateTime.toDateUtc(game.kickoff).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    default:
      return game.status
  }
}
```

Create `apps/web/src/stage/StageView.tsx`:

```tsx
import type { ShellBridge, TilePlacement } from "@sportal/api/ShellBridge"
import type { GameSnapshot } from "@sportal/domain/Game"
import type { Stage, Tile } from "@sportal/domain/Stage"
import { useLayoutEffect, useRef } from "react"
import { dispatch } from "../hub/HubClient.ts"

declare global {
  interface Window {
    sportalShell?: ShellBridge
  }
}

export function StageView(props: {
  stage: Stage
  slate: ReadonlyArray<GameSnapshot>
  selected: number
  onSelect: (tile: number) => void
}) {
  // One element per tile marking where its video goes; the shell lays a provider view over each.
  const videoAreas = useRef<Array<HTMLDivElement | null>>([])

  useLayoutEffect(() => {
    const sync = () => window.sportalShell?.syncTiles(placements(props.stage, videoAreas.current))
    sync()
    window.addEventListener("resize", sync)
    return () => window.removeEventListener("resize", sync)
  }, [props.stage])

  return (
    <main className="grid min-h-0 grid-cols-2 grid-rows-2 gap-1 p-1">
      {props.stage.tiles.map((tile, index) => {
        const game = tile._tag === "Empty" ? undefined : props.slate.find((g) => g.id === tile.game)
        const hasAudio = props.stage.audioFocus === index
        return (
          <section
            // biome-ignore lint/suspicious/noArrayIndexKey: a tile is identified by its slot.
            key={index}
            className={`flex min-h-0 flex-col rounded border ${
              props.selected === index ? "border-sky-500" : "border-neutral-800"
            }`}
          >
            <div
              ref={(element) => {
                videoAreas.current[index] = element
              }}
              className="flex min-h-0 flex-1 items-center justify-center bg-black text-neutral-500"
            >
              <TileBody tile={tile} />
            </div>
            <footer className="flex items-center gap-2 px-2 py-1 text-sm tabular-nums">
              <button type="button" className="flex-1 text-left" onClick={() => props.onSelect(index)}>
                {game === undefined
                  ? `Tile ${index + 1}`
                  : `${game.away.team.abbreviation} ${game.away.score} – ${game.home.score} ${game.home.team.abbreviation}`}
              </button>
              <button
                type="button"
                className={hasAudio ? "text-emerald-400" : "text-neutral-500"}
                onClick={() => dispatch({ _tag: "FocusAudio", tile: index })}
              >
                {hasAudio ? "audio on" : "audio"}
              </button>
              <button
                type="button"
                className="text-neutral-500"
                onClick={() => dispatch({ _tag: "Clear", tile: index })}
              >
                clear
              </button>
            </footer>
          </section>
        )
      })}
    </main>
  )
}

function TileBody(props: { tile: Tile }) {
  switch (props.tile._tag) {
    case "Empty":
      return <span>Pick a game from the slate</span>
    case "DataTile":
      return <span>No stream for this game on your sources</span>
    case "StreamTile":
      // Inside the shell this is covered by the provider view. In a plain browser it is the way to watch.
      return (
        <a className="underline" href={props.tile.locator.url} target="_blank" rel="noreferrer">
          Open in YouTube TV
        </a>
      )
  }
}

function placements(stage: Stage, videoAreas: ReadonlyArray<HTMLDivElement | null>): Array<TilePlacement> {
  return stage.tiles.flatMap((tile, index) => {
    const area = videoAreas[index]
    if (tile._tag !== "StreamTile" || area === null || area === undefined) return []
    const rect = area.getBoundingClientRect()
    return [
      {
        tile: index,
        url: tile.locator.url,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        muted: stage.audioFocus !== index
      }
    ]
  })
}
```

Each tile has a video area and a score strip beneath it. The shell covers the video area with a provider view; the strip stays visible because nothing is ever drawn on top of provider video.

Create `apps/web/src/App.tsx`:

```tsx
import { useState } from "react"
import { dispatch } from "./hub/HubClient.ts"
import { useLive } from "./hub/Live.ts"
import { SlateView } from "./slate/SlateView.tsx"
import { StageView } from "./stage/StageView.tsx"

export function App() {
  const live = useLive()
  // The tile the next picked game goes to. Local to this client: it is a cursor, not shared state.
  const [selected, setSelected] = useState(0)

  return (
    <div className="grid h-screen grid-cols-[22rem_1fr] bg-neutral-950 text-neutral-100">
      <SlateView
        slate={live.slate}
        connected={live.connected}
        onPick={(game) => dispatch({ _tag: "Assign", tile: selected, game: game.id })}
      />
      <StageView stage={live.stage} slate={live.slate} selected={selected} onSelect={setSelected} />
    </div>
  )
}
```

Create `apps/web/src/main.tsx`:

```tsx
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import "./theme/theme.css"

const root = document.getElementById("root")
if (root === null) throw new Error("index.html has no #root element")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

- [ ] **Step 7: Verify in a browser**

Run: `pnpm format && pnpm check`
Expected: all green.

Run the Hub (`pnpm --filter @sportal/hub dev`) and the web UI (`pnpm --filter @sportal/web dev`), then open http://127.0.0.1:4401 and confirm each of these by eye:

1. The slate lists NFL and FBS games, live games first, and the header says `live`.
2. A live game's score changes without a reload within about 10 seconds of changing on ESPN.
3. Clicking a game puts it in tile 1; its score strip shows the teams and score. With the empty channel map it reads "No stream for this game on your sources".
4. Clicking a tile's strip selects it (blue border); the next picked game goes there.
5. Picking a game already on the Stage moves it rather than duplicating it.
6. `audio` moves the green `audio on` marker; `clear` empties a tile.
7. A second browser tab shows the same Stage and follows changes made in the first.
8. Stopping the Hub turns the header to `reconnecting…`; restarting it restores `live`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): live slate and 2x2 stage driven by the hub"
```

---

### Task 8: Spike — shell playback, stream budget, channel mapping

**Needs Chazzy at the keyboard** with a YouTube TV sign-in, during live games. This is throwaway code in `spikes/`, which is gitignored. Only the findings are kept.

**Files:**
- Create (throwaway, uncommitted): `spikes/shell-playback/package.json`, `spikes/shell-playback/pnpm-workspace.yaml`, `spikes/shell-playback/main.cjs`
- Create: `docs/adr/0002-desktop-shell-playback.md`
- Modify: `apps/hub/src/source/youtube-tv-channels.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a go/no-go decision for Task 9; the channel map `YouTubeTv.layer` reads, keyed by the network names ESPN reports.

- [ ] **Step 1: Create the spike**

Create `spikes/shell-playback/package.json`:

```json
{
  "name": "shell-playback-spike",
  "private": true,
  "main": "main.cjs",
  "scripts": { "start": "electron ." },
  "devDependencies": { "electron": "github:castlabs/electron-releases#v44.1.0+wvcus" }
}
```

Create `spikes/shell-playback/main.cjs`:

```js
// Throwaway. Three YouTube TV views side by side in one window, sharing one persistent session.
const { app, BrowserWindow, Menu, WebContentsView, components, session } = require("electron")

app.whenReady().then(async () => {
  await components.whenReady()
  console.log("widevine components:", JSON.stringify(components.status()))

  const window = new BrowserWindow({ width: 1920, height: 720 })
  const providers = session.fromPartition("persist:spike")
  // Optional addresses on the command line open views directly on a channel.
  const startAddresses = process.argv.slice(2).filter((argument) => argument.startsWith("https://"))
  const views = [0, 1, 2].map((index) => {
    const view = new WebContentsView({ webPreferences: { session: providers } })
    window.contentView.addChildView(view)
    view.webContents.setAudioMuted(index !== 0)
    view.webContents.on("did-navigate-in-page", (_event, url) => console.log(`view ${index + 1}: ${url}`))
    view.webContents.on("did-navigate", (_event, url) => console.log(`view ${index + 1}: ${url}`))
    view.webContents.loadURL(startAddresses[index] ?? "https://tv.youtube.com/")
    return view
  })

  const layout = () => {
    const { width, height } = window.getContentBounds()
    const each = Math.floor(width / views.length)
    views.forEach((view, index) => view.setBounds({ x: index * each, y: 0, width: each, height }))
  }
  window.on("resize", layout)
  layout()

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Audio",
        submenu: views.map((_view, index) => ({
          label: `Audio on view ${index + 1}`,
          accelerator: `CommandOrControl+${index + 1}`,
          click: () => views.forEach((view, other) => view.webContents.setAudioMuted(other !== index))
        }))
      }
    ])
  )
})

app.on("window-all-closed", () => app.quit())
```

Create `spikes/shell-playback/pnpm-workspace.yaml`, which makes the spike its own root, outside the Sportal workspace, and allows Electron's install script:

```yaml
allowBuilds:
  electron: true
```

Run: `cd spikes/shell-playback && pnpm install && pnpm start`
Expected: one window with three YouTube TV panes, and a `widevine components:` line in the terminal.

- [ ] **Step 2: Shell playback — sign in and play three channels**

In the window: sign in to Google in view 1. Tune each view to a different live channel. Watch for 30 minutes. Use Ctrl+1/2/3 to move audio. Quit and start again.

Record for each: did it work, and exactly what happened if not.

| Check | Pass condition |
| --- | --- |
| Sign-in | Google sign-in completes inside the shell with no "browser or app may not be secure" refusal |
| Shared session | Views 2 and 3 are signed in without signing in again |
| Playback | Three live channels play at once, with picture and no DRM error |
| Stability | All three still playing after 30 minutes |
| Audio | Ctrl+1/2/3 leaves exactly one view audible |
| Persistence | After quit and restart, still signed in |

**If Google refuses the sign-in:** stop and report to Chazzy. The usual workaround is presenting a stock Chrome user agent to Google. That is a decision about how the shell identifies itself, so it is Chazzy's to make, not something to slip in.

- [ ] **Step 3: Stream budget — find the limit**

With three channels playing, open YouTube TV on another device (phone or a normal browser) and start a fourth stream. Record exactly what happens: which stream stops, what message appears, and whether the three views inside one shell session counted as three streams or one.

- [ ] **Step 4: Channel mapping — collect the addresses**

For each network below, tune a view to that channel live and copy the address the terminal prints for it. These are the network names exactly as ESPN reports them in `broadcasts`:

`ABC`, `CBS`, `FOX`, `NBC`, `ESPN`, `ESPN2`, `ESPNU`, `FS1`, `CBSSN`, `BTN`, `SEC Network`, `ACC Network`, `NFL Net`, `TNT`, `USA Net`, `CW`

Write them into `apps/hub/src/source/youtube-tv-channels.json` as a flat object from network name to address, leaving out any channel your membership does not carry. (`ESPN+`, `Disney+`, `Prime Video`, and `MW+` are not YouTube TV channels and stay unmapped.)

Then check stability, because this decides whether a static map is viable. Quit, then start the spike with two of the recorded addresses as arguments:

```bash
pnpm start -- '<recorded address for one channel>' '<recorded address for another>'
```

Views 1 and 2 should open straight onto those two channels. Repeat the next day. If an address stops leading to its channel, record that: the map would then need refreshing and the Source design needs a different way to tune.

- [ ] **Step 5: Record the findings**

Create `docs/adr/0002-desktop-shell-playback.md` with this structure, filling every line from what was observed:

```markdown
# 2. Desktop shell plays YouTube TV in unmodified web views

Date: <date of the spike>
Status: <Accepted | Rejected>

## Question

Can an Electron shell with Widevine sign in to Google and play several YouTube TV channels in
separate web views at once?

## What was observed

- Electron build:
- Sign-in:
- Shared session across views:
- Simultaneous playback of three channels:
- After 30 minutes:
- Audio focus by muting views:
- Sign-in after restart:
- At the stream limit:
- Do views in one shell count separately toward the limit:
- Are channel addresses stable across restarts and days:

## Decision

<Build the shell as specified | Fall back to deep links only | Fall back to a browser extension>

## Consequences

<What this means for stream budget, the channel map, and anything that had to be worked around.>
```

- [ ] **Step 6: Decide, and commit the findings**

If every check in Step 2 passed: continue to Task 9.
If playback failed in a way that cannot be fixed without modifying the provider's page or its DRM: **stop**. Skip Task 9, record the fallback in the decision record, and report to Chazzy. The web UI already offers "Open in YouTube TV" for stream tiles, so the slice still works as a tracker with deep links.

```bash
git add docs/adr/0002-desktop-shell-playback.md apps/hub/src/source/youtube-tv-channels.json
git commit -m "docs: record shell playback spike findings and channel map"
```

---

### Task 9: Desktop shell

Only if Task 8 said go.

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/src/main/main.ts`, `apps/desktop/src/main/TileViews.ts`, `apps/desktop/src/main/ProviderSession.ts`
- Create: `apps/desktop/src/preload/ShellBridge.ts`

**Interfaces:**
- Consumes: `ShellBridge`, `TilePlacement` from Task 7; a running Hub serving the web UI.
- Produces: `window.sportalShell.syncTiles(placements)` in the web UI when it runs inside the shell; one provider web view per stream tile, positioned over that tile's video area, with exactly the audio-focus tile unmuted. Configured by `SPORTAL_HUB_URL` (default `http://127.0.0.1:4400`).

- [ ] **Step 1: Create the app**

Create `apps/desktop/package.json`:

```json
{
  "name": "@sportal/desktop",
  "private": true,
  "type": "module",
  "main": "out/main/main.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview"
  },
  "dependencies": {
    "@sportal/api": "workspace:*",
    "effect": "4.0.0"
  },
  "devDependencies": {
    "electron": "github:castlabs/electron-releases#v44.1.0+wvcus",
    "electron-vite": "^5.0.0",
    "vite": "^8.3.2"
  }
}
```

Create `apps/desktop/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "DOM"] },
  "include": ["src", "electron.vite.config.ts"]
}
```

Create `apps/desktop/electron.vite.config.ts`:

```ts
import { defineConfig } from "electron-vite"

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ["@sportal/api", "effect"] },
      rollupOptions: { input: "src/main/main.ts" }
    }
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ["@sportal/api"] },
      rollupOptions: {
        input: "src/preload/ShellBridge.ts",
        output: { format: "cjs", entryFileNames: "[name].cjs" }
      }
    }
  }
})
```

The preload is built as CommonJS because sandboxed preload scripts cannot be ES modules. Workspace packages and Effect are bundled in rather than left external, since the built shell does not resolve the workspace at run time.

Run: `pnpm install`
Expected: Electron's install script runs (it is allowed in `pnpm-workspace.yaml`).

- [ ] **Step 2: Implement the provider session**

Create `apps/desktop/src/main/ProviderSession.ts`:

```ts
import { session, WebContentsView } from "electron"

/** A view on the shared, persistent provider session, so one sign-in covers every tile and survives restarts. */
export function createView(): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      session: providerSession(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  view.webContents.on("will-navigate", (event, url) => {
    if (!allows(url)) event.preventDefault()
  })
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  return view
}

/** Provider views may only visit the provider and its sign-in pages. */
export function allows(url: string): boolean {
  if (!URL.canParse(url)) return false
  const { protocol, hostname } = new URL(url)
  return (
    protocol === "https:" && allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
  )
}

const allowedHosts = ["youtube.com", "google.com"]

function providerSession() {
  const providers = session.fromPartition("persist:providers")
  providers.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "fullscreen")
  })
  return providers
}
```

If the spike found that playback needs a permission other than `fullscreen`, or a sign-in host other than `youtube.com` and `google.com`, add exactly what the decision record lists and nothing more.

- [ ] **Step 3: Implement the tile views**

Create `apps/desktop/src/main/TileViews.ts`:

```ts
import type { TilePlacement } from "@sportal/api/ShellBridge"
import type { BrowserWindow, WebContentsView } from "electron"
import * as ProviderSession from "./ProviderSession.ts"

/**
 * Keeps one provider web view per stream tile, laid over the web UI at the rectangle the UI reports.
 * The shell only ever sets a view's address, bounds, and mute flag; the provider's page is never modified.
 */
export function attach(window: BrowserWindow) {
  const views = new Map<number, { view: WebContentsView; url: string }>()

  return {
    sync(placements: ReadonlyArray<TilePlacement>) {
      for (const [tile, entry] of views) {
        if (placements.some((placement) => placement.tile === tile)) continue
        window.contentView.removeChildView(entry.view)
        entry.view.webContents.close()
        views.delete(tile)
      }

      for (const placement of placements) {
        if (!ProviderSession.allows(placement.url)) continue
        let entry = views.get(placement.tile)
        if (entry === undefined) {
          entry = { view: ProviderSession.createView(), url: "" }
          window.contentView.addChildView(entry.view)
          views.set(placement.tile, entry)
        }
        if (entry.url !== placement.url) {
          entry.url = placement.url
          void entry.view.webContents.loadURL(placement.url)
        }
        entry.view.setBounds(placement.bounds)
        entry.view.webContents.setAudioMuted(placement.muted)
      }
    }
  }
}
```

- [ ] **Step 4: Implement the bridge and the main process**

Create `apps/desktop/src/preload/ShellBridge.ts`:

```ts
import type { ShellBridge } from "@sportal/api/ShellBridge"
import { contextBridge, ipcRenderer } from "electron"

const bridge: ShellBridge = {
  syncTiles: (placements) => ipcRenderer.send("sportal:sync-tiles", placements)
}

contextBridge.exposeInMainWorld("sportalShell", bridge)
```

Create `apps/desktop/src/main/main.ts`:

```ts
import { join } from "node:path"
import { TilePlacement } from "@sportal/api/ShellBridge"
import { Schema } from "effect"
import { app, BrowserWindow, components, ipcMain } from "electron"
import * as TileViews from "./TileViews.ts"

const hubUrl = process.env.SPORTAL_HUB_URL ?? "http://127.0.0.1:4400"

app.whenReady().then(async () => {
  // Widevine is delivered as a component of the castlabs Electron build; wait for it before any playback.
  await components.whenReady()

  const window = new BrowserWindow({
    width: 1920,
    height: 1080,
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/ShellBridge.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const tiles = TileViews.attach(window)
  ipcMain.on("sportal:sync-tiles", (event, placements: unknown) => {
    if (event.sender !== window.webContents) return
    const decoded = decodePlacements(placements)
    if (decoded._tag === "Some") tiles.sync(decoded.value)
  })

  await window.loadURL(hubUrl)
})

app.on("window-all-closed", () => app.quit())

const decodePlacements = Schema.decodeUnknownOption(Schema.Array(TilePlacement))
```

Placements arrive from the renderer, so the main process decodes them with the shared schema and `TileViews` refuses any address outside the provider allowlist. The web UI cannot make the shell load an arbitrary page.

- [ ] **Step 5: Build and check**

Run: `pnpm format && pnpm check`
Expected: all green.

Run: `pnpm --filter @sportal/desktop build && ls apps/desktop/out/main apps/desktop/out/preload`
Expected: `main.js` and `ShellBridge.cjs`.

- [ ] **Step 6: Run the whole slice**

The shell loads the UI from the Hub, so build the UI and have the Hub serve it:

```bash
pnpm --filter @sportal/web build
SPORTAL_WEB_ROOT="$PWD/apps/web/dist" pnpm --filter @sportal/hub start
```

In another terminal: `pnpm --filter @sportal/desktop start`

Confirm by eye, during a live game on a mapped channel:

1. The shell window shows the slate and the 2×2 Stage.
2. Clicking a live game on a mapped network plays it in the selected tile, inside the tile's video area, with the score strip visible beneath it.
3. A second game in a second tile plays at the same time.
4. Exactly one tile is audible; the `audio` button moves the sound.
5. `clear` removes the video from that tile.
6. Resizing the window keeps each video inside its tile.
7. A game on an unmapped network shows the data-tile message and no video.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(desktop): electron shell that mirrors stream tiles into provider views"
```

---

### Task 10: Decision records and the game-day checklist

**Files:**
- Create: `docs/adr/0001-effect-typescript-end-to-end.md`, `docs/adr/0003-hub-owns-stage-state.md`, `docs/adr/0004-snapshots-are-truth.md`, `docs/adr/0005-source-only-workspace-packages.md`
- Create: `docs/game-day-checklist.md`

**Interfaces:**
- Consumes: the finished slice.
- Produces: the written record of the decisions this slice locked in, and the manual checklist the spec requires for behaviour that cannot be automated.

- [ ] **Step 1: Write the decision records**

Create `docs/adr/0001-effect-typescript-end-to-end.md`:

```markdown
# 1. Effect TypeScript end to end

Date: 2026-10-03
Status: Accepted

## Context

The Hub, the web UI, and the desktop shell all handle the same domain concepts. Rust and gpui were
considered. The shell must be Chromium to play Widevine video, the UI must run on a phone and a TV
browser, and a Rust Hub would put every concept in two languages.

## Decision

One language. Each domain concept is declared once as an Effect Schema in `packages/domain` and used
unchanged as the in-memory type, the decoder, and the wire format by every process.

## Consequences

No generated types and no mirror types. The Hub is not as fast as a Rust one would be; its workload
(a few polls, a handful of clients) does not need it. Revisit only on a measured problem.
```

Create `docs/adr/0003-hub-owns-stage-state.md`:

```markdown
# 3. The Hub owns Stage state

Date: 2026-10-03
Status: Accepted

## Context

A phone must be able to change what a TV shows, and automation must be able to change the Stage
while no client is focused.

## Decision

The Stage lives in the Hub. Clients send `StageCommand`s; the Hub applies them with the pure
`Stage.apply`, then broadcasts the new Stage on the live stream. Clients render what they receive and
keep no copy of their own.

## Consequences

Every client, including a second tab, sees the same Stage. A command costs a round trip, a few
milliseconds on a local network. If a remote Hub ever makes that visible, a client can apply the same
pure function optimistically.
```

Create `docs/adr/0004-snapshots-are-truth.md`:

```markdown
# 4. Snapshots are the truth

Date: 2026-10-03
Status: Accepted

## Context

The data feed is polled, unofficial, and can miss or repeat updates.

## Decision

The Hub's state is the latest `GameSnapshot` per game. Anything event-like is derived by comparing
snapshots and is never stored as the source of truth. On a provider failure the last good slate for
that league is kept.

## Consequences

A restart or a missed poll cannot corrupt state. Events can be lost across a restart, which is
acceptable because nothing depends on having seen every one.
```

Create `docs/adr/0005-source-only-workspace-packages.md`:

```markdown
# 5. Workspace packages are consumed as source

Date: 2026-10-03
Status: Accepted

## Context

`packages/domain` and `packages/api` are used by the Hub (Node), the web UI (Vite), and the shell
(electron-vite).

## Decision

Packages have no build step. Their `exports` map points at `src/*.ts`. Node 24 runs the Hub's
TypeScript directly; `erasableSyntaxOnly` in the shared compiler options guarantees that stays
possible. Vite and electron-vite compile the same source for the browser and the shell.

## Consequences

No build ordering, no stale output, one definition reachable by go-to-definition. TypeScript syntax
that needs code generation (enums, parameter properties, namespaces) is unavailable, which the coding
rules already forbid.
```

- [ ] **Step 2: Write the game-day checklist**

Create `docs/game-day-checklist.md`:

```markdown
# Game-day checklist

Provider playback cannot be tested automatically. Run this by hand during live games after any change
to `apps/desktop` or to how stream tiles are rendered.

Setup: Hub serving the built web UI, desktop shell running, signed in to YouTube TV.

| # | Do | Expect |
| --- | --- | --- |
| 1 | Open the shell | Slate lists today's NFL and FBS games, live first; header reads `live` |
| 2 | Watch a live game's row for a minute | Score and clock update without a reload |
| 3 | Click a live game on a mapped network | It plays in the selected tile within a few seconds, inside the tile |
| 4 | Fill all four tiles with mapped games | Tiles up to the stream limit play; note what the provider does past it |
| 5 | Press `audio` on each tile in turn | Exactly one tile is audible each time |
| 6 | Pick a game that is already on the Stage | It moves to the selected tile; it is never shown twice |
| 7 | Click a game on an unmapped network | Data-tile message, no video, nothing else disturbed |
| 8 | Press `clear` on a playing tile | Video and sound stop for that tile only |
| 9 | Resize and maximize the window | Every video stays inside its tile; score strips stay visible |
| 10 | Open the web UI in a normal browser on the same machine | Same slate and Stage; a change there changes the shell |
| 11 | Stop the Hub, wait, start it | Header shows `reconnecting…` then `live`; playing video is not interrupted |
| 12 | Quit and reopen the shell | Still signed in to the provider |

Record the date, the build, and any row that failed.
```

- [ ] **Step 3: Check and commit**

Run: `pnpm format && pnpm check`
Expected: all green.

```bash
git add -A
git commit -m "docs: decision records and game-day checklist"
```

---

## What this slice leaves for the next plans

In the order the product plan's phases call for them:

0. **Learned channels** (decided 2026-10-03, see `docs/adr/0002-desktop-shell-playback.md`) — an unknown network opens YouTube TV's live guide in the tile; the shell reports the address the view lands on; the Hub remembers it. Replaces the hand-filled channel map. First confirm whether an address identifies a channel or a programme.
0. **shadcn/ui** (decided 2026-10-03) — adopt it as the web UI's component base as the first UI task: design tokens in `theme.css`, components under `apps/web/src/ui/` with the class-merging helper as its own named file (shadcn's default `lib/utils.ts` and `components/ui/` paths break the layout rules).
1. **Tracker** — `Store` port with SQL, `GameEvent` and `diff`, game detail, standings, follows, watchability, availability, CollegeFootballData for FBS gaps, the access token and network binding so other devices can connect, couch mode.
2. **Stage** — layouts beyond 2×2, presets, hotkeys, stream budget enforcement, data tiles with real content, more than one Display.
3. **Director** — triggers, rules, alerts, auto-promote, auto-fill, tile delay and the spoiler shield.
4. **Reach** — phone remote, further sources, betting lens, Hub container image.

## Review findings deferred from this slice

Recorded by the final whole-branch review on 2026-10-03. Each belongs to the plan named.

**Tracker**
- Test `GET /api/live` end to end (framing, content type, current state first) — first task.
- Ingest: add a request timeout mapped to `ProviderError`, and catch and log a defect inside a poll so the loop cannot die silently.
- Ingest: publish only when the slate changed.
- Ingest: test the per-league fallback with two leagues.
- ESPN adapter: log a game dropped for a missing side or unparseable kickoff; log the schema reason on a decode failure and save the payload as a candidate fixture; treat an unparseable score as a decode failure, not 0; test a malformed event and a non-2xx response.
- dependency-cruiser: make `provider-payloads-are-private` per-provider with a backreference, when a second provider folder exists.
- `delayed` games: decide whether they count as live for ordering and cadence; pin the ordering of delayed, postponed, and canceled games with tests.
- Web: decode live messages with a non-throwing decoder and warn on failure; show `OT` instead of `Q5`.
- `HubServer.test.ts`: wait for the first non-empty slate instead of a single yield.

**Stage**
- Stage tests: assert the rejection reason; cover assign over an occupied tile, audio focus unchanged by assign and clear, and a move that becomes a data tile.
- Web: re-sync tile placements with a `ResizeObserver` on the video areas.
- Web: surface a rejected or failed stage command to the user.

**Reach**
- Hub: refuse non-loopback binds until the access token exists; check `Host` and `Origin`.
- Decode the channel map at boot.
- Web: name the source in a stream tile's link instead of hard-coding YouTube TV.
- Desktop: guard subframe navigations (`will-frame-navigate`).

**Desktop shell** (from the review of the Effect-native restructure; take with learned channels, which reworks these files)
- `main.ts`: the program is launched at module top level above a class and a const it uses; it works only because the first step is asynchronous. Move the launch last or into a function.
- `main.ts`: each sync message forks its own fiber over a shared map; serialise them or state the no-async-step assumption.
- A window closed while the Hub page is loading is logged as "the Hub could not be reached"; a view removed mid-load may log a load error.
- `WidevineUnavailable` drops the underlying error; carry its code.
- The two navigation guards (shell window, provider views) share a shape and could be one.
