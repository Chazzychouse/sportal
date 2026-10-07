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
- **Use the words in `CONTEXT.md`.** Every exported type name must be a term there; a new concept adds
  its glossary row in the same commit. The wire schemas in `*Payload.ts` and `FastCastMessage.ts` are exempt: they
  spell a provider's own words. So are React components: they are named for what they show. Terms the code does not have yet sit under Planned.

## Where code goes

- Two packages, three apps. `packages/domain` is pure and imports only Effect. `packages/api` is the
  contract between the Hub and its clients. Apps never import each other.
- A package exists only when two apps need the same code. A folder exists only when a concept has
  several files private to it. Do not add either for symmetry or for later.
- A module is a file named for the concept it owns (`Game.ts`, `Stage.ts`), imported as a namespace or
  by name. Organize by concept, never by kind: no `components/`, `hooks/`, `services/`, `schemas/`.
- Banned file and folder names: `utils`, `helpers`, `common`, `shared`, `misc`, `lib`, `types`,
  `constants`, `models`, `interfaces`, and `index.ts` barrels.
- `apps/web/src/design/` holds the vendored shadcn primitives under the CLI's own lowercase file names, so
  `shadcn add` and `shadcn diff` keep working. Nothing else goes there.
- No mirror types. There is no `GameDto`, `GameRow`, `GameResponse`, or `GameProps`. The domain schema is
  the wire format. Derive a variant at the point of use; do not name it.
- In the Hub, only `HubMode.ts`, `corpus/corpus.ts`, and tests name concrete providers and sources, and `main.ts` is only the layer pipe and how the process runs it.
  Everything else depends on the port.
- In the Hub, only `HubConfig.ts` reads the environment. A new setting is a field there, with its default.
- A service is yielded where it is used, never passed as an argument. A layer that needs a setting yields `HubConfig`
  (in the shell, `ShellConfig`); a choice between layers at startup is a `Layer.unwrap` that yields it.
- A port's member types that other modules need are named and exported beside it (`Polling`, `LiveFeed`). Nothing
  indexes a service's type with `X["Service"]`.

## Inside a file

A reader opens a file to see the thing it is named for. Keep it that way.

1. The main export comes first. No preamble of types, constants, and small helpers above it.
2. Private helpers go **below** the code that uses them, as hoisted `function` declarations, in the
   order they are first used.
3. A helper used once and a few lines long is inlined. A helper that is really an operation on another
   concept is a method or static of that concept's type.
4. Do not declare an interface or type alias for an options bag, a return shape, a callback, or
   component props used in one place. Write the shape inline in the signature.
5. A service file reads: service declaration, its layer, then private helpers.
6. A constant lives beside its only user.
7. When a file needs a table of contents, split it by concept — never into `FooTypes.ts` and
   `FooHelpers.ts`.

## How code is written

- Logic is a pure function or an `Effect`. No bare promises or `async` outside framework edges (React
  handlers, Electron callbacks).
