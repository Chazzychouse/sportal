# Hub Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Hub reads every setting in one place, keeps its data where each OS expects it, runs its scripts on any OS's shell, answers a health check, stops within seconds with Displays connected, and keeps its live stream open through idle-timeout proxies.

**Architecture:** A new `HubConfig` service decodes every setting once, through Effect's `Config` and `Path`. `main.ts` becomes only the Hub's layer pipe. What it composed by hand moves to modules of its own, each a layer that yields `HubConfig` for the settings it needs: `HubMode` (the live day or a scenario), `Logging`, `HubServer.serve` (the routes and the web UI on the configured address), and `Database.inDataDir`. No service or setting is passed as an argument. `StageSessions` stops passing its services to a helper. `SportalApi`'s `host` group gains `GET /api/health`. `HubServer.liveRoute` merges a keep-alive comment into the stream. The HTTP server gets a 3-second graceful shutdown bound, proved by a test that runs the real Hub as a child process. Repository files make the toolchain behave the same on Linux, macOS, and Windows.

**Tech Stack:** Effect 4 (`Config`, `ConfigProvider`, `Path`, `FileSystem`, `Context.Service`, `Layer`, `Logger`, `References`, `Stream`, `effect/testing` `TestClock`, `effect/process` `ChildProcess`), `effect/http-api`, `@effect/platform-node` (`NodePath.layerPosix`, `NodePath.layerWin32`), `@effect/vitest`, pnpm 12.

**Spec:** `docs/specs/2026-10-04-hub-foundations-design.md`. Work only in the worktree `/home/chazzy/development/projects/sportal-hub-foundations` (branch `hub-foundations`), created with `git worktree add ../sportal-hub-foundations -b hub-foundations` and then `pnpm install --frozen-lockfile --prefer-offline` inside it. Never touch the main checkout, and stop any stray Hub on port 4400 before running one.

## Global Constraints

- Read `AGENTS.md` first. Effect 4 is newer than most training data: check `node_modules/effect/ai-docs/src/` and the `.d.ts` files under `node_modules/effect/dist/` before writing Effect code from memory.
- Every exported type name is a `CONTEXT.md` term; this plan adds **Hub config**.
- Main export first; private helpers below as hoisted `function` declarations; no options-bag type aliases; no `any`, casts outside decoding, non-null assertions, enums, default exports, or `index.ts` barrels.
- Comments: a doc comment on each major export; an inline comment only where the why or what is genuinely unclear from the code. Code moved or rewritten here drops comments that restate it.
- Prefer Effect's abstractions to Node's: `Config` for the environment, `Path` for joining paths, `FileSystem` for files.
- A service is yielded where it is used, never passed as an argument. A layer that needs a setting yields `HubConfig`; a choice between layers at startup is a `Layer.unwrap` that yields `HubConfig`. Layer constructors may take plain values (`Ingest.layer(leagues)`, `ScenarioProvider.layer(name)`).
- In the Hub, only `HubMode.ts` and tests name concrete providers and sources (Task 3 moves this from `main.ts`, and the dependency-cruiser rule with it). After Task 2, no Hub file but `HubConfig.ts` reads `Config`, `process.env`, or `process.platform` (the `scenario:cut` dev tool keeps its `INIT_CWD`; tests may read `process.platform` and `process.execPath`).
- Setting names and defaults: `SPORTAL_PORT` (4400), `SPORTAL_HOST` (`0.0.0.0`), `SPORTAL_WEB_ROOT` (none), `SPORTAL_DATA_DIR` (the OS default), `SPORTAL_SCENARIO` (none), `SPORTAL_SCENARIO_SPEED` (1, finite and above 0), `SPORTAL_LOG_LEVEL` (`Info`), `SPORTAL_LOG_FORMAT` (`pretty` or `json`, default `pretty`), `SPORTAL_VERSION` (`dev`).
- Default data directory: Linux `$XDG_DATA_HOME/sportal`, else `$HOME/.local/share/sportal`; macOS `$HOME/Library/Application Support/Sportal`; Windows `%LOCALAPPDATA%\Sportal`, else `%USERPROFILE%\AppData\Local\Sportal`. An empty `XDG_DATA_HOME` or `LOCALAPPDATA` counts as unset.
- Graceful shutdown bound: 3 seconds. Keep-alive interval: 20 seconds, line `: keep-alive`.
- Tests sit beside their file as `Name.test.ts`. Run one file with `pnpm vitest run <path>`. `pnpm check` must pass before every commit.
- Commit messages are conventional and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Files

| File | Responsibility |
| --- | --- |
| `pnpm-workspace.yaml` (modify) | `shellEmulator: true` |
| `.gitattributes` (create) | LF everywhere; recorded payloads not diffed |
| `package.json` (modify) | `packageManager`, `engines` |
| `mise.toml` (modify) | Exact pnpm pin |
| `apps/hub/src/HubConfig.ts` (create) | `HubConfig`: every Hub setting, and the OS default data directory |
| `apps/hub/src/HubConfig.test.ts` (create) | Defaults, reading, refusals, data directory per OS |
| `apps/hub/src/database/Database.ts` (modify) | `inDataDir`: the Hub's database file in the data directory `HubConfig` names |
| `apps/hub/src/database/Database.test.ts` (modify) | `inDataDir` creates the directory |
| `apps/hub/src/main.ts` (modify) | The Hub's layer pipe, and nothing else |
| `apps/hub/src/HubMode.ts` (create) | What the Hub plays: the live day (ESPN, YouTube TV) or a scenario |
| `apps/hub/src/Logging.ts` (create) | Log level and format from `HubConfig` |
| `.dependency-cruiser.cjs` (modify) | `HubMode.ts` may name adapters; `main.ts` keeps only the database |
| `apps/hub/src/stage/StageSessions.ts` (modify) | The slate's availability is built from the layer's services, not a helper that takes them |
| `apps/hub/src/main.test.ts` (create) | The real Hub stops cleanly on SIGTERM |
| `packages/api/src/SportalApi.ts` (modify) | `GET /api/health` in `host` |
| `apps/hub/src/http/HubServer.ts` (modify) | `serve`: routes and web UI on the configured address; health handler; keep-alive; shutdown bound |
| `apps/hub/src/http/HubServer.test.ts` (modify) | Health and keep-alive cases; test config |
| `CONTEXT.md`, `AGENTS.md`, `docs/technical-spec.md` (modify) | Glossary rows; commands, settings, where adapters are named |

`docs/technical-spec.md` changes only where it says `main.ts` names the adapters (Task 8); its §4.2 tree already lists `HubConfig.ts`.

