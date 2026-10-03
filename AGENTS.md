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
- `apps/web/src/design/` holds the vendored shadcn primitives under the CLI's own lowercase file names, so
  `shadcn add` and `shadcn diff` keep working. Nothing else goes there.
- No mirror types. There is no `GameDto`, `GameRow`, `GameResponse`, or `GameProps`. The domain schema is
  the wire format. Derive a variant at the point of use; do not name it.
- In the Hub, only `main.ts` and tests name concrete adapters. Everything else depends on the port.

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
- Tests sit beside the file as `Name.test.ts`. Domain logic and provider decoding are written test-first.
  Provider tests run against recorded real payloads in the adapter's `fixtures/` folder.

## Commands

- `pnpm check` — format check, lint, typecheck, import boundaries, unused code, tests. Must pass before
  every commit; the push hook runs it.
- `pnpm format` — apply formatting and safe lint fixes.
- `pnpm dev` — run the Hub, the web dev server, and the desktop shell together, each reloading on change.
  The shell waits for the UI to come up. Use `pnpm dev:x11` to run the shell through XWayland.
- `pnpm --filter @sportal/hub dev` — run only the Hub on http://127.0.0.1:4400 (API and live stream). In
  dev it keeps its SQLite database in `.sportal/` at the repo root; set `SPORTAL_DATA_DIR` to move it.
- `pnpm --filter @sportal/web dev` — run only the web UI on http://127.0.0.1:4401, proxying `/api` to the
  Hub.
- `pnpm --filter @sportal/desktop dev` — run only the desktop shell against the web dev server
  (`SPORTAL_HUB_URL` overrides the address).
- To run without the dev server: `pnpm --filter @sportal/web build`, start the Hub with
  `SPORTAL_WEB_ROOT=$PWD/apps/web/dist`, then `pnpm --filter @sportal/desktop start` (or `start:x11`).

## Limits that are deliberate

- Provider web players are loaded unmodified. Never inject scripts into them, rewrite their requests, or
  capture their video.
- Poll the data feed no faster than `Cadence` allows.
