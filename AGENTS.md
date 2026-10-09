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
- A module is a file named for the concept it owns (`Game.ts`, `Screen.ts`), in one of the shapes under
  "Module shapes". Organize by concept, never by kind: no `components/`, `hooks/`, `services/`, `schemas/`.
- Banned file and folder names: `utils`, `helpers`, `common`, `shared`, `misc`, `lib`, `types`,
  `constants`, `models`, `interfaces`, and `index.ts` barrels.
- `apps/web/src/design/` holds the vendored shadcn primitives under the CLI's own lowercase file names, so
  `shadcn add` and `shadcn diff` keep working. Nothing else goes there.
- No mirror types. There is no `GameDto`, `GameRow`, `GameResponse`, or `GameProps`. The domain schema is
  the wire format. Derive a variant at the point of use; do not name it.
- In the Hub, only `main.ts` and tests name concrete providers and sources (ESPN's only through `provider/espn/Espn.ts`); a source port's layer variants (`Source.layerYouTubeTv`, `GuideReader.layerYouTubeTv`) name theirs too, and only the port modules import a source's folder. `main.ts` is only the layer pipe and how the process runs it.
  Everything else depends on the port.
- In the Hub, only `HubConfig.ts` reads the environment. A new setting is a field there, with its default.
- A service is yielded where it is used, never passed as an argument. A layer that needs a setting yields `HubConfig`
  (in the shell, `ShellConfig`); a choice between layers at startup is a `Layer.unwrap` that yields it.
- A port's member types that other modules need are named and exported beside it (`Wanted` beside `FastCast`).
  Indexing a service's type (`Foo["Service"]`) is allowed; a port still names the member types other modules need.

**Module shapes.** Every `.ts` file is exactly one of these.

| Shape | Exports | Imported |
|---|---|---|
| Class module | One class named for the file (service, `Schema.Class`, `Data.Class`), and beside it only that concept's member types, errors and the schemas its fields read | By name |
| Namespace module | No class of its own: an adapter of a port defined elsewhere (`EspnProvider`), a layer that provides no service (`Telemetry`), or a set of functions (`HubStopping`). An adapter or layer-only module exports `layer` | `import * as X` |
| Payload module (`*Payload.ts`) | A provider's wire spelling, with no transform into domain types | By name |
| Entry point (lowercase) | Nothing; it runs a process (`main.ts`) | – |
| Test module (`Test*.ts`) | Fixtures, recorded payloads, builders of domain values, harnesses composing several layers, test-only adapters of a port | As its shape says |

## Inside a file

A reader opens a file to see the thing it is named for. Keep it that way.

1. The main export comes first. No preamble of types, constants, and small helpers above it; the one exception is the schemas a class reads when
   it is defined (see "Order inside a class module").
2. Private helpers go **below** the code that uses them, in the order they are first used, spelled as the table below says.
3. A helper used once and a few lines long is inlined. A helper that is really an operation on another
   concept is a method or static of that concept's type.
4. Do not declare an interface or type alias for an options bag, a return shape, a callback, or
   component props used in one place. Write the shape inline in the signature.
5. A class module reads in the order under "Order inside a class module".
6. A constant lives beside its only user; a metric is the exception (see the table below).
7. When a file needs a table of contents, split it by concept — never into `FooTypes.ts` and
   `FooHelpers.ts`.
8. A blank line between the phases of a generator block or function body, not between every `yield*`.
9. Each `yield*` is on its own line, bound to its own `const` (or a statement alone), never nested in another
   expression. Not `Stream.runForEach((yield* Provider).deliveries, take)`, but
   `const provider = yield* Provider` then `Stream.runForEach(provider.deliveries, take)`.
10. A value that takes a calculation to build, or a pipe more than two levels deep, gets a name before it is used;
    a constructor is a plain list of fields. Not `new Frame({ receivedAt, ...where, body: Schema.encodeSync(SnapshotPayload)(payload) })`,
    but `const body = Schema.encodeSync(SnapshotPayload)(payload)` then `new Frame({ receivedAt, ...where, body })`.
11. A long chain of steps that does one thing is a named function (a private helper below its user, or a method of
    its concept), as `snapshotTaken` in `Slate.ts` is.

## How code is written

- Logic is a pure function or an `Effect`. No bare promises or `async` outside framework edges (React
  handlers, Electron callbacks).
- An operation on a domain type lives on the type: a method or static of its class (`Schema.Class`,
  `Schema.TaggedClass`), or, for a union that never crosses the wire, the constructors and `$match` of
  its `Data.taggedEnum`. Write `screen.apply(command, …)` and `GameSnapshot.watchOrder`, never an
  exported `apply(screen, …)`. A domain module exports no loose functions over its types; a private
  helper below the class that only the class uses is fine.
- One spelling per kind:

| Kind | Spelling |
|---|---|
| Service id | `"sportal/<app>/<dir>/Name"`, the folder under `src/` (no `src/` itself), omitted for a file directly in `src/`: `"sportal/hub/provider/Provider"`, `"sportal/hub/Director"` |
| Service layer | `static readonly layer: Layer.Layer<…> = …`, type written out |
| Layer variant | `static readonly layerX`, or `static layerX(args)`, as `HubConfig.layerTest(env)`; never another word (`HubConfig.from(env)`) |
| Test layer | `static readonly layerTest` or `static layerTest…(args)` on the service it fakes; knip's `ignoreMembers` exempts `^layerTest` |
| Layer providing nothing | A namespace module's `layer`, or `layerX`. Never `serve`/`listen`, never a zero-argument function returning a layer |
| Effectful operation | `const f = Effect.fn("Module.f")(…)`, or `Effect.fnUntraced` on a hot path; a service member is `Effect.fn("Service.member")`. Never a `function` that only returns `Effect.gen`, never a hand-added `Effect.withSpan` |
| Pure helper | A hoisted `function`, below its first user |
| Wire value | `export const X = Schema.…`, then `export type X = typeof X.Type` |
| Wire union | `Schema.TaggedUnion({…})` with its type; `X.match`, `X.guards`. Cases with behaviour: one `Schema.TaggedClass` each, then `Schema.Union` (`FootballPlay`) |
| Wire-union value | A literal, `{ _tag: "NotCarried", why: "NotInGuide" }`, typed by where it goes (annotate a bare `const`); `X.cases.Y.make` only when the case has checks or defaults |
| In-memory value | `Data.Class` |
| In-memory state | `type X = Data.TaggedEnum<…>` with `const X = Data.taggedEnum<X>()`; `X.$match`, `X.$is`. Never `_tag ===`, never `Match.valueTags` |
| Expected error | `Schema.TaggedError` named for what happened, never `…Error` (`ProviderUnavailable`) |
| Object shape | `interface`; `type` stays for functions, schedules, unions and derived types |
| Metric | A private const at the end of its file, named for what it measures; its id never changes |
| Codec | `const decodeX` / `encodeX` below its users |

- An `Effect.fn` const is not hoisted: it may sit below its user only when that user runs it lazily (inside a
  generator or a layer's effect), never when an eager top-level expression calls it.
- Order inside a class module: the schemas the class reads when defined; the class (a service: interface, `layer`, the
  `layer…` variants, then `layerTest…`; a data class: fields, statics, methods); its member types and errors; private
  helpers in first-use order; codecs; metrics. A second state machine that outgrows its service moves to a sibling file
  in the concept's folder, never to the bottom of the service file.
- Expected failures are tagged errors in the error channel. Nothing is caught and ignored.
- Time comes from Effect's `Clock`. No `Date.now()` in `packages/domain` or the Hub.
- No `any`, no non-null assertions, no enums, no default exports, no casts outside decoding.
- No export lives only for its tests: `knip --production` fails on one.

## Tests

- Tests sit beside the file as `Name.test.ts`. Domain logic and provider decoding are written test-first.
  Provider tests run against recorded real payloads in the adapter's `fixtures/` folder.
- A `Test*.ts` file is named for the concept it builds or fakes and sits beside its module.
- A fake of one service is a `layerTest…` static on that service; it takes its data as arguments and imports no
  fixture or `Test*.ts`. Everything else a test needs stays in `Test*.ts`.
- One behaviour per test. Several cases are several tests; `it.each` only when the cases are one behaviour over
  different inputs.
- `it("should …")`; the `describe` names the unit (`describe("GameSnapshot#progress")`).
- Arrange, Act, Assert, separated by a blank line each, with no `// Arrange` comments. Nothing to arrange: Act, then
  Assert.
- Rewriting a test keeps every assertion it had, unless the behaviour it asserts was removed: that assertion goes
  with the behaviour. The commit body lists, per rewritten file, each old test name and the new test names that carry
  its assertions, or the removed behaviour it went with.

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
- `pnpm --filter @sportal/hub dev` — run only the Hub on port 4400 (API and live stream), on every interface (`SPORTAL_HOST` narrows it). For
  now it keeps nothing between runs: a restarted Hub starts from an empty slate and the next poll fills it.
- Hub settings: every one is a field of `apps/hub/src/HubConfig.ts`, with its variable and default. A bad value stops
  the Hub at startup. `GET /api/health` answers while it is up.
- `pnpm telemetry` / `pnpm telemetry:down` — start or stop a local Grafana (`localhost:3000`) with OTLP on `localhost:4318`
  and the Hub dashboard; needs Docker. `pnpm dev` starts it but never stops it. The Hub's `dev` script sends to it unless
  `SPORTAL_OTLP_URL` says otherwise; started any other way, the Hub exports nothing until that is set.
- Scripts run through pnpm's own shell (`shellEmulator`), so `VAR=x cmd` in a `package.json` script works on every OS.
  Keep scripts to what that shell understands: no bash-only syntax.
- `pnpm --filter @sportal/web dev` — run only the web UI on port 4401, also on the home network, proxying `/api` to the
  Hub. A firewall must let the home network reach both ports, for another device to load the UI: on Omarchy,
  `sudo ufw allow from 192.168.0.0/24 to any port 4400:4401 proto tcp`.
- `pnpm --filter @sportal/desktop dev` — run only the desktop shell against the web dev server
  (`SPORTAL_HUB_URL` overrides the address).
- To run without the dev server: `pnpm --filter @sportal/web build`, start the Hub with
  `SPORTAL_WEB_ROOT=$PWD/apps/web/dist`, then `pnpm --filter @sportal/desktop start` (or `start:x11`).

## Limits that are deliberate

- Provider web players are loaded unmodified. Never inject scripts into them, rewrite their requests, or
  capture their video.
- Poll the data feed no faster than the provider's polling allows.