---

### Task 1: The toolchain behaves the same on every OS

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `.gitattributes`
- Modify: `package.json`
- Modify: `mise.toml`

**Interfaces:**
- Consumes: nothing.
- Produces: pnpm runs every `package.json` script through its own shell on every OS; every checkout has LF line endings.

- [ ] **Step 1: Turn on pnpm's shell emulator**

`pnpm-workspace.yaml` becomes:

```yaml
packages:
  - packages/*
  - apps/*
allowBuilds:
  electron: true
  esbuild: true
  lefthook: true
# Scripts use `VAR=x cmd` and `${VAR:-default}`, which cmd and PowerShell cannot run.
shellEmulator: true
```

- [ ] **Step 2: Pin line endings**

Create `.gitattributes`:

```gitattributes
* text=auto eol=lf

fixtures/** -diff
apps/hub/src/**/fixtures/** -diff
```

- [ ] **Step 3: Check that no committed file changes under the new attributes**

Run: `git add --renormalize . && git status --short`
Expected: only `.gitattributes` and `pnpm-workspace.yaml` listed (every file is already LF). If any other file is listed, it had CRLF endings; keep the renormalized version and name it in the commit message.

- [ ] **Step 4: Pin the toolchain for people without mise**

In root `package.json`, after `"type": "module",` add:

```json
  "packageManager": "pnpm@12.8.1",
  "engines": { "node": ">=24" },
```

`mise.toml` becomes:

```toml
[tools]
node = "24"
pnpm = "12.8.1"
```

- [ ] **Step 5: Check that the scripts still work through the emulator**

Run: `pnpm install --frozen-lockfile --prefer-offline`
Expected: completes; `install-electron` reports the binary present.

Run: `pnpm --filter @sportal/hub dev` for about five seconds, then Ctrl-C.
Expected: the Hub starts and listens on 4400; `ls -la .sportal/` at the worktree's root shows `sportal.sqlite` with a fresh modification time, so `${SPORTAL_DATA_DIR:-../../.sportal}` was expanded.

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml .gitattributes package.json mise.toml
git commit -m "build: scripts run through pnpm's shell, and every checkout is LF, on any OS

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `HubConfig`

**Files:**
- Create: `apps/hub/src/HubConfig.ts`
- Test: `apps/hub/src/HubConfig.test.ts`
- Modify: `apps/hub/src/main.ts` (read settings from `HubConfig`; Task 3 restructures the file)
- Modify: `CONTEXT.md` (Devices table, after the **Hub** row)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class HubConfig extends Context.Service` with value `{ port: number; host: string; webRoot: Option<string>; dataDir: string; scenario: Option<string>; scenarioSpeed: number; logLevel: LogLevel.LogLevel; logFormat: "pretty" | "json"; version: string }`, key `"sportal/hub/HubConfig"`.
  - `HubConfig.layer: Layer<HubConfig, Config.ConfigError, Path.Path>`.
  - `HubConfig.defaultDataDir(platform: NodeJS.Platform): Effect<string, Config.ConfigError, Path.Path>`.

- [ ] **Step 1: Write the failing test**

`apps/hub/src/HubConfig.test.ts`:

```ts
import { NodePath } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import { HubConfig } from "./HubConfig.ts"

describe("HubConfig", () => {
  const home = { HOME: "/home/fan", USERPROFILE: "C:\\Users\\fan" }

  it.effect("has a default for every setting", () =>
    Effect.gen(function* () {
      const config = yield* HubConfig
      assert.strictEqual(config.port, 4400)
      assert.strictEqual(config.host, "0.0.0.0")
      assert.isTrue(Option.isNone(config.webRoot))
      assert.strictEqual(config.dataDir, yield* HubConfig.defaultDataDir(process.platform))
      assert.isTrue(Option.isNone(config.scenario))
      assert.strictEqual(config.scenarioSpeed, 1)
      assert.strictEqual(config.logLevel, "Info")
      assert.strictEqual(config.logFormat, "pretty")
      assert.strictEqual(config.version, "dev")
    }).pipe(Effect.provide(withEnv(home)))
  )

  it.effect("reads each setting", () =>
    Effect.gen(function* () {
      const config = yield* HubConfig
      assert.strictEqual(config.port, 5000)
      assert.strictEqual(config.host, "127.0.0.1")
      assert.deepStrictEqual(config.webRoot, Option.some("/srv/web"))
      assert.strictEqual(config.dataDir, "/data")
      assert.deepStrictEqual(config.scenario, Option.some("two-minute-drill-tie"))
      assert.strictEqual(config.scenarioSpeed, 10)
      assert.strictEqual(config.logLevel, "Debug")
      assert.strictEqual(config.logFormat, "json")
      assert.strictEqual(config.version, "1.2.3")
    }).pipe(
      Effect.provide(
        withEnv({
          SPORTAL_PORT: "5000",
          SPORTAL_HOST: "127.0.0.1",
          SPORTAL_WEB_ROOT: "/srv/web",
          SPORTAL_DATA_DIR: "/data",
          SPORTAL_SCENARIO: "two-minute-drill-tie",
          SPORTAL_SCENARIO_SPEED: "10",
          SPORTAL_LOG_LEVEL: "Debug",
          SPORTAL_LOG_FORMAT: "json",
          SPORTAL_VERSION: "1.2.3"
        })
      )
    )
  )

  for (const [name, value] of [
    ["SPORTAL_PORT", "eighty"],
    ["SPORTAL_SCENARIO_SPEED", "0"],
    ["SPORTAL_SCENARIO_SPEED", "NaN"],
    ["SPORTAL_LOG_LEVEL", "Loud"],
    ["SPORTAL_LOG_FORMAT", "xml"]
  ] as const) {
    it.effect(`refuses ${name}=${value}, naming the setting`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.gen(function* () {
          return yield* HubConfig
        }).pipe(Effect.provide(withEnv({ ...home, [name]: value })), Effect.flip)
        assert.include(error.message, name)
      })
    )
  }
})

