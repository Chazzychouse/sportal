# Sportal — Technical Spec

> Architecture, physical layout, toolchain, and the designs behind them.
> Companion to [product-plan.md](./product-plan.md).

## 1. Architectural drivers

1. **Video is not ours.** Provider players are opaque, DRM-protected web pages. Sportal positions, tunes, and mutes them; it never touches the media. Everything about video goes through a narrow **Source** boundary.
2. **Data is unofficial.** Feeds can change shape without notice. Everything about game data goes through a narrow **Provider** boundary and is decoded on the way in.
3. **One Hub, many devices.** A desk display, a TV display, and a phone remote must agree on what is on screen. Therefore all shared state — games, follows, and the state of every Stage — lives in the Hub. Clients render and send commands.
4. **The Hub is portable.** It is a plain server process configured entirely by environment, with storage behind a port. Local today, cloud later, same code.
5. **The tracker stands alone.** Every feature except video playback works in any browser on any device.
6. **One definition per concept.** A domain concept is declared once, as an Effect Schema, and that one declaration serves as the type, the decoder, the wire format, and the storage codec.

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
| Persistence | Effect SQL: SQLite locally, Postgres when cloud-hosted | Same repository code against either; chosen by configuration |
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
    ingest[Ingest: poll, push, append]
    feedlog[(Feed log: feed.sqlite)]
    decode[Decoder: the provider's decode, frames to deliveries]
    slate[Live slate: every game's state and plays, from both feeds]
    corpus[Corpus: typed days, built from the feed log or the archive; run on virtual time]
    director[Director: rules over game events and plays, not built]
    stages[Live stage: the one Stage, in memory]
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
  prov -- frames --> ingest
  ingest -- every frame, raw --> feedlog
  feedlog -- frames in seq order --> decode
  prov --> decode
  decode -- deliveries --> slate
  slate -- live games for the polling Schedule, and the live feed's demand --> ingest
  slate -- listed games, recent plays --> api
  feedlog -- build --> corpus
  corpus -- days --> slate
  slate -- game events --> director
  director -- stage commands --> stages
  api <--> ui1
  api <--> ui2
  stages --> api
  ui1 -- tile rectangles --> main --> views
  yttv --> views
```

- **Hub** — polls providers and follows their live feeds, appends every frame to the feed log, takes what the frames say into the slate: each game's plays and state, and its game events, runs the Director, and holds the authoritative **Stage** in memory (one, until a second Display needs its own). Serves the web UI's static files, the HTTP API, and one live stream per client.
- **Web UI** — one codebase for desk, couch, and phone. It renders Hub state and sends commands. It contains no business rules.
- **Desktop shell** — loads the web UI from the Hub, registers as a Display, and mirrors that Display's stream tiles into native provider web views. It is told the Hub's address by configuration (`SPORTAL_HUB_URL`, read once into `ShellConfig`) and never starts a Hub.

### 3.1 Why Stage state lives in the Hub

The phone must be able to change what the TV shows, and the Director must be able to promote a game while no one is touching anything. If each client owned its Stage, both would need client-to-client messaging. With the Hub as owner there is one path for everyone:

```
command (from UI, remote, hotkey, or Director)
  -> Hub applies it to the pure Stage state machine
  -> new Stage state is stored and broadcast
  -> the Display's UI re-renders; the shell re-syncs its views
```

On a local network the round trip is a few milliseconds. If a cloud-hosted Hub ever makes it noticeable, the client can apply the same pure function optimistically — the function is in the shared package for that reason.

### 3.2 How the shell treats provider players

- Provider pages load **unmodified** in a dedicated persistent session: no script injection, no preload, no request rewriting. The shell sets only a view's bounds, its address, and its mute flag.
- Score strips are drawn by the web UI *beside* each view, never over it, so nothing composites on top of protected video.
- Sign-in happens in the provider's own page. Sportal never sees or stores provider credentials.
- Navigation in provider views is restricted to an allowlist of provider and sign-in domains.

### 3.3 Portability and network exposure

- All Hub configuration comes from the environment through Effect `Config`: bind address, storage address, provider keys, access token.
- The Hub keeps no state outside its data directory (`feed.sqlite`), so it can be stopped, moved, and restarted freely.
- Planned: on the home network the Hub requires a single shared access token, entered once per device. It is not built for the public internet: a cloud deployment additionally requires real authentication, which is deliberately left as a future decision record rather than half-built now.
- The Electron shell never moves to the cloud; Displays always run at home and point at wherever the Hub is.

## 4. Physical layout and module standard

This section is binding in the same way the type checker is. `AGENTS.md` carries the rules that are easiest to break.

### 4.1 Principles

1. **A boundary must earn its place.** A workspace package exists only when two or more apps need the same code. A folder exists only when a concept has several files that belong to it and nothing else. Nothing is created for symmetry, for future use, or to look like an architecture.
2. **One concept, one home.** Every type, schema, and function has exactly one obvious file. If you cannot say which concept a file owns in one noun, the file is wrong.
3. **Name files for what they own.** A module is a file named for its concept — `Game.ts`, `Stage.ts`, `Ingest.ts` — exporting that concept's schema or class. Operations on a domain type are methods and statics of its class (`game.progress()`, `GameSnapshot.watchOrder`, `stage.apply(command, …)`), not loose functions beside it. The tree reads as a table of contents of the domain, and each type reads as the list of what it can do.
4. **No junk drawers.** These file and folder names are banned by lint: `utils`, `helpers`, `common`, `shared`, `misc`, `lib`, `types`, `constants`, `models`, `interfaces`. A function that seems to belong in one belongs with the concept it operates on; if it operates on none, it is probably already in Effect.
5. **No barrels.** No `index.ts` re-export files. Packages expose modules through `package.json` `exports`; inside an app, import the module file directly.
6. **No mirror types.** There is no `GameDto`, `GameRow`, `GameResponse`, `GameProps`. The domain schema is the wire format and the stored format. A variant is derived from the original (`pick`, `omit`, `extend`) at the point of use and is not given a name unless it is itself a domain concept with a glossary entry.
7. **Search before you write.** Before adding a function, type, or file, look for the existing one. Duplicating logic that already exists is a defect even when the code works.
8. **Organize by concept, not by kind.** No top-level `components/`, `hooks/`, `services/`, `schemas/` folders. Code for the slate lives under `slate/`, whatever kind of code it is.
9. **Dependencies point one way.** `domain` imports only Effect. `api` imports `domain`. Apps import packages. Nothing imports an app. Within the Hub, only `HubMode.ts` knows which concrete providers and sources exist.

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
├── fixtures/scenarios/         Recorded scenarios: the raw frames of recorded game-day windows
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
│   │       ├── Game.ts         GameId, GameStatus, GameSnapshot, BallSpot, Network, Broadcast
│   │       ├── Situation.ts    Possession, down, distance, field position, red zone
│   │       ├── RecentPlays.ts  Each game's last ten plays, sent with the slate
│   │       ├── Play.ts         A single play, as the game's play-by-play lists it; PlayKind
│   │       ├── GameEvent.ts    GameEvent, stamped with its game and instant, and GameEventKind: state events from snapshot changes, play events from plays
│   │       ├── Delivery.ts     What a frame said: a listing, a snapshot, or a game's plays; DeliverySource
│   │       ├── LiveGame.ts     One game as the Hub follows it: LiveGame, LiveGameState; take and tick
│   │       ├── Slate.ts        The pure slate: every delivery taken in order, with the games it saw finish; Taken
│   │       ├── SlateObservation.ts  What one take or tick did to one game, for telemetry only
│   │       ├── Channel.ts      SourceName, Channel, ChannelAvailability
│   │       ├── Guide.ts        Guide, Airing, ChannelId, GuideUnreadable
│   │       ├── Stream.ts       StreamLocator
│   │       ├── Stage.ts        Tile, LayoutName, Split, Stage state, slot counts and split bounds, StageCommand, StageRejection, apply, invariants
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
    │       ├── HubMode.ts          What the Hub plays: the live day or a scenario; the only file that names providers and sources
    │       ├── HubConfig.ts        Every environment setting, in one place
    │       ├── Telemetry.ts        Log level and format; OTLP export when configured
    │       ├── Database.ts         The SQLite plumbing the feed log needs: a file or memory client layer, and migrations per store
    │       ├── LiveSlate.ts        The domain slate, run over the feed log: the day's replay, then each appended frame; its `Following`, timer, telemetry, game events, the live feed's demand, and the listed games it publishes with their recent plays
    │       ├── LiveSlateTelemetry.ts  What a take or tick did, as logs and metrics, told as the following stands
    │       ├── DecodeTelemetry.ts  What decode observed, as logs and metrics, for frames after the replay (moved here from `ingest/`)
    │       ├── corpus/             Typed game days built from the feed log or the archive, run through the slate on virtual time: `CorpusDay`, `CorpusInput`, `CorpusBuild`, `CorpusRun`, `Archive`, `Synthesis`, the `corpus` CLI and its worker
    │       ├── LiveStage.ts        The one authoritative Stage, held in memory
    │       ├── Ingest.ts           Polls HubConfig's leagues, runs the push on the slate's demand, appends every frame to the feed log, and waits on `through`
    │       ├── HubStopping.ts      Whether a task that should run until the Hub stops ended because it is stopping, and the Error log unless it did
    │       ├── FeedLog.ts          The append-only log of every frame, in feed.sqlite
    │       ├── Frame.ts            A feed frame as received, and the frame the log numbered
    │       ├── Gzip.ts             Frame bodies in and out of gzip
    │       ├── TestHubConfig.ts, TestTelemetry.ts   Layers for tests
    │       ├── TestFeedLog.ts      A test's frames logged through a feed log of their own, before what reads them opens it
    │       ├── TestLiveSlate.ts    The live slate following an in-memory feed log (`slateFollowing`), and what it takes of a test's frames
    │       ├── TestSnapshotFeed.ts The snapshot feed: a provider whose frames are our own deliveries, its decode, its wire shape, and the frames tests build of it; for tests only
    │       ├── hub-server/
    │       │   ├── HubServer.ts    Serves the API, the live stream, and the web UI's files
    │       │   └── LanAddresses.ts The addresses a phone on the home network can reach
    │       ├── provider/
    │       │   ├── Provider.ts     The port: poll, push, polling, reconnect; LiveFeed, LiveFeedDemand, Polling, Decoded, DecodeObservation, ProviderError
    │       │   ├── Decoder.ts      A provider's decode, and its only home; a layer of its own, paired with its provider by HubMode
    │       │   ├── TestDecoder.ts  What the provided `Decoder` says of a test's frames
    │       │   └── espn/
    │       │       ├── EspnProvider.ts     Implements the port: polls, pushes through the FastCast service, and its polling Schedule
    │       │       ├── EspnDecode.ts       Frames to deliveries: listings, snapshots, plays, resyncs
    │       │       ├── EspnEvent.ts        One game as either ESPN feed spells it, as a GameSnapshot
    │       │       ├── EspnPlay.ts         ESPN's plays and their type ids, as Play
    │       │       ├── FastCast.ts         ESPN's push, a service: the socket, as frames; its checkpoint retry is the schedule `FastCast.layer` builds it with
    │       │       ├── FastCastDocument.ts A topic's document, rebuilt from checkpoints and patches
    │       │       ├── FastCastMessage.ts  FastCast's wire shapes
    │       │       ├── TestEspn.ts         Recorded frames for tests of other modules, NE at BUF's day among them (`recordedNeAtBuf`)
    │       │       ├── TestEspnArchive.ts  ESPN's archive answered from recorded payloads, for the corpus's tests
    │       │       └── fixtures/           Recorded real payloads
    │       ├── source/
    │       │   ├── Source.ts       The port
    │       │   └── youtube-tv/
    │       │       ├── YouTubeTv.ts         Guide reading and availability
    │       │       ├── YouTubeTvPayload.ts  The guide response's wire shape
    │       │       ├── TestYouTubeTv.ts     A recorded guide for tests of other modules
    │       │       └── fixtures/            Recorded real payloads
    │       └── scenario/
    │           ├── Scenarios.ts        Every recording by name, and reading one back as a Scenario: a name and ESPN's frames
    │           ├── ScenarioProvider.ts A scenario as the provider: its frames polled, pushed, and polled again at their times
    │           ├── ScenarioClock.ts    Scenario time: the Hub's clock at HubConfig's scenario speed
    │           ├── ScenarioSource.ts   Every game carried on a synthetic stream page
    │           └── fixtures/           Recordings that are test data for the scenario tests, not scenarios to play
    │
    ├── web/
    │   └── src/
    │       ├── main.tsx
    │       ├── ScenarioStream.tsx  A scenario's synthetic stream page: a scorebug over the field
    │       ├── ScenarioStrip.tsx   The scorebug across the top of a scenario stream
    │       ├── theme.css           Desk and couch density themes
    │       ├── design/             Vendored shadcn primitives, under the CLI's own file names
    │       ├── display/            This device's Display: state and rules, hotkeys, full screen, overlays, top bar, command palette
    │       ├── hub/                HubClient (typed client from SportalApi), LiveStream (the live stream), HubRuntime
    │       ├── slate/              The slate strip and its cards
    │       ├── stage/              The Stage: tiles, dividers, tile actions, rejections
    │       ├── layout/             Layout (the geometry: slots, dividers, next, clamp), its picker and glyphs
    │       ├── game/               A game's status, score, and logo, as slate and tiles show them; the field, which draws a game's plays
    │       └── remote/             The phone Remote: stage map, join QR code
    │
    └── desktop/
        └── src/
            ├── main/
            │   ├── main.ts             App lifecycle: the shell's layers, and the window's IPC
            │   ├── ShellConfig.ts      Every setting the shell reads from its environment: the Hub's address
            │   ├── ShellWindow.ts      The shell's one window, confined to the Hub's origin
            │   ├── TileViews.ts        Creates, positions, tunes, and mutes provider views
            │   ├── Transition.ts       The arithmetic of a Stage transition
            │   ├── GuideReader.ts      Reads the source's guide with its own request
            │   ├── ProviderSession.ts  The persistent session and its permissions
            │   ├── Navigation.ts       Keeps a page on the addresses allowed
            │   ├── Sandbox.ts          What every window and view runs under
            │   └── YouTubeTv.ts        YouTube TV's sign-in address, hosts, and origin
            └── preload/
                └── ShellBridge.ts      Implements the shell bridge declared in packages/api
```

Tests sit beside the file they test as `Game.test.ts`. A module grows into a folder of the same name only when it genuinely has private parts, as `provider/espn/` does. Regenerate this tree from `git ls-files` when the layout changes.

**Not built:** domain `Follow.ts`, `Rule.ts`; hub `Dockerfile`, `provider/cfbd/`, `director/`, and the SQL stores for follows, presets, and rules; web `settings/` and a game's detail view. The Director, follows, presets, rules, the spoiler shield, and cloud hosting in the sections below are designs, not code.

### 4.3 Inside a file

The same standard applies within a file as across the tree: a file is not a junk drawer either. Someone opens `Ingest.ts` to read the ingest loop, and that is what they should see first.

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

Ports are Effect services; implementations are Layers; `HubMode` chooses them. Signatures are indicative.

**Provider** — game data in, as frames; and its **Decoder**, what those frames say:

```ts
class Provider extends Context.Service<Provider, {
  poll(league: LeagueId): Effect<FeedFrame, ProviderError>
  readonly push: LiveFeed
  readonly polling: Polling
  readonly reconnect: Schedule<unknown, ProviderError>   // how Ingest subscribes to the push again after it fails
}>()("sportal/hub/Provider") {}

type LiveFeed = (demand: Stream<LiveFeedDemand>) => Stream<FeedFrame, ProviderError>

type LiveFeedDemand = Games { games } | Resync { channel }   // what the push follows; a channel to checkpoint again

type Polling = Schedule<unknown, { slate: ReadonlyArray<GameSnapshot>; failed: ReadonlyArray<LeagueId> }>

class Decoder extends Context.Service<Decoder, {
  decode(frames: Stream<Frame>): Stream<Decoded>   // exactly one Decoded per frame
}>()("sportal/hub/Decoder") {}
```

- `poll` returns a league's scoreboard as received; the Hub logs it before anything decodes it. A provider's adapter provides its `Decoder` as a layer of its own, the only home of its decode, and `HubMode` pairs the two, so a recorded scenario decodes its frames as the provider that recorded them would. `decode` turns frames, polled or pushed, into exactly one `Decoded` per frame, carrying the frame's `seq` and receive time, its `Delivery`s (`Listing`, `Snapshot`, or `Plays`), the channels whose document had to be dropped (`resyncs`), and the `DecodeObservation`s decode made for telemetry. A frame that said nothing is a `Decoded` with three empty arrays. It never logs or counts. The snapshot feed (`TestSnapshotFeed.ts`) is the provider tests play: its frames are our own deliveries. Every scenario plays through ESPN's decode.
- `push` is the live feed: one element per frame, raw, on a `demand` stream (`LiveFeedDemand`: `Games`, the current games whenever which they are changes, and `Resync`, a channel to read again from its checkpoint). ESPN's FastCast implements it (`docs/adr/0007-fastcast-live-feed.md`), a service the ESPN provider yields, whose checkpoint retry is the schedule `FastCast.layer` builds it with, and subscribes to the scoreboard topics (the leagues from `HubConfig`) and to a `gp-` topic for each game in `Games`. `reconnect` is the Schedule Ingest subscribes to the push again on when it fails.
- `polling` is when to poll again, given the slate after the last poll and the leagues that failed. Ingest runs `poll` repeated on it, once the slate has taken the poll's last frame; the adapter owns the rules.
- Provider vocabulary stops at the folder edge. ESPN's "event", "competition", and "competitor" exist only in `EspnEvent.ts`, `FastCastMessage.ts`, and `EspnPlay.ts`.
- The Hub composes providers per league: ESPN for NFL; ESPN with CollegeFootballData filling gaps for FBS. The composition is itself a `Provider`, so Ingest sees one.
- Each adapter's tests are "this recorded frame decodes to this delivery".

**FeedLog** — every frame, raw, in the order the Hub received it (`docs/adr/0008-the-feed-log-is-the-truth.md`). Not a
port: one SQLite implementation over its own `feed.sqlite`:

```ts
class FeedLog extends Context.Service<FeedLog, {
  append(frame: FeedFrame): Effect<Frame>
  readonly subscribe: Effect<Stream<Frame>, never, Scope>
  replay(from: DateTime.Utc): Stream<Frame>
}>()("sportal/hub/FeedLog") {}
```

- An append numbers the frame and publishes it at once; one writer stores batches every 100 ms. Stored kinds are
  `response`, `message`, `checkpoint`, `unchanged` (a poll identical to its channel's last), and `gap` (frames a failed
  write lost).
- `replay(from)` starts each FastCast topic from its latest checkpoint before `from`: that checkpoint and the topic's
  frames after it come first, so a patch after `from` applies to the document it was sent against.
- On shutdown the writer stores what is still queued, for at most 1 s; a frame not stored by then is lost. The Hub's
  whole shutdown bound is about 5 s: the HTTP server's 3 s for connected Displays, then the feed log's 1 s, then
  telemetry's 1 s to export what it holds.

**LiveSlate** — the domain slate, run over the feed log, between decoding and everything that reads games. Not a port: one implementation
(`docs/adr/0009-one-fold-not-actors.md`, amended by `docs/adr/0010-the-poll-falls-back-and-corpus-days-are-built.md`):

```ts
class LiveSlate extends Context.Service<LiveSlate, {
  readonly latest: Effect<Slate>
  readonly changes: Stream<Slate>                    // seq or reached alone is not a change
  readonly events: Stream<GameEvent>
  readonly demand: Stream<LiveFeedDemand>            // what the live feed should follow: the current games, and each channel to resync
  readonly published: Effect<Published>              // the listed games and their recent plays, debounced 250 ms
  readonly publishedChanges: Stream<Published>
  through(seq: number): Effect<Slate>                // the slate once it has taken frame `seq`, or the latest once Halted
}>()("sportal/hub/LiveSlate") {}
```

- One fiber takes each delivery, in `seq` order, into the domain `Slate`: every current game's `LiveGame`, each league's
  last listing, and each game it saw finish. `take` and `tick` on it are pure and return the next slate, the game events
  it said, and its slate observations. A game's state is decided there alone: upcoming, live, holding, stale, or over.
  One timer wakes the slate when a game changes with no delivery, including a held snapshot's deadline.
- The slate's clock is each frame's receive time, so a replay of the log gives the same games and events as live did.
- It follows the feed log itself: from the game day's start (04:00 local) it replays the day quietly, with no per-game
  telemetry and no events, and its layer is built only then, so the Hub serves no slate still catching up. Then it takes
  each frame as it is appended, and its timer starts. Its `Following` is `Replaying`, `Live`, or `Halted` (a decode
  defect after the replay: no new frame is taken, but the slate keeps serving and its timer still runs and is told).
- `published` is each listed game as the slate has it, with each game's last ten plays (`recentPlays`, on `SlateChanged`),
  within 250 ms of a change; Ingest reads the slate for its polling, and `demand` names the games the live feed should
  follow.
- `HubMode` provides it in both modes. A scenario is the provider through the real Ingest, on the scenario clock: polled
  at each of its frames' times and at least every 10 seconds, its recorded live feed pushed at its recorded offsets, and
  every frame appended to a feed log of its own, in memory unless `SPORTAL_SCENARIO_FEED_LOG` names a file.

**Corpus** — typed game days for runs (`docs/adr/0010-the-poll-falls-back-and-corpus-days-are-built.md`). Not a
port. A day is a directory of `day.json` and two files of typed lines, `poll.ndjson` and `push.ndjson`, under
`HubConfig.corpusDir`, rebuilt when a decoder or the format changes and never migrated. `corpus build` makes a captured
day from the feed log and a backfilled day from the archive; `corpus backfill` fetches a date range of a provider's
finished games into the archive (`ArchivedGame`, `ArchivedPlay`) and builds its days; `corpus run` plays days through
the slate on virtual time, on worker threads, reading a subject's output over each take and tick. Each command exits
nonzero (`DaysFailed`) when a day fails. Backfill refuses a date that is not over, never overwrites a captured day, and
archives a 404 or 410 summary as refused so its game is skipped.

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

**Stores** — persistence. Each concept's store is a service over the `Database` module (SQLite; Postgres when cloud-hosted) and owns its migrations in its own table. The feed log is the only one today; follows, presets, and rules arrive with the Tracker. A Stage is not stored.

### 5.2 Ingest: frames, deliveries, and events

- Polling is an Effect `Schedule` on the provider's port, which its adapter declares; ESPN's polls about every 10 seconds while any game is live, every minute near kickoff, every 15 minutes otherwise. One slate request per league covers every game; detail is fetched only for games someone has open or on a Stage.
- A college Saturday is one request for 50+ games, not 50 requests.
- `LiveSlate` follows the feed log itself, so Ingest does not replay: from the game day's start (04:00 local) it replays the log quietly before the Hub serves. It subscribes to new frames first, then decodes the replay and every frame appended after as one stream, and decides where the replay ends by `seq` (the last frame logged when it started), not by a count or a timeout.
- Each poll response and each live-feed frame is appended to the feed log, raw, before anything decodes it. The provider's `Decoder` turns frames into deliveries; the slate takes them in `seq` order. A frame that will not decode is noted and says nothing; `LiveSlate` tells what decode observed only for frames after the replay. A decode defect after the replay halts the following. Ingest only polls, pushes, and appends, then waits for the slate to take a poll's last frame (`through`) before its polling Schedule reads the slate.
- The live feed pushes snapshots between polls, and, for each current game, its plays. A pushed game is advanced onto its listed game; one no poll has listed yet is counted and not delivered. The poll and the push have separate roles: the push gives a live game's snapshots and plays, and the poll gives listings. A game the push covers takes a poll snapshot only when it is ahead of the game (later in game time, halftime counting after play at the same clock, or at the same game time more total points, or at equal points a different split), and holds it for `fallbackAfter` (15 s) while the push can catch up; then the held snapshot applies and says its events (`sportal_poll_fallbacks`). A covered game ignores a poll behind it, and the slate remembers a game it saw finish, so a lagging poll cannot start it again; a snapshot later on the clock than the final, whatever its status, or at the same clock with more points, does (overtime after a spurious final, a postponed game resuming). There is no tie rule.
- A decoder reset (a missed message, a patch that will not apply) is a resync of that topic: the socket asks for its checkpoint again.
- Each event kind has one origin: state events come from snapshot changes and play events from plays (see `GameEvent`), including the leading signals the Director anticipates with, and events are never stored.
- The feed log is the truth (`docs/adr/0008-the-feed-log-is-the-truth.md`); the slate's games, plays, and events are all derived from it (and a corpus day is built from it or from the archive), and a restart or a missed poll cannot corrupt anything.
- Events are published on an in-process hub (`LiveSlate.events`); nothing reads it yet. The Director and client live streams will subscribe to it.

### 5.3 Stage

`stage.apply(command, availabilityOf)` is a pure method returning the new Stage or a typed rejection.

- State: a layout (`Single`, `Pair`, `Quad`, `MainThree`, `MainFive`), each layout's split, the tiles (each empty, stream, or data), audio focus, and solo. The first `Stage.slotCount(layout)` tiles are on stage, main tile first; the rest are the **bench**, kept in order and not played. Audio focus and solo name a game, so they follow it when tiles move.
- Commands: `Assign`, `Clear`, `Swap`, `Promote`, `SetLayout`, `SetSplit`, `Solo`, `Unsolo`, `FocusAudio`. `LoadPreset` comes with presets.
- Invariants, enforced only here: a game appears in at most one tile, on stage or benched; audio focus is an on-stage game (the focused one while it is on stage, else the first), or none on an empty stage; solo is an on-stage game; dividers stay within 0.2–0.8. Still to come: stream tiles per source across **all** Displays never exceed that source's budget, and an assignment beyond it becomes a data tile.
- Geometry: the web's `Layout#slots` gives each slot as fractions of the Stage area. The web UI turns them into pixels once and uses the same numbers for its tile chrome and the shell's tile placements, so the two move together along one **Stage transition** (280 ms, `cubic-bezier(0.2, 0, 0, 1)`), which the shell follows by moving each view's bounds.
- Full screen is the Display's window, local to it, and is not Stage state.

`LiveStage` in the Hub holds the one Stage in memory, applies commands from any origin, and broadcasts it. Nothing is persisted: a restart starts an empty Stage, and a second Display would need a keyed session.

### 5.4 Director

Designed in full in `docs/specs/2026-10-03-director-design.md`.

- What makes a game worth watching is still to be designed again: the first watchability score is gone, and the
  Director's rules read game events and plays.
- A **Trigger** is a condition over events and snapshots; a **Rule** binds a trigger to a stage command and a revert condition.
- The Director runs in the Hub, so it works with no client focused and affects every Display consistently.
- A manual command on a tile suppresses automation on that tile for a cooldown.

### 5.5 Time and the spoiler shield

- Time comes only from Effect's `Clock`. Tests use the test clock to replay a recorded game at any speed.
- Each stream tile has a tile delay. The Hub's live stream is immediate; the *client* holds back score data for that game by the delay, so different Displays can have different delays for the same game.

### 5.6 Failure behaviour

Expected failures are typed errors in the Effect error channel, each handled where it can be handled meaningfully.

| Failure | Behaviour |
| --- | --- |
| Provider unreachable or rate-limited | Keep serving the last snapshot, marked stale with its age; retry with backoff and jitter |
| Payload fails to decode | Save the payload to disk as a candidate fixture, skip that game, keep the rest |
| Stream view fails to load | Tile becomes a data tile with a retry action |
| Over budget | Assignment becomes a data tile; the UI says why |
| Client loses the Hub | UI shows disconnected and reconnects; provider views keep playing |
| Live feed refused, closed, silent, or out of step | Logged and counted by reason; resubscribed from a checkpoint with backoff from 1 s to 1 min; the poll carries on, so games go on updating at the poll's pace |
| A batch of frames fails to write | The Hub keeps following games; error log, `sportal_feed_write_failures`, and a `gap` row with the lost frames' count once writes recover |
| Applying a delivery dies | Error log with the frame's `seq` and game, `sportal_game_defects`; the game keeps its previous state; the slate carries on |
| Telemetry collector unreachable | One warning naming its URL; the exporters drop what they cannot send and the Hub carries on, and still stops within its shutdown bound |

## 6. Domain language

[`CONTEXT.md`](../CONTEXT.md) holds the glossary: built terms first, planned ones after. Every exported type name must be a term there.

## 7. Coding practices

[`AGENTS.md`](../AGENTS.md) holds the rules for how code is written, tested, and committed. Section 4 above says where code goes.

## 8. History

What shipped, in what order, the finished spikes, and the early decisions are in [`history.md`](./history.md). Old plans and designs are read from git, at the commit it names.