- An operation on a domain type lives on the type: a method or static of its class (`Schema.Class`,
  `Schema.TaggedClass`), or, for a union that never crosses the wire, the constructors and `$match` of
  its `Data.taggedEnum`. Write `stage.apply(command, …)` and `GameSnapshot.watchOrder`, never an
  exported `apply(stage, …)`. A domain module exports no loose functions over its types; a private
  helper below the class that only the class uses is fine. A schema a class reads when it is defined
  (a field's type) goes above the class, because the class evaluates it then.
- Expected failures are tagged errors in the error channel. Nothing is caught and ignored.
- Time comes from Effect's `Clock`. No `Date.now()` in `packages/domain` or the Hub.
- No `any`, no non-null assertions, no enums, no default exports, no casts outside decoding.
- No export lives only for its tests: `knip --production` fails on one.
- Tests sit beside the file as `Name.test.ts`. Domain logic and provider decoding are written test-first.
  Provider tests run against recorded real payloads in the adapter's `fixtures/` folder.

## Commands

- `pnpm check` — format check, lint, typecheck, import boundaries, unused code, tests. Must pass before
  every commit; the push hook runs it.
- `pnpm install` patches `tsc` with `@effect/tsgo`, so its Effect diagnostics fail `pnpm check` and show in the
  editor. Bump `typescript` and `@effect/tsgo` together, to a pair `@effect/tsgo` lists as supported. Zed needs the
  "Effect Language Service (tsgo)" extension; `.zed/settings.json` turns vtsls off and pins its `@effect/tsgo` to
  the same version.
- `pnpm format` — apply formatting and safe lint fixes.
- `pnpm dev` — start the local Grafana (`pnpm telemetry`), then run the Hub, the web dev server, and the desktop shell
  together, each reloading on change. Without Docker it says telemetry is off and runs the rest. The shell
  waits for the UI to come up. Use `pnpm dev:x11` to run the shell through XWayland.
- `SPORTAL_SCENARIO=<name> SPORTAL_SCENARIO_SPEED=10 pnpm dev` — play a scenario instead of ESPN and YouTube TV, ten
  times faster: a written one (a script in `apps/hub/src/scenario/written/Scripts.ts`, written as ESPN's frames) or a
  recorded one, `fixtures/scenarios/<name>.frames.jsonl.gz`. Every scenario plays through ESPN's decode. A name that is
  both stops the Hub. It plays as the provider through the real ingest and fold, on a feed log
  in memory (`SPORTAL_SCENARIO_FEED_LOG` names a file in the data directory instead). Every game plays as a synthetic
  stream page. The feed log records every game day.
- `pnpm dev:golden` — the same, with the golden scenario: the recorded `crowded-fourth-quarter` at ten times speed.
- `pnpm --filter @sportal/hub dev` — run only the Hub on port 4400 (API and live stream), on every interface so a phone Remote can reach it (`SPORTAL_HOST` narrows it). In
  dev it keeps its SQLite database in `.sportal/` at the repo root; set `SPORTAL_DATA_DIR` to move it. Started any other
  way, it keeps it where the OS keeps app data: `$XDG_DATA_HOME/sportal` or `~/.local/share/sportal` on Linux,
  `~/Library/Application Support/Sportal` on macOS, `%LOCALAPPDATA%\Sportal` on Windows.
- Hub settings: every one is a field of `apps/hub/src/HubConfig.ts`, with its variable and default. A bad value stops
  the Hub at startup. `GET /api/health` answers while it is up.
- `pnpm telemetry` / `pnpm telemetry:down` — start or stop a local Grafana (`localhost:3000`) with OTLP on `localhost:4318`
  and the Hub dashboard; needs Docker. `pnpm dev` starts it but never stops it. The Hub's `dev` script sends to it unless
  `SPORTAL_OTLP_URL` says otherwise; started any other way, the Hub exports nothing until that is set.
- Scripts run through pnpm's own shell (`shellEmulator`), so `VAR=x cmd` in a `package.json` script works on every OS.
  Keep scripts to what that shell understands: no bash-only syntax.
- `pnpm --filter @sportal/web dev` — run only the web UI on port 4401, also on the home network (a phone opens `/remote`), proxying `/api` to the
  Hub. A firewall must let the home network reach both ports, or a phone loads nothing: on Omarchy,
  `sudo ufw allow from 192.168.0.0/24 to any port 4400:4401 proto tcp`.
- `pnpm --filter @sportal/desktop dev` — run only the desktop shell against the web dev server
  (`SPORTAL_HUB_URL` overrides the address).
- To run without the dev server: `pnpm --filter @sportal/web build`, start the Hub with
  `SPORTAL_WEB_ROOT=$PWD/apps/web/dist`, then `pnpm --filter @sportal/desktop start` (or `start:x11`).

## Limits that are deliberate

- Provider web players are loaded unmodified. Never inject scripts into them, rewrite their requests, or
  capture their video.
- Poll the data feed no faster than the provider's polling allows.