describe("HubConfig.defaultDataDir", () => {
  it.effect("is under XDG_DATA_HOME on Linux, when it is set and not empty", () =>
    Effect.gen(function* () {
      const dir = (env: Record<string, string>) =>
        HubConfig.defaultDataDir("linux").pipe(Effect.provide(inEnv(env, NodePath.layerPosix)))
      assert.strictEqual(yield* dir({ HOME: "/home/fan", XDG_DATA_HOME: "/data/xdg" }), "/data/xdg/sportal")
      assert.strictEqual(yield* dir({ HOME: "/home/fan" }), "/home/fan/.local/share/sportal")
      assert.strictEqual(yield* dir({ HOME: "/home/fan", XDG_DATA_HOME: "" }), "/home/fan/.local/share/sportal")
    })
  )

  it.effect("is in Application Support on macOS", () =>
    Effect.gen(function* () {
      const dir = yield* HubConfig.defaultDataDir("darwin").pipe(
        Effect.provide(inEnv({ HOME: "/Users/fan" }, NodePath.layerPosix))
      )
      assert.strictEqual(dir, "/Users/fan/Library/Application Support/Sportal")
    })
  )

  it.effect("is under LOCALAPPDATA on Windows, never the roaming folder", () =>
    Effect.gen(function* () {
      const dir = (env: Record<string, string>) =>
        HubConfig.defaultDataDir("win32").pipe(Effect.provide(inEnv(env, NodePath.layerWin32)))
      assert.strictEqual(
        yield* dir({ USERPROFILE: "C:\\Users\\fan", LOCALAPPDATA: "D:\\Local" }),
        "D:\\Local\\Sportal"
      )
      assert.strictEqual(yield* dir({ USERPROFILE: "C:\\Users\\fan" }), "C:\\Users\\fan\\AppData\\Local\\Sportal")
    })
  )

  it.effect("names HOME when it is needed and missing", () =>
    Effect.gen(function* () {
      const error = yield* HubConfig.defaultDataDir("linux").pipe(
        Effect.provide(inEnv({}, NodePath.layerPosix)),
        Effect.flip
      )
      assert.include(error.message, "HOME")
    })
  )
})

/** HubConfig read from exactly these variables, and nothing from the machine running the test. */
function withEnv(env: Record<string, string>) {
  return HubConfig.layer.pipe(Layer.provide(inEnv(env, NodePath.layer)))
}

function inEnv(env: Record<string, string>, path: typeof NodePath.layer) {
  return Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), path)
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/hub/src/HubConfig.test.ts`
Expected: FAIL — cannot resolve `./HubConfig.ts`.

- [ ] **Step 3: Write `HubConfig`**

`apps/hub/src/HubConfig.ts`:

```ts
import { Config, Context, Effect, Layer, type LogLevel, Option, Path, Schema } from "effect"

/** Every setting the Hub reads from its environment, decoded once at startup. */
export class HubConfig extends Context.Service<
  HubConfig,
  {
    readonly port: number
    readonly host: string
    readonly webRoot: Option.Option<string>
    readonly dataDir: string
    readonly scenario: Option.Option<string>
    readonly scenarioSpeed: number
    readonly logLevel: LogLevel.LogLevel
    readonly logFormat: "pretty" | "json"
    readonly version: string
  }
>()("sportal/hub/HubConfig") {
  static readonly layer = Layer.effect(
    HubConfig,
    Effect.gen(function* () {
      const dataDir = yield* Config.String("SPORTAL_DATA_DIR").pipe(Config.option)
      return HubConfig.of({
        port: yield* Config.Port("SPORTAL_PORT").pipe(Config.withDefault(4400)),
        host: yield* Config.String("SPORTAL_HOST").pipe(Config.withDefault("0.0.0.0")),
        webRoot: yield* Config.String("SPORTAL_WEB_ROOT").pipe(Config.option),
        dataDir: Option.isSome(dataDir) ? dataDir.value : yield* HubConfig.defaultDataDir(process.platform),
        scenario: yield* Config.String("SPORTAL_SCENARIO").pipe(Config.option),
        // Zero, a negative speed, or NaN would stall or break the scenario clock.
        scenarioSpeed: yield* Config.schema(
          Schema.Finite.check(Schema.isGreaterThan(0)),
          "SPORTAL_SCENARIO_SPEED"
        ).pipe(Config.withDefault(1)),
        logLevel: yield* Config.LogLevel("SPORTAL_LOG_LEVEL").pipe(Config.withDefault("Info")),
        logFormat: yield* Config.Literals(["pretty", "json"], "SPORTAL_LOG_FORMAT").pipe(
          Config.withDefault("pretty")
        ),
        version: yield* Config.String("SPORTAL_VERSION").pipe(Config.withDefault("dev"))
      })
    })
  )

  /** Where the OS keeps an application's own data. On Windows it is the local folder, so the database never roams. */
  static defaultDataDir(platform: NodeJS.Platform) {
    return Effect.gen(function* () {
      const path = yield* Path.Path
      switch (platform) {
        case "win32": {
          const local = yield* nonEmpty("LOCALAPPDATA")
          const base = Option.isSome(local)
            ? local.value
            : path.join(yield* Config.String("USERPROFILE"), "AppData", "Local")
          return path.join(base, "Sportal")
        }
        case "darwin":
          return path.join(yield* Config.String("HOME"), "Library", "Application Support", "Sportal")
        default: {
          const xdg = yield* nonEmpty("XDG_DATA_HOME")
          const base = Option.isSome(xdg) ? xdg.value : path.join(yield* Config.String("HOME"), ".local", "share")
          return path.join(base, "sportal")
        }
      }
    })
  }
}

