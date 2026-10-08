# Sportal — Technical Spec

> Architecture, physical layout, toolchain, and the designs behind them.
> Companion to [product-plan.md](./product-plan.md).

## 1. Architectural drivers

1. **Video is not ours.** Provider players are opaque, DRM-protected web pages. Sportal positions, tunes, and mutes them; it never touches the media. Everything about video goes through a narrow **Source** boundary.
2. **Data is unofficial.** Feeds can change shape without notice. Everything about game data goes through a narrow **Provider** boundary and is decoded on the way in.
3. **One Hub, many devices.** A desk display, a TV display, and a phone remote must agree on what is on screen. Therefore all shared state — games, follows, and the state of every Screen — lives in the Hub. Clients render and send commands.
4. **The Hub is portable.** It is a plain server process configured entirely by environment, keeping nothing between runs for now. Local today, cloud later, same code.
5. **The tracker stands alone.** Every feature except video playback works in any browser on any device.
6. **One definition per concept.** A domain concept is declared once, as an Effect Schema, and that one declaration serves as the type, the decoder, and the wire format.

## 2. Stack

### 2.1 The Rust and gpui question

You like Effect, Rust, and gpui. Only one of them fits this product cleanly, and it is worth saying why rather than quietly picking.

- **The shell must be Chromium.** Provider players need Widevine. On Linux, the system web view that Rust shells (Tauri, wry, and gpui's web-view component) use is WebKitGTK, which does not play Widevine content in practice. Chromium embedding from Rust exists but is immature. Electron with the castlabs Widevine build is the dependable path.
- **The UI must run on a phone and in a TV browser.** gpui renders natively on desktop only. A gpui UI would mean building the interface twice.
- **A Rust Hub is viable but splits the model.** The Hub could be Rust (axum, tokio, sqlx). It would be fast and pleasant, but every domain concept would then exist in two languages, kept in sync by code generation. That is exactly the type proliferation you want to avoid, bought for performance this workload (polling a few endpoints, pushing to a handful of clients) does not need.

**Decided: Effect TypeScript end to end** — one language, one schema per concept, shared verbatim by Hub, web UI, and shell.

### 2.2 Choices

Versions were checked against the registry on 2026-10-03. Effect is at 4.0, which merged the former platform packages into `effect` itself (`effect/http`, `effect/http-api`, `effect/sql`).

| Concern | Choice | Why |
| --- | --- | --- |
| Language | TypeScript 7 with the Effect language service (`@effect/tsgo`), `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly` | Shared model across every process. The language service's Effect diagnostics run in `tsc` and the editor. dependency-cruiser runs on a private TypeScript 6 until it supports 7.1. Erasable-only syntax lets Node run the Hub's source directly, with no build step |
| Core library | Effect 4 | Typed errors, dependency injection by Layer, schedules for polling, streams for live data, a test clock for replaying games |
| Schemas | Effect Schema | The single definition of each domain concept: type, decoder, encoder |
| HTTP API | Effect `HttpApi` (`effect/http-api`) | The API is declared once from domain schemas; the Hub implements it and clients derive a fully typed client from the same declaration — no hand-written request or response types anywhere |
| Live transport | Server-Sent Events carrying schema-encoded messages | One-way, auto-reconnecting, proxies and cloud hosts handle it without special setup |
| Persistence | None, for now | The Hub keeps nothing between runs: a restarted Hub starts from an empty slate and its next poll fills it. Persistence is added back on top of the simplified model (ADR 0012) |
| Runtime | Node 24 (LTS), pinned in `mise.toml` | Electron's main process is Node; one runtime everywhere |
| Package manager | pnpm workspaces | Strict dependency isolation; already installed |
| Web UI | React + Vite; TanStack Router once there is more than one screen | Components stay plain React; typed routes when routing exists |
| UI state | Server state mirrored from the Hub's live stream into one store; local-only state in component state | The Hub owns shared state, so the client has little of its own |
| Styling | Tailwind CSS with two density themes (desk, couch) | Same components, two presentation modes |
| Desktop shell | Electron (castlabs Widevine build), one `WebContentsView` per stream tile, electron-vite | The only dependable way to play Widevine content in several independent views |
| Telemetry | Effect's own OTLP exporters (`effect/observability`), over OTLP/HTTP to a collector named by `SPORTAL_OTLP_URL`; without it the Hub only logs to the console | Spans, logs, and metrics with no OpenTelemetry SDK and no new dependency |
| Tests | Vitest with `@effect/vitest` | Effect-aware tests with a controllable clock |
| Lint and format | Biome | One fast tool |
| Structure enforcement | dependency-cruiser (import boundaries), knip (unused files, exports, dependencies) | The layout rules in section 4 are checked by machine, not by memory |
| Hooks | Lefthook: format and lint on commit; typecheck, test, structure checks on push | |
| Hub packaging (not built) | A container image built from `apps/hub` | The cloud move is "run the image with different environment" |

**Decided: no CI host yet.** The repository is local; the Lefthook hooks are the gate. CI is added when the repository gets a remote.

## 3. System shape

```mermaid
flowchart LR
  subgraph ext[External]
    espn[ESPN endpoints]
    cfbd[CollegeFootballData]
    yttv[Provider web players]
  end

  subgraph hub[Hub — one server process]
    prov[Providers]
    director[Director: the slate of games and the one Screen, in memory; its rules not built]
    api[HTTP API + live stream]
  end

  subgraph display[Display — desktop shell]
    ui1[Web UI]
    main[Shell main process]
    views[Provider web views]
  end

  subgraph remote[Remote — phone or browser]
    ui2[Web UI]
  end

  espn --> prov
  cfbd --> prov
  prov -- decoded frames --> director
  director -- listed games with recent plays, the Screen --> api
  api -- screen commands --> director
  api <--> ui1
  api <--> ui2
  ui1 -- tile rectangles --> main --> views
  yttv --> views
```

- **Hub** — takes what its providers' frames say, as they arrive, into the Director's slate (the listed games, each with its latest snapshot and plays), and the Director holds the authoritative **Screen** in memory beside it (one, until a second Display needs its own) and will run its rules. Serves the web UI's static files, the HTTP API, and one live stream per client.
- **Web UI** — one codebase for desk, couch, and phone. It renders Hub state and sends commands. It contains no business rules.
- **Desktop shell** — loads the web UI from the Hub, registers as a Display, and mirrors that Display's stream tiles into native provider web views. It is told the Hub's address by configuration (`SPORTAL_HUB_URL`, read once into `ShellConfig`) and never starts a Hub.

### 3.1 Why Screen state lives in the Hub

The phone must be able to change what the TV shows, and the Director's rules must be able to promote a game while no one is touching anything. If each client owned its Screen, both would need client-to-client messaging. With the Hub as owner there is one path for everyone:

```
command (from UI, remote, hotkey, or the Director's rules)
  -> Hub applies it to the pure Screen state machine
  -> new Screen state is stored and broadcast
  -> the Display's UI re-renders; the shell re-syncs its views
```

On a local network the round trip is a few milliseconds. If a cloud-hosted Hub ever makes it noticeable, the client can apply the same pure function optimistically — the function is in the shared package for that reason.

### 3.2 How the shell treats provider players

- Provider pages load **unmodified** in a dedicated persistent session: no script injection, no preload, no request rewriting. The shell sets only a view's bounds, its address, and its mute flag.
- Score strips are drawn by the web UI *beside* each view, never over it, so nothing composites on top of protected video.
- Sign-in happens in the provider's own page. Sportal never sees or stores provider credentials.
- Navigation in provider views is restricted to an allowlist of provider and sign-in domains.

### 3.3 Portability and network exposure

- All Hub configuration comes from the environment through Effect `Config`: bind address, provider keys, access token.
- For now the Hub keeps no state between runs, so it can be stopped, moved, and restarted freely: its next poll fills the slate again.
- Planned: on the home network the Hub requires a single shared access token, entered once per device. It is not built for the public internet: a cloud deployment additionally requires real authentication, which is deliberately left as a future decision record rather than half-built now.
- The Electron shell never moves to the cloud; Displays always run at home and point at wherever the Hub is.

## 4. Physical layout and module standard

This section is binding in the same way the type checker is. `AGENTS.md` carries the rules that are easiest to break.

### 4.1 Principles

1. **A boundary must earn its place.** A workspace package exists only when two or more apps need the same code. A folder exists only when a concept has several files that belong to it and nothing else. Nothing is created for symmetry, for future use, or to look like an architecture.
2. **One concept, one home.** Every type, schema, and function has exactly one obvious file. If you cannot say which concept a file owns in one noun, the file is wrong.
3. **Name files for what they own.** A module is a file named for its concept — `Game.ts`, `Screen.ts`, `Director.ts` — exporting that concept's schema or class. Operations on a domain type are methods and statics of its class (`game.progress()`, `GameSnapshot.watchOrder`, `screen.apply(command, …)`), not loose functions beside it. The tree reads as a table of contents of the domain, and each type reads as the list of what it can do.
4. **No junk drawers.** These file and folder names are banned by lint: `utils`, `helpers`, `common`, `shared`, `misc`, `lib`, `types`, `constants`, `models`, `interfaces`. A function that seems to belong in one belongs with the concept it operates on; if it operates on none, it is probably already in Effect.
5. **No barrels.** No `index.ts` re-export files. Packages expose modules through `package.json` `exports`; inside an app, import the module file directly.
6. **No mirror types.** There is no `GameDto`, `GameRow`, `GameResponse`, `GameProps`. The domain schema is the wire format. A variant is derived from the original (`pick`, `omit`, `extend`) at the point of use and is not given a name unless it is itself a domain concept with a glossary entry.
7. **Search before you write.** Before adding a function, type, or file, look for the existing one. Duplicating logic that already exists is a defect even when the code works.
8. **Organize by concept, not by kind.** No top-level `components/`, `hooks/`, `services/`, `schemas/` folders. Code for the slate lives under `slate/`, whatever kind of code it is.
9. **Dependencies point one way.** `domain` imports only Effect. `api` imports `domain`. Apps import packages. Nothing imports an app. Within the Hub, only `HubMode.ts` knows which concrete providers and sources exist, and it reaches ESPN's only through `provider/espn/Espn.ts`.

### 4.2 The tree

Two packages and three apps. Providers, sources, and the Director are used only by the Hub, so they are modules of the Hub, not packages.

```
sportal/
├── AGENTS.md                   Rules for coding agents that are easiest to break
├── CLAUDE.md                   One line: read AGENTS.md
├── CONTEXT.md                  Domain language: built terms, then the planned ones
├── mise.toml                   Pinned Node and pnpm
├── package.json                Workspace scripts: check, test, dev
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json
├── knip.json
├── vitest.config.ts            Vitest projects and coverage; each workspace has its own vitest.config.ts
├── .dependency-cruiser.cjs     Import-direction and banned-name rules
├── lefthook.yml
├── telemetry/                  Local Grafana: compose file and the Hub's dashboards
│
├── docs/
│   ├── product-plan.md
│   ├── technical-spec.md
│   ├── game-day-checklist.md   What only a live game day can verify
│   ├── history.md              The shipped pieces, and where their old plans live in git
│   ├── adr/                    One short file per hard-to-reverse decision
│   ├── specs/                  Designs not yet built, and the cleanup's
│   └── plans/                  The cleanup's plan
│
├── packages/
│   ├── domain/                 Pure. Imports only Effect. No I/O.
│   │   └── src/
│   │       ├── League.ts       LeagueId
│   │       ├── Team.ts         Team, its colors, Ranking
│   │       ├── Game.ts         Game (a snapshot and its plays), GameId, GameStatus, GameSnapshot, BallSpot, Network, Broadcast
│   │       ├── Situation.ts    Possession, down, distance, field position, red zone
│   │       ├── Play.ts         A single play, as the game's play-by-play lists it; PlayKind
│   │       ├── Channel.ts      SourceName, Channel, ChannelAvailability
│   │       ├── Guide.ts        Guide, Airing, ChannelId, GuideUnreadable
│   │       ├── Stream.ts       StreamLocator
│   │       ├── Screen.ts        Tile, LayoutName, Split, Screen state, slot counts and split bounds, ScreenCommand, ScreenRejection, apply, invariants
│   │       └── TestGame.ts     Game snapshots and plays for tests
│   │
│   └── api/                    The contracts between processes.
│       └── src/
│           ├── SportalApi.ts   HttpApi declaration: endpoint groups built from domain schemas
│           ├── LiveMessage.ts  The union of messages on the live stream
│           ├── ShellBridge.ts  What the desktop shell exposes to the web UI; TilePlacement, TileBounds
│           ├── ShellChannel.ts The IPC channel names, apart so the sandboxed preload bundles only them
│           └── Hotkey.ts       The keys Sportal acts on, with their help text
│
└── apps/
    ├── hub/
    │   └── src/
    │       ├── main.ts             Composition root: the Hub's layer pipe, run until a signal stops it
    │       ├── HubMode.ts          What the Hub plays: the live day; the only file that names providers and sources, ESPN's through `Espn`
    │       ├── HubConfig.ts        Every environment setting, in one place
    │       ├── Telemetry.ts        Log level and format; OTLP export when configured
    │       ├── Director.ts         The one holder of the slate and the Screen: takes each frame's deliveries as they arrive, applies screen commands, refreshes availability
    │       ├── slate/
    │       │   ├── Slate.ts        The fold: every delivery taken in order into an ordered list of games, each with its latest snapshot and its plays
    │       │   └── Delivery.ts     What a frame said: a listing, a snapshot, or a game's plays
    │       ├── HubStopping.ts      Whether a task that should run until the Hub stops ended because it is stopping, and the Error log unless it did
    │       ├── Frame.ts            A frame as received, and its DeliverySource
    │       ├── Gzip.ts             The text a gzip'd or deflated body holds, as FastCast's patches are
    │       ├── TestTelemetry.ts    Layers for tests
    │       ├── TestDirector.ts     The Director taking the snapshot feed, and what it takes of a test's frames
    │       ├── TestSnapshotFeed.ts The snapshot feed: a provider whose frames say what a test delivers; for tests only
    │       ├── HubServer.ts        Serves the API, the live stream, the addresses a phone can reach, and the web UI's files
    │       ├── provider/
    │       │   ├── Provider.ts     The port: `deliveries`, each frame's in order
    │       │   ├── TestProvider.ts What the provided `Provider` lists, and what ESPN's decode says of a test's frames
    │       │   └── espn/
    │       │       ├── Espn.ts             ESPN's one front door: the live provider (`layer`), polling and pushing through FastCast
    │       │       ├── EspnProvider.ts     Implements the port: polls each league on its own cadence, merges FastCast's push, and decodes
    │       │       ├── EspnDecoder.ts      Frames to deliveries: listings, snapshots, plays; each league's decode (`byLeague`)
    │       │       ├── EspnPayload.ts      ESPN's JSON as ESPN spells it: events, scoreboard, plays
    │       │       ├── EspnEvent.ts        One game as either ESPN feed spells it, as a GameSnapshot
    │       │       ├── EspnPlay.ts         ESPN's plays and their type ids, as Play
    │       │       ├── FastCast.ts         ESPN's push, a service: the socket, as frames; its checkpoint retry is the schedule `FastCast.layer` builds it with
    │       │       ├── FastCastDocument.ts A topic's document, rebuilt from checkpoints and patches
    │       │       ├── FastCastMessage.ts  FastCast's wire shapes
    │       │       ├── FastCastTopic.ts    A topic's owner, and the topic of a scoreboard or a game
    │       │       ├── TestEspn.ts         Recorded frames for tests of other modules, NE at BUF's day among them (`recordedNeAtBuf`)
    │       │       └── fixtures/           Recorded real payloads, NE at BUF's frames among them
    │       └── source/
    │           ├── Source.ts       The port
    │           └── youtube-tv/
    │               ├── YouTubeTv.ts         Guide reading and availability
    │               ├── YouTubeTvPayload.ts  The guide response's wire shape
    │               ├── TestYouTubeTv.ts     A recorded guide for tests of other modules
    │               └── fixtures/            Recorded real payloads
    │
    ├── web/
    │   └── src/
    │       ├── main.tsx
    │       ├── theme.css           Desk and couch density themes
    │       ├── design/             Vendored shadcn primitives, under the CLI's own file names
    │       ├── display/            This device's Display: state and rules, hotkeys, full screen, overlays, top bar, command palette
    │       ├── hub/                HubClient (typed client from SportalApi), LiveStream (the live stream), HubRuntime
    │       ├── slate/              The slate strip and its cards
    │       ├── screen/              The Screen: tiles, dividers, tile actions, rejections
    │       ├── layout/             Layout (the geometry: slots, dividers, next, clamp), its picker and glyphs
    │       ├── game/               A game's status, score, and logo, as slate and tiles show them; the field, which draws a game's plays
    │       └── remote/             The phone Remote: screen map, join QR code
    │
    └── desktop/
        └── src/
            ├── main/
            │   ├── main.ts             App lifecycle: the shell's layers, and the window's IPC
            │   ├── ShellConfig.ts      Every setting the shell reads from its environment: the Hub's address
            │   ├── ShellWindow.ts      The shell's one window, confined to the Hub's origin
            │   ├── TileViews.ts        Creates, positions, tunes, and mutes provider views
            │   ├── Transition.ts       The arithmetic of a Screen transition
            │   ├── GuideReader.ts      Reads the source's guide with its own request
            │   ├── ProviderSession.ts  The persistent session and its permissions
            │   ├── Navigation.ts       Keeps a page on the addresses allowed
            │   ├── Sandbox.ts          What every window and view runs under
            │   └── YouTubeTv.ts        YouTube TV's sign-in address, hosts, and origin
            └── preload/
                └── ShellBridge.ts      Implements the shell bridge declared in packages/api
```

Tests sit beside the file they test as `Game.test.ts`. A module grows into a folder of the same name only when it genuinely has private parts, as `provider/espn/` does. Regenerate this tree from `git ls-files` when the layout changes.

**Not built:** domain `Follow.ts`, `Rule.ts`; hub `Dockerfile`, `provider/cfbd/`, `director/`, and stores for follows, presets, and rules; web `settings/` and a game's detail view. The Director, follows, presets, rules, the spoiler shield, and cloud hosting in the sections below are designs, not code.

### 4.3 Inside a file

The same standard applies within a file as across the tree: a file is not a junk drawer either. Someone opens `Director.ts` to read how the Director takes its provider's frames and applies screen commands, and that is what they should see first.

1. **The main thing comes first.** A file leads with the concept it is named for — the schema, the service, the component. A reader should reach the main behaviour without scrolling past anything.
2. **Supporting code goes below, not above.** Private helpers are written as hoisted `function` declarations beneath the code that uses them, in the order they are first used. No stack of small helpers piled on top of the thing the file exists for.
3. **A helper must earn a name.** If it is used once and is a few lines, inline it. If it is really an operation on another concept, it belongs on that concept's type (`game.progress()`, not a local `gameProgress`). If Effect already has it, use Effect's.
4. **No incidental types.** Do not declare an interface or type alias for an options bag, a return shape, a callback, or a component's props that is used in one place — write the shape inline in the signature. A named type appears in a file only when it is that file's concept or a glossary term that lives there.
5. **A service reads as its behaviour.** A service file is: the service declaration (its interface is the one type in the file), then the Layer that implements it, then private helpers. Not a preamble of types and constants followed, eventually, by the logic.
6. **Constants live with their only user.** A value used by one function is declared in or directly beneath that function, not gathered at the top of the file.
7. **When a file needs a table of contents, split it** — by concept, into a folder of the same name, never into `FooTypes.ts` and `FooHelpers.ts`.

### 4.4 What gets checked automatically

| Rule | Tool |
| --- | --- |
| Import direction (section 4.1, rule 9); provider folders private to themselves | dependency-cruiser |
| Banned file and folder names; no `index.ts` barrels | dependency-cruiser |
| No unused files, exports, or dependencies | knip |
| No `any`, no non-null assertions, no default exports | Biome |

Rules 2, 6, and 7 of section 4.1 and all of section 4.3 need judgement and are review criteria. Every review asks three questions: does this duplicate something that exists; does every new type name appear in the glossary; and does each touched file still open on its main behaviour?

## 5. Key designs

### 5.1 Ports

Ports are Effect services; implementations are Layers; `HubMode` wires them. Signatures are indicative.

**Provider** — game data in, as each frame's deliveries:

```ts
class Provider extends Context.Service<Provider, {
  readonly deliveries: Stream<ReadonlyArray<Delivery>>   // what each frame it receives said, in order received; never fails
}>()("sportal/hub/provider/Provider") {}
```

- A provider runs itself. It polls, follows its push, reconnects, and reads each frame it receives with its own decode, for as long as it runs; nothing tells it what to do. Its failures are logged and counted inside its folder, where they happen.
- Each element is one frame's `Delivery`s (`Listing`, `Snapshot`, or `Plays`), in the order it said them. ESPN's decode (`EspnDecoder.decode`) skips an event or a play that does not decode and delivers the rest; a frame that does not decode says nothing and is a Warning log. The snapshot feed (`TestSnapshotFeed.ts`) is the provider tests play: its frames say our own deliveries.
- ESPN's cadence is `EspnProvider`'s: it sets each next delay from the scoreboards it just fetched, about every 10 seconds while any game is live, every minute near kickoff, every 15 minutes otherwise. FastCast (`docs/adr/0007-fastcast-live-feed.md`) is the service its push reads from: it follows a game topic while its own scoreboard topic shows the game live or near kickoff, re-checkpoints a topic itself when a patch will not apply, and retries its socket on a jittered exponential backoff.
- Provider vocabulary stops at the folder edge. ESPN's "event", "competition", and "competitor" exist only in `EspnPayload.ts`, `EspnEvent.ts`, `FastCastMessage.ts`, and `EspnPlay.ts`.
- The Hub composes providers per league: ESPN for NFL; ESPN with CollegeFootballData filling gaps for FBS. The composition is itself a `Provider`, so the Director sees one.
- Each adapter's tests are "this recorded frame decodes to this delivery".

**Director** — the one holder of the day's slate and the Screen, between the provider and everything that reads games
or changes the Screen. Not a port: one implementation (`docs/adr/0009-one-fold-not-actors.md`, amended by
[ADR 0012](./adr/0012-no-persistence-one-take.md)):

```ts
class Director extends Context.Service<Director, {
  readonly slate: Effect<Slate>
  readonly slateChanges: Stream<Slate>               // the latest first, then each change
  readonly screen: Effect<Screen>
  readonly screenChanges: Stream<Screen>               // the latest first, then each change
  dispatch(command: ScreenCommand): Effect<Screen, ScreenRejection>
}>()("sportal/hub/Director") {}
```

- The `Slate` (`slate/Slate.ts`) is the fold: an ordered list of `Game`s, leagues in `LeagueId` order and each league's in its listing's order, each with its latest `GameSnapshot` and its plays. `take(deliveries)` on it is pure and returns the next slate; a take that changes nothing gives back the same slate.
- The Director starts from an empty slate and takes each frame's deliveries as they arrive, in one `Director.take` span carrying its `sportal.deliveries` count, and gauges each game whose snapshot changed by its progress (`sportal_game_state`: 1 upcoming, 2 live, 3 over, 0 once no listing names it), which the Hub dashboard's Games table reads. For now nothing is kept between runs: a restarted Hub serves an empty slate until its provider's next poll lists the day's games.
- A take that raises a defect is an Error log; the slate keeps what it had and takes the next frame. If the provider's frames end other than by the Hub stopping, that is an Error log and the slate stays as it is.
- `Slate.published()` is each listed game as the slate has it, carrying only its last ten plays (`Game#recent`, on `SlateChanged`); the Hub server sends it within 250 ms of a change, and `dispatch` reads the slate's games for where each can be streamed.
- `HubMode` provides it over ESPN as the provider and YouTube TV as the source.
- The Hub's whole shutdown bound is about 4 s: the HTTP server's 3 s for connected Displays, then telemetry's 1 s to export what it holds.

**Source** — video out:

```ts
class Source extends Context.Service<Source, {
  readonly budget: StreamBudget
  readonly availability: Effect<(game: GameSnapshot) => ChannelAvailability>
  readonly changes: Stream<void>
  readGuide(guide: string): Effect<void, GuideUnreadable>
}>()("sportal/hub/Source") {}
```

A source's channels are found in its own guide, read by the shell (`docs/history.md`, "Guide-matched channels"); with no fresh guide, a source answers "no guide".

`StreamLocator` is a tagged union. Today it has one member, a web-view address; a new kind is added only when a source needs it.

**Stores** — none, for now. The Hub keeps nothing between runs ([ADR 0012](./adr/0012-no-persistence-one-take.md)); persistence is added back on top of the simplified model. A Screen is not stored either.

### 5.2 Frames and deliveries

- Polling is the provider's own: ESPN polls about every 10 seconds while any game is live, every minute near kickoff, every 15 minutes otherwise. One slate request per league covers every game; detail is fetched only for games someone has open or on a Screen.
- A college Saturday is one request for 50+ games, not 50 requests.
- The provider decodes its own frames; the Director takes each frame's deliveries as they arrive, in the order the provider received its frames. Nothing is logged raw or replayed.
- The live feed pushes snapshots between polls, and, for each current game, its plays. A pushed game is advanced onto its listed game; one no poll has listed yet is not delivered. The poll gives listings: a listing takes each of its games as a snapshot and forgets the league's games it no longer names. A snapshot of a listed game, polled or pushed, is taken unless it is behind the game: earlier in game time, or at the same game time with fewer points (a poll lagging a pushed score, `isAheadOf`); an over game takes one ahead of its end (overtime after a spurious final, a postponed game resuming), so a lagging poll cannot start a finished game again. There is no tie rule and no hold.
- A FastCast topic that loses its document (a missed message, a patch that will not apply) is a Warning log, and the push follows the topic again from its checkpoint.
- Game events are gone: nothing read them (ADR 0012). The Director's rules will derive them again from snapshot changes and plays when they are built.
- The slate's games and plays are the latest the feeds gave; a missed poll is filled by the next one, and a restart starts from empty until persistence is added back (ADR 0012).

### 5.3 Screen

`screen.apply(command, availabilityOf)` is a pure method returning the new Screen or a typed rejection.

- State: a layout (`Single`, `Pair`, `Quad`, `MainThree`, `MainFive`), each layout's split, the tiles (each empty, stream, or data), audio focus, and solo. The first `Screen.slotCount(layout)` tiles are on screen, main tile first; the rest are the **bench**, kept in order and not played. Audio focus and solo name a game, so they follow it when tiles move.
- Commands: `Assign`, `Clear`, `Swap`, `Promote`, `SetLayout`, `SetSplit`, `Solo`, `Unsolo`, `FocusAudio`. `LoadPreset` comes with presets.
- Invariants, enforced only here: a game appears in at most one tile, on screen or benched; audio focus is an on-screen game (the focused one while it is on screen, else the first), or none on an empty screen; solo is an on-screen game; dividers stay within 0.2–0.8. Still to come: stream tiles per source across **all** Displays never exceed that source's budget, and an assignment beyond it becomes a data tile.
- Geometry: the web's `Layout#slots` gives each slot as fractions of the Screen area. The web UI turns them into pixels once and uses the same numbers for its tile chrome and the shell's tile placements, so the two move together along one **Screen transition** (280 ms, `cubic-bezier(0.2, 0, 0, 1)`), which the shell follows by moving each view's bounds.
- Full screen is the Display's window, local to it, and is not Screen state.

The `Director` in the Hub holds the one Screen in memory, applies commands from any origin, and broadcasts it. Nothing is persisted: a restart starts an empty Screen, and a second Display would need a keyed session.

### 5.4 Director

Designed in full in `docs/specs/2026-10-03-director-design.md`.

- What makes a game worth watching is still to be designed again: the first watchability score is gone, and the
  Director's rules read game events and plays.
- A **Trigger** is a condition over events and snapshots; a **Rule** binds a trigger to a screen command and a revert condition.
- The Director runs in the Hub, so it works with no client focused and affects every Display consistently.
- A manual command on a tile suppresses automation on that tile for a cooldown.

### 5.5 Time and the spoiler shield

- Time comes only from Effect's `Clock`. Tests use the test clock to replay a recorded game at any speed.
- Each stream tile has a tile delay. The Hub's live stream is immediate; the *client* holds back score data for that game by the delay, so different Displays can have different delays for the same game.

### 5.6 Failure behaviour

Expected failures are typed errors in the Effect error channel, each handled where it can be handled meaningfully.

| Failure | Behaviour |
| --- | --- |
| Provider unreachable or refused | Logged and counted by league (`sportal_provider_errors`); the slate keeps each game's last snapshot; that league is polled again within 30 s |
| Payload fails to decode | Skip that game or play and deliver the rest; a frame that does not decode says nothing and is a Warning log |
| Stream view fails to load | Tile becomes a data tile with a retry action |
| Over budget | Assignment becomes a data tile; the UI says why |
| Client loses the Hub | UI shows disconnected and reconnects; provider views keep playing |
| Live feed refused, closed, silent, or out of step | Logged and counted by reason; resubscribed from a checkpoint with backoff from 1 s to 1 min; the poll carries on, so games go on updating at the poll's pace |
| Applying a delivery dies | Error log; the slate keeps what it had and takes the next frame |
| Telemetry collector unreachable | One warning naming its URL; the exporters drop what they cannot send and the Hub carries on, and still stops within its shutdown bound |

## 6. Domain language

[`CONTEXT.md`](../CONTEXT.md) holds the glossary: built terms first, planned ones after. Every exported type name must be a term there.

## 7. Coding practices

[`AGENTS.md`](../AGENTS.md) holds the rules for how code is written, tested, and committed. Section 4 above says where code goes.

## 8. History

What shipped, in what order, the finished spikes, and the early decisions are in [`history.md`](./history.md). Old plans and designs are read from git, at the commit it names.