function nonEmpty(name: string) {
  return Config.String(name).pipe(
    Config.option,
    Config.map(Option.filter((value) => value !== ""))
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/hub/src/HubConfig.test.ts`
Expected: PASS, all 11 tests. If a refusal test fails only because `error.message` does not contain the variable name, print the message, find where Effect's `ConfigError` keeps the key (`error.cause`), and assert on that instead; the requirement is that the error names the variable.

- [ ] **Step 5: Read the settings from `HubConfig` in `main.ts`**

This step only swaps the source of each value; Task 3 restructures the file. In `apps/hub/src/main.ts`:

Replace the `effect` import with:

```ts
import { Effect, FileSystem, Layer, Option } from "effect"
```

and add:

```ts
import { HubConfig } from "./HubConfig.ts"
```

Replace the first lines of the generator, from `const port = …` through `yield* (yield* FileSystem.FileSystem).makeDirectory(dataDir, { recursive: true })`, with:

```ts
    const config = yield* HubConfig
    yield* (yield* FileSystem.FileSystem).makeDirectory(config.dataDir, { recursive: true })
```

Replace `Option.match(webRoot, {` with `Option.match(config.webRoot, {`. Delete the `const scenario = …` and `const speed = …` declarations (and the comment above `speed`), replace `ScenarioClock.layer(speed)` with `ScenarioClock.layer(config.scenarioSpeed)`, `Option.match(scenario, {` with `Option.match(config.scenario, {`, `join(dataDir, "sportal.sqlite")` with `join(config.dataDir, "sportal.sqlite")`, and `{ port, host }` with `{ port: config.port, host: config.host }`.

Close the `Layer.unwrap(…)` with `.pipe(Layer.provide(HubConfig.layer))`:

```ts
const Hub = Layer.unwrap(
  Effect.gen(function* () {
    …
  })
).pipe(Layer.provide(HubConfig.layer))
```

- [ ] **Step 6: Check the Hub still starts, and refuses a bad setting**

Run: `SPORTAL_SCENARIO=two-minute-drill-tie pnpm --filter @sportal/hub dev` for about five seconds, then Ctrl-C.
Expected: the Hub starts and listens on 4400.

Run: `SPORTAL_SCENARIO_SPEED=0 pnpm --filter @sportal/hub dev`
Expected: the Hub exits at once with an error naming `SPORTAL_SCENARIO_SPEED`, before it listens.

Run: `grep -rn "Config\.\|process\.env\|process\.platform" apps/hub/src --include=*.ts | grep -v "\.test\.ts" | grep -v HubConfig.ts`
Expected: only `apps/hub/src/provider/espn/CutScenario.ts` (its `INIT_CWD`).

- [ ] **Step 7: Add the glossary row**

In `CONTEXT.md`, directly after the `| **Hub** | The server process that owns all shared state. | backend, server |` row:

```markdown
| **Hub config** | Every setting a Hub reads from its environment, decoded once at startup; `HubConfig` in code. | settings, env |
```

- [ ] **Step 8: Run all checks and commit**

Run: `pnpm check`
Expected: PASS.

```bash
git add apps/hub/src/HubConfig.ts apps/hub/src/HubConfig.test.ts apps/hub/src/main.ts CONTEXT.md
git commit -m "feat(hub): HubConfig reads every setting once, with an OS default data directory

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The composition root is the layer pipe and nothing else

**Files:**
- Modify: `apps/hub/src/database/Database.ts`
- Test: `apps/hub/src/database/Database.test.ts`
- Create: `apps/hub/src/HubMode.ts`
- Create: `apps/hub/src/Logging.ts`
- Modify: `apps/hub/src/http/HubServer.ts` (add `serve`)
- Modify: `apps/hub/src/main.ts`
- Modify: `.dependency-cruiser.cjs` (`only-main-names-adapters`)
- Modify: `CONTEXT.md` (Devices table, after **Hub config**)

**Interfaces:**
- Consumes: `HubConfig` (Task 2): `dataDir`, `webRoot`, `scenario`, `scenarioSpeed`, `port`, `host`, `logLevel`, `logFormat`.
- Produces (every one a layer value that yields `HubConfig`; none takes arguments):
  - `Database.inDataDir: Layer<SqlClient, …, HubConfig | FileSystem | Path>` — `sportal.sqlite` in `HubConfig.dataDir`, creating the directory. `Database.layer(filename)` stays, for tests.
  - `HubMode.layer: Layer<Ingest | Watch | Source, …, HubConfig | SqlClient | HttpClient | FileSystem | Path>` — the live day, or `HubConfig.scenario` on scenario time.
  - `Logging.layer: Layer<never, never, HubConfig>` — the minimum log level and the log format.
  - `HubServer.serve: Layer<…, …, HubConfig | Ingest | Watch | Source | StageSessions>` — every route, the built web UI when `webRoot` is set, served on `host:port`. Task 7 bounds its shutdown.

- [ ] **Step 1: Write the failing test**

In `apps/hub/src/database/Database.test.ts`, replace the imports with:

```ts
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect"
import { SqlClient } from "effect/sql"
import { HubConfig } from "../HubConfig.ts"
import * as Database from "./Database.ts"
```

and add after the `describe("Database.migrate", …)` block:

```ts
describe("Database.inDataDir", () => {
  it.effect("keeps the database in the Hub's data directory, creating the directory if it is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dataDir = path.join(yield* fs.makeTempDirectoryScoped(), "nested", "sportal")
      const config = HubConfig.layer.pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { SPORTAL_DATA_DIR: dataDir } })))
      )

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`SELECT 1`
      }).pipe(Effect.provide(Database.inDataDir.pipe(Layer.provide(config))))

      assert.isTrue(yield* fs.exists(path.join(dataDir, "sportal.sqlite")))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/hub/src/database/Database.test.ts`
Expected: FAIL — `Database.inDataDir` is undefined.

- [ ] **Step 3: Implement `inDataDir`**

`apps/hub/src/database/Database.ts` becomes:

```ts
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, FileSystem, Layer, Path } from "effect"
import { Migrator, type SqlClient } from "effect/sql"
import { HubConfig } from "../HubConfig.ts"

/** The Hub's SQLite database, in `filename` (or `":memory:"`). Each store migrates its own tables. */
export const layer = (filename: string) => SqliteClient.layer({ filename })

/** The Hub's database as `sportal.sqlite` in its data directory, which is created if it is missing. */
export const inDataDir = Layer.unwrap(
  Effect.gen(function* () {
    const { dataDir } = yield* HubConfig
    yield* (yield* FileSystem.FileSystem).makeDirectory(dataDir, { recursive: true })
    return layer((yield* Path.Path).join(dataDir, "sportal.sqlite"))
  })
)

/**
 * Runs one store's pending migrations, keyed `<id>_<name>`, and records them in that store's own table,
 * `<store>_migrations`, so two stores never share a numbering. Returns the migrations it ran.
 */
export function migrate(
  store: string,
  migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>
) {
  return run({ loader: Migrator.fromRecord(migrations), table: `${store}_migrations` })
}

const run = Migrator.make({})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/hub/src/database/Database.test.ts`
Expected: PASS, all three tests.

- [ ] **Step 5: Create `HubMode`**

`apps/hub/src/HubMode.ts`:

```ts
import { Effect, Layer, Option } from "effect"
import { HubConfig } from "./HubConfig.ts"
import { Ingest } from "./ingest/Ingest.ts"
import * as EspnProvider from "./provider/espn/EspnProvider.ts"
import * as ScenarioClock from "./scenario/ScenarioClock.ts"
import * as ScenarioProvider from "./scenario/ScenarioProvider.ts"
import * as ScenarioSource from "./scenario/ScenarioSource.ts"
import * as SqlChannelStore from "./source/SqlChannelStore.ts"
import * as YouTubeTv from "./source/youtube-tv/YouTubeTv.ts"
import { Watch } from "./watch/Watch.ts"

/** What the Hub plays: the live day from ESPN and YouTube TV, or a scenario in their place, on scenario time. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { scenario, scenarioSpeed } = yield* HubConfig
    // Annotated so the compiler checks that a scenario provides everything the live day does.
    const chosen: Layer.Layer<
      Layer.Success<ReturnType<typeof live>>,
      Layer.Error<ReturnType<typeof live>> | Layer.Error<ReturnType<typeof scripted>>,
      Layer.Services<ReturnType<typeof live>> | Layer.Services<ReturnType<typeof scripted>>
    > = Option.match(scenario, { onNone: live, onSome: (name) => scripted(name, scenarioSpeed) })
    return chosen
  })
)

const leagues = ["nfl", "fbs"] as const

function live() {
  return Layer.mergeAll(
    Watch.layer.pipe(Layer.provideMerge(Ingest.layer(leagues).pipe(Layer.provide(EspnProvider.layer)))),
    YouTubeTv.layer.pipe(Layer.provide(SqlChannelStore.layer))
  )
}

// Ingest, the scenario, and Watch share one clock; the rest of the Hub keeps the real one.
function scripted(name: string, speed: number) {
  return Layer.mergeAll(
    Watch.layer.pipe(
      Layer.provideMerge(Ingest.layer(leagues).pipe(Layer.provide(ScenarioProvider.layer(name)))),
      Layer.provide(ScenarioClock.layer(speed))
    ),
    ScenarioSource.layer
  )
}
```

- [ ] **Step 6: Create `Logging`**

`apps/hub/src/Logging.ts`:

```ts
import { Effect, Layer, Logger, References } from "effect"
import { HubConfig } from "./HubConfig.ts"

/** The Hub's minimum log level, and its format: Effect's console logger, or one JSON object per line. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { logLevel, logFormat } = yield* HubConfig
    return Layer.mergeAll(
      Layer.succeed(References.MinimumLogLevel, logLevel),
      logFormat === "json" ? Logger.layer([Logger.consoleJson]) : Layer.empty
    )
  })
)
```

- [ ] **Step 7: Add `HubServer.serve`**

In `apps/hub/src/http/HubServer.ts`, add these imports:

```ts
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { HubConfig } from "../HubConfig.ts"
```

change the `effect` import to `import { Effect, Layer, Option, Schema, Stream } from "effect"` and the `effect/http` import to `import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http"`, and add after `export const layer = …`:

```ts
/** The Hub on its configured address: every route, and the built web UI when there is one. */
export const serve = Layer.unwrap(
  Effect.gen(function* () {
    const { webRoot, port, host } = yield* HubConfig
    const routes = Option.match(webRoot, {
      onNone: () => layer,
      onSome: (root) => Layer.mergeAll(layer, HttpStaticServer.layer({ root, spa: true }))
    })
    return HttpRouter.serve(routes).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port, host })))
  })
)
```

- [ ] **Step 8: Reduce `main.ts` to the pipe**

`apps/hub/src/main.ts` becomes:

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import * as Database from "./database/Database.ts"
import { HubConfig } from "./HubConfig.ts"
import * as HubMode from "./HubMode.ts"
import * as HubServer from "./http/HubServer.ts"
import * as Logging from "./Logging.ts"
import { StageSessions } from "./stage/StageSessions.ts"

const Hub = HubServer.serve.pipe(
  Layer.provide(StageSessions.layer),
  Layer.provide(HubMode.layer),
  Layer.provide([Database.inDataDir, FetchHttpClient.layer]),
  Layer.provide(Logging.layer),
  Layer.provide(HubConfig.layer),
  Layer.provide(NodeServices.layer)
)

Layer.launch(Hub).pipe(NodeRuntime.runMain)
```

`HubConfig.layer` comes after every layer that yields it, and `NodeServices` last, for `HubConfig`'s `Path` and every `FileSystem` and `Path` above. They are separate `Layer.provide` calls because layers in one array do not feed each other.

- [ ] **Step 9: Move the adapter rule to `HubMode.ts`**

In `.dependency-cruiser.cjs`, the `only-main-names-adapters` rule becomes:

```js
    {
      name: "only-hub-mode-names-adapters",
      comment:
        "Only HubMode and tests know which concrete providers and sources exist; main.ts names only the database.",
      severity: "error",
      from: {
        path: "^apps/hub/src/",
        pathNot:
          "(^apps/hub/src/HubMode\\.ts$|\\.test\\.ts$|^apps/hub/src/provider/[^/]+/|^apps/hub/src/source/youtube-tv/|^apps/hub/src/source/Sql[^/]+\\.ts$)"
      },
      to: {
        path: "^apps/hub/src/(provider/[^/]+/|source/youtube-tv/|source/Sql[^/]+\\.ts$)"
      }
    },
    {
      name: "only-main-opens-the-database",
      comment: "The composition root provides the database; stores reach it through SqlClient.",
      severity: "error",
      from: {
        path: "^apps/hub/src/",
        pathNot: "(^apps/hub/src/main\\.ts$|\\.test\\.ts$|^apps/hub/src/source/Sql[^/]+\\.ts$|^apps/hub/src/database/)"
      },
      to: { path: "^apps/hub/src/database/" }
    },
```

- [ ] **Step 10: Add the glossary row**

In `CONTEXT.md`, directly after the **Hub config** row:

```markdown
| **Hub mode** | What a Hub plays: the live day from its providers and sources, or a scenario in their place. | |
```

- [ ] **Step 11: Check the Hub still runs, in both modes and both log formats**

Run: `SPORTAL_SCENARIO=two-minute-drill-tie SPORTAL_LOG_FORMAT=json SPORTAL_LOG_LEVEL=Debug pnpm --filter @sportal/hub dev` for about five seconds, then Ctrl-C.
Expected: the Hub logs `Listening on http://0.0.0.0:4400` (as a JSON object) and its other lines are JSON too.

Run: `pnpm --filter @sportal/hub dev` for about ten seconds, then Ctrl-C.
Expected: the Hub starts on 4400, polls ESPN, and logs in the pretty format; `curl -s localhost:4400/api/slate | head -c 200` while it runs returns JSON.

Run: `pnpm --filter @sportal/web build && SPORTAL_WEB_ROOT="$PWD/apps/web/dist" SPORTAL_SCENARIO=two-minute-drill-tie pnpm --filter @sportal/hub start` for about five seconds; while it runs, `curl -s localhost:4400/ | head -c 100`.
Expected: the web UI's `index.html`.

Run: `rm -rf "$PWD/.sportal-check" && SPORTAL_DATA_DIR="$PWD/.sportal-check/nested" SPORTAL_SCENARIO=two-minute-drill-tie pnpm --filter @sportal/hub start` for about five seconds, then Ctrl-C, then `ls .sportal-check/nested && rm -rf .sportal-check`.
Expected: `sportal.sqlite` is listed.

- [ ] **Step 12: Run all checks and commit**

Run: `pnpm check`
Expected: PASS, including `depcruise` with the two new rules.

```bash
git add apps/hub/src/database/Database.ts apps/hub/src/database/Database.test.ts apps/hub/src/HubMode.ts \
  apps/hub/src/Logging.ts apps/hub/src/http/HubServer.ts apps/hub/src/main.ts .dependency-cruiser.cjs CONTEXT.md
git commit -m "refactor(hub): main.ts is the layer pipe; HubMode, Logging, and HubServer.serve own what it composed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: `StageSessions` keeps its services to itself

**Files:**
- Modify: `apps/hub/src/stage/StageSessions.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no interface change; `StageSessions` behaves exactly as before. The existing `StageSessions.test.ts` and `HubServer.test.ts` are its tests.

- [ ] **Step 1: Run the existing tests, to have them green before the change**

Run: `pnpm vitest run apps/hub/src/stage/StageSessions.test.ts apps/hub/src/http/HubServer.test.ts`
Expected: PASS.

- [ ] **Step 2: Build the availability from the layer's own services**

In `apps/hub/src/stage/StageSessions.ts`, directly after `const current = yield* SubscriptionRef.make(Stage.initial)`, add:

```ts
      // Where each game on the current slate can be streamed; a game no longer on the slate has none.
      const availabilityOnSlate = Effect.gen(function* () {
        const slate = yield* ingest.slate
        const availabilityOf = yield* source.availability
        return (id: GameId): Option.Option<ChannelAvailability> =>
          Option.fromNullishOr(slate.find((candidate) => candidate.id === id)).pipe(Option.map(availabilityOf))
      })
```

Replace `yield* availabilityOnSlate(ingest, source)` in `dispatch` with `yield* availabilityOnSlate`, and `availabilityOnSlate(ingest, source).pipe(` in `refresh` with `availabilityOnSlate.pipe(`. Delete the `availabilityOnSlate` function and its doc comment at the bottom of the file.

- [ ] **Step 3: Run the tests to verify nothing changed**

Run: `pnpm vitest run apps/hub/src/stage/StageSessions.test.ts apps/hub/src/http/HubServer.test.ts`
Expected: PASS.

Run: `grep -rn "\.Service\b" apps/hub/src --include=*.ts | grep -v "\.test\.ts" | grep -v "extends Context.Service"`
Expected: no output: no Hub source file takes a service as an argument.

- [ ] **Step 4: Run all checks and commit**

Run: `pnpm check`
Expected: PASS.

```bash
git add apps/hub/src/stage/StageSessions.ts
git commit -m "refactor(hub): StageSessions builds the slate's availability from its own services

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: `GET /api/health`

**Files:**
- Modify: `packages/api/src/SportalApi.ts` (the `host` group)
- Modify: `apps/hub/src/http/HubServer.ts` (`hostHandlers`, imports)
- Test: `apps/hub/src/http/HubServer.test.ts`

**Interfaces:**
- Consumes: `HubConfig` (Task 2), its `version` field.
- Produces: `client.host.health(): Effect<{ version: string; startedAt: DateTime.Utc }>` on any `SportalApi` client; route `GET /api/health`. `ApiHandlers` and `layer` in `HubServer.ts` now require `HubConfig`.

- [ ] **Step 1: Write the failing test**

In `apps/hub/src/http/HubServer.test.ts`:

Change the first import to:

```ts
import { NodeHttpServer, NodePath } from "@effect/platform-node"
```

and the `effect` import to:

```ts
import { ConfigProvider, DateTime, Effect, Layer, Option, Queue, Result, Schema, Stream } from "effect"
```

Add after the `import * as Database …` line:

```ts
import { HubConfig } from "../HubConfig.ts"
```

Add this case inside `describe("Hub API", …)`, after the "lists the addresses" case:

```ts
  it.effect("says it is up, with its version and when it started", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      const health = yield* client.host.health()
      assert.strictEqual(health.version, "1.2.3")
      assert.strictEqual(DateTime.toEpochMillis(health.startedAt), 0)
    }).pipe(Effect.provide(apiUnderTest()))
  )
```

`hubUnderTest()` gains the config as its last layer:

```ts
function hubUnderTest() {
  return StageSessions.layer.pipe(
    Layer.provideMerge(YouTubeTv.layer),
    Layer.provide(SqlChannelStore.layer),
    Layer.provide(Database.layer(":memory:")),
    Layer.provideMerge(Watch.layer),
    Layer.provideMerge(Ingest.layer(["fbs"])),
    Layer.provide(Layer.succeed(Provider, Provider.of({ slate: () => Effect.succeed([game]) }))),
    Layer.provideMerge(testConfig())
  )
}
```

and add below it:

```ts
function testConfig() {
  return HubConfig.layer.pipe(
    Layer.provide([
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { SPORTAL_VERSION: "1.2.3", SPORTAL_DATA_DIR: "unused" } })
      ),
      NodePath.layer
    ])
  )
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/hub/src/http/HubServer.test.ts`
Expected: FAIL — `client.host.health` does not exist.

- [ ] **Step 3: Declare the endpoint**

In `packages/api/src/SportalApi.ts`, the last group becomes:

```ts
  .add(
    // Where a Remote on the home network can reach this machine, and whether the Hub is up.
    HttpApiGroup.make("host").add(
      HttpApiEndpoint.get("addresses", "/addresses", { success: Schema.Array(Schema.String) }),
      HttpApiEndpoint.get("health", "/health", {
        success: Schema.Struct({ version: Schema.String, startedAt: Schema.DateTimeUtcFromString })
      })
    )
  )
```

- [ ] **Step 4: Implement the handler**

In `apps/hub/src/http/HubServer.ts`, change the `effect` import to:

```ts
import { DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
```

(`HubConfig` is already imported, by Task 3) and replace `hostHandlers` with one that is built like the other groups:

```ts
function hostHandlers() {
  return HttpApiBuilder.group(
    SportalApi,
    "host",
    Effect.fn(function* (handlers) {
      const config = yield* HubConfig
      const startedAt = yield* DateTime.now
      return handlers.handleAll({
        addresses: () => Effect.sync(() => lanAddresses(networkInterfaces())),
        health: () => Effect.succeed({ version: config.version, startedAt })
      })
    })
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/hub/src/http/HubServer.test.ts`
Expected: PASS, every case including the new one.

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm check`
Expected: PASS. The web app's client derives from `SportalApi` and needs no change.

```bash
git add packages/api/src/SportalApi.ts apps/hub/src/http/HubServer.ts apps/hub/src/http/HubServer.test.ts
git commit -m "feat(hub): GET /api/health says the Hub is up, with its version and start

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The live stream keeps itself alive

**Files:**
- Modify: `apps/hub/src/http/HubServer.ts` (`liveRoute`)
- Test: `apps/hub/src/http/HubServer.test.ts` (`describe("GET /api/live", …)`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /api/live` also carries the line `: keep-alive` followed by a blank line every 20 seconds.

- [ ] **Step 1: Write the failing test**

In `apps/hub/src/http/HubServer.test.ts`, add:

```ts
import { TestClock } from "effect/testing"
```

and add this case inside `describe("GET /api/live", …)`, after the existing case:

```ts
  it.effect("sends a comment every 20 seconds, so a proxy does not close a quiet stream", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const api = yield* HttpApiClient.make(SportalApi)
      yield* firstSlate()

      const response = yield* http.get("/api/live")
      const lines = yield* Queue.unbounded<string>()
      yield* response.stream.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line !== ""),
        Stream.runForEach((line) => Queue.offer(lines, line)),
        Effect.forkScoped
      )
      yield* Queue.take(lines)
      yield* Queue.take(lines)

      // Ingest polls during these 20 seconds too; skip the data lines that causes.
      yield* TestClock.adjust("20 seconds")
      const comment = yield* Queue.take(lines).pipe(Effect.repeat({ until: (line) => !line.startsWith("data: ") }))
      assert.strictEqual(comment, ": keep-alive")

      yield* api.stage.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })
      const change = yield* Queue.take(lines).pipe(Effect.repeat({ until: (line) => line.includes("StageChanged") }))
      assert.isTrue(change.startsWith("data: "))
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/hub/src/http/HubServer.test.ts -t "comment every 20 seconds"`
Expected: FAIL — times out waiting for a line after the clock moves.

- [ ] **Step 3: Implement the keep-alive**

In `apps/hub/src/http/HubServer.ts`, replace `liveRoute` with:

```ts
/**
 * GET /api/live — the current slate with its watchability and the stage, then every change, as server-sent events,
 * with a comment every 20 seconds so proxies that close idle connections leave a quiet stream open.
 */
function liveRoute() {
  return HttpRouter.add(
    "GET",
    "/api/live",
    Effect.gen(function* () {
      const watch = yield* Watch
      const sessions = yield* StageSessions
      const messages: Stream.Stream<LiveMessage> = Stream.merge(
        watch.changes.pipe(
          Stream.map(({ slate, watchability }) => ({ _tag: "SlateChanged" as const, slate, watchability }))
        ),
        sessions.changes.pipe(Stream.map((stage) => ({ _tag: "StageChanged" as const, stage })))
      )
      const encode = Schema.encodeSync(LiveMessageJson)
      const events = messages.pipe(Stream.map((message) => `data: ${encode(message)}\n\n`))
      // `tick` emits once at the start; only the later ticks are wanted.
      const keepAlive = Stream.tick("20 seconds").pipe(
        Stream.drop(1),
        Stream.map(() => ": keep-alive\n\n")
      )
      return HttpServerResponse.stream(Stream.merge(events, keepAlive).pipe(Stream.encodeText), {
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" }
      })
    })
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/hub/src/http/HubServer.test.ts`
Expected: PASS, including the existing "streams the current slate and stage first" case, which never moves the clock and so never sees a comment.

- [ ] **Step 5: Run all checks and commit**

Run: `pnpm check`
Expected: PASS.

```bash
git add apps/hub/src/http/HubServer.ts apps/hub/src/http/HubServer.test.ts
git commit -m "feat(hub): the live stream sends a keep-alive comment every 20 seconds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The Hub stops within seconds, with Displays connected

**Files:**
- Test: `apps/hub/src/main.test.ts` (create)
- Modify: `apps/hub/src/http/HubServer.ts` (`serve`)

**Interfaces:**
- Consumes: `GET /api/health` (Task 5); `SPORTAL_PORT`, `SPORTAL_HOST`, `SPORTAL_DATA_DIR`, `SPORTAL_SCENARIO` (Task 2); `HubServer.serve` (Task 3).
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing test**

`apps/hub/src/main.test.ts`:

```ts
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, FileSystem, Path, Schedule, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpServer } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

describe("the Hub process", () => {
  // Windows cannot send a child SIGTERM. Ctrl-C there is SIGINT, which NodeRuntime.runMain handles the same way.
  it.live.skipIf(process.platform === "win32")(
    "stops within seconds of SIGTERM with a Display connected, and leaves the database checkpointed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const http = yield* HttpClient.HttpClient
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const dataDir = yield* fs.makeTempDirectoryScoped()
        const port = yield* freePort()
        const base = `http://127.0.0.1:${port}`

        const hub = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [yield* path.fromFileUrl(new URL("./main.ts", import.meta.url))], {
            env: {
              SPORTAL_PORT: String(port),
              SPORTAL_HOST: "127.0.0.1",
              SPORTAL_DATA_DIR: dataDir,
              SPORTAL_SCENARIO: "two-minute-drill-tie"
            },
            extendEnv: true
          })
        )
        // Unread output would fill the pipe and block the Hub.
        yield* hub.all.pipe(Stream.runDrain, Effect.exit, Effect.forkScoped)

        yield* http
          .get(`${base}/api/health`)
          .pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }))
        // The stream fails when the Hub goes away; its exit is kept, not raised.
        const live = yield* http.get(`${base}/api/live`)
        yield* live.stream.pipe(Stream.runDrain, Effect.exit, Effect.forkScoped)
        assert.isTrue(yield* fs.exists(path.join(dataDir, "sportal.sqlite-wal")))

        const stopping = yield* Clock.currentTimeMillis
        yield* hub.kill({ killSignal: "SIGTERM" })
        const code = yield* hub.exitCode
        const took = (yield* Clock.currentTimeMillis) - stopping

        assert.strictEqual(code, ChildProcessSpawner.ExitCode(0))
        assert.isBelow(took, 5_000)
        assert.isTrue(yield* fs.exists(path.join(dataDir, "sportal.sqlite")))
        assert.isFalse(yield* fs.exists(path.join(dataDir, "sportal.sqlite-wal")))
        assert.isFalse(yield* fs.exists(path.join(dataDir, "sportal.sqlite-shm")))
      }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
    30_000
  )
})

/** A port nothing is listening on: a test server takes one from the OS and releases it for the Hub. */
function freePort() {
  return Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer
    return "port" in address ? address.port : yield* Effect.die("the test server listens on no TCP port")
  }).pipe(Effect.provide(NodeHttpServer.layerTest))
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/hub/src/main.test.ts`
Expected: FAIL on `assert.isBelow(took, 5_000)`, with `took` near 20 000 ms: the server waits out its default 20-second graceful shutdown for the open live stream.

If it passes instead, the server already ends live streams before it waits. Keep the test, still make the Step 3 change as an explicit bound, and say in the commit message that the test passed before the change.

If it fails on the `sportal.sqlite-wal` check while the Hub is running, SQLite has not created the WAL file in scenario mode, where nothing writes. Remove that one assertion: the after-stop assertions are the requirement.

- [ ] **Step 3: Bound the graceful shutdown**

In `apps/hub/src/http/HubServer.ts`, the `NodeHttpServer.layer` call in `serve` becomes:

```ts
    // Connected Displays hold live streams open. Unbounded, shutdown waits 20 seconds for them, and Docker kills at 10.
    const server = NodeHttpServer.layer(createServer, { port, host, gracefulShutdownTimeout: "3 seconds" })
    return HttpRouter.serve(routes).pipe(Layer.provide(server))
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/hub/src/main.test.ts`
Expected: PASS; `took` under 5 000 ms.

- [ ] **Step 5: Run all checks and commit**

Run: `pnpm check`
Expected: PASS. If knip reports `main.test.ts` or anything it imports as unused, check that `knip.json` treats `**/*.test.ts` as entries like the other tests before changing anything.

```bash
git add apps/hub/src/http/HubServer.ts apps/hub/src/main.test.ts
git commit -m "fix(hub): stop within 3 seconds with Displays connected, leaving the database checkpointed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Agents learn the new settings

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: everything above.
- Produces: documentation only.

- [ ] **Step 1: Say where adapters are named and the environment is read**

In `AGENTS.md`, under "Where code goes", replace the line `- In the Hub, only `main.ts` and tests name concrete adapters. Everything else depends on the port.` with:

```markdown
- In the Hub, only `HubMode.ts` and tests name concrete providers and sources, and `main.ts` is only the layer pipe.
  Everything else depends on the port.
```

and after it add:

```markdown
- In the Hub, only `HubConfig.ts` reads the environment. A new setting is a field there, with its default.
- A service is yielded where it is used, never passed as an argument. A layer that needs a setting yields `HubConfig`;
  a choice between layers at startup is a `Layer.unwrap` that yields it.
```

- [ ] **Step 2: Describe the data directory and settings**

In `AGENTS.md`, replace the two lines of the `pnpm --filter @sportal/hub dev` entry, from `- \`pnpm --filter @sportal/hub dev\`` through `set \`SPORTAL_DATA_DIR\` to move it.`, with:

```markdown
- `pnpm --filter @sportal/hub dev` — run only the Hub on port 4400 (API and live stream), on every interface so a phone Remote can reach it (`SPORTAL_HOST` narrows it). In
  dev it keeps its SQLite database in `.sportal/` at the repo root; set `SPORTAL_DATA_DIR` to move it. Started any other
  way, it keeps it where the OS keeps app data: `$XDG_DATA_HOME/sportal` or `~/.local/share/sportal` on Linux,
  `~/Library/Application Support/Sportal` on macOS, `%LOCALAPPDATA%\Sportal` on Windows.
- Hub settings (all in `apps/hub/src/HubConfig.ts`): `SPORTAL_PORT`, `SPORTAL_HOST`, `SPORTAL_WEB_ROOT`, `SPORTAL_DATA_DIR`,
  `SPORTAL_SCENARIO`, `SPORTAL_SCENARIO_SPEED`, `SPORTAL_LOG_LEVEL` (an Effect level, default `Info`),
  `SPORTAL_LOG_FORMAT` (`pretty` or `json`), `SPORTAL_VERSION`. A bad value stops the Hub at startup. `GET /api/health`
  answers while it is up.
- Scripts run through pnpm's own shell (`shellEmulator`), so `VAR=x cmd` in a `package.json` script works on every OS.
  Keep scripts to what that shell understands: no bash-only syntax.
```

- [ ] **Step 3: Update the technical spec**

In `docs/technical-spec.md`:
- §4.1 rule 9: replace `Within the Hub, only `main.ts` knows which concrete adapters exist.` with `Within the Hub, only `HubMode.ts` knows which concrete providers and sources exist.`
- §4.2 tree: the `main.ts` line becomes `main.ts             Composition root: the Hub's layer pipe`, and add beneath it `HubMode.ts          What the Hub plays: the live day or a scenario; the only file that names providers and sources` and `Logging.ts          Log level and format`.
- §5.1: replace `Ports are Effect services; implementations are Layers; `main.ts` chooses them.` with `Ports are Effect services; implementations are Layers; `HubMode` chooses them.`

- [ ] **Step 4: Run all checks and commit**

Run: `pnpm check`
Expected: PASS.

```bash
git add AGENTS.md docs/technical-spec.md
git commit -m "docs: the Hub's settings, its data directory per OS, where adapters are named, and scripts on any shell

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec decision | Task |
| --- | --- |
| Settings in one place; bad setting stops startup | 2 |
| The settings and defaults | 2 |
| Default data directory per OS; dev data unchanged | 2 (dev unchanged: Task 1 Step 5) |
| Composition root | 3, 4 |
| Scripts on Windows (`shellEmulator`) | 1 |
| Line endings | 1 |
| Toolchain pins | 1 |
| Path handling audit | Done while planning: every Hub and shell file path is built with `node:path` `join`/`resolve` or `new URL(…, import.meta.url)`; no `/tmp`, no splitting on `/`. Nothing to change |
| Health | 5 |
| Stopping; clean database | 7 |
| Live stream keep-alive | 6 |
| Log level and format | 3 |
| `CONTEXT.md`, `AGENTS.md` | 2, 8 |

Cleanup looked for in `SportalApi.ts` and `HubServer.ts` beyond the above: `hostHandlers` now builds like the other groups (`Effect.fn`), and `HubServer.serve` takes over serving the web UI from `main.ts`; the three `ChannelStoreError` → defect conversions in `channelHandlers` were left inline, because a shared generic helper over `Effect.catchTag` does not type cleanly and the repetition is three short, identical lines.
