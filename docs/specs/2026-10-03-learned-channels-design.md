# Learned Channels — Design

Date: 2026-10-03
Status: Approved 2026-10-03; revised the same day after review of its plan (naming, co-located domain logic, per-store migrations)
Follows: `docs/adr/0002-desktop-shell-playback.md` (decision: channels are learned, not mapped by hand)

## Goal

Clicking a game on the slate puts it on screen in the desktop shell, for any network YouTube TV
carries, without anyone editing a channel map. The first time a network is seen, its tile opens
YouTube TV's live guide; the user picks the channel once; the Hub remembers it across restarts and uses
it for every later game on that network.

This finishes phase 1's goal ("one click from slate to picture"), which the thin vertical slice built the
plumbing for but could not show, because the hand-filled channel map was empty.

## What the observation found

Run by hand on 2026-10-03 during live college games, in YouTube TV's live guide:

| Pick | Address |
| --- | --- |
| CBS (Navy–Air Force), "live" | `https://tv.youtube.com/watch/y6zFA17zDsw?vp=0gEEEgIwAQ%3D%3D` |
| CBS again, fresh pick | `https://tv.youtube.com/watch/y6zFA17zDsw?vp=0gEEEgIwAQ%3D%3D` |
| FOX (Michigan–Minnesota), "live" | `https://tv.youtube.com/watch/_MpmFlh-Wzc?vp=0gEEEgIwAQ%3D%3D` |
| FOX, "from the beginning" | `https://tv.youtube.com/watch/_MpmFlh-Wzc?vpp=gAKAzYTWBg%3D%3D&vp=0gEKEgIwARiAzYTWBg%3D%3D` |

- The same channel picked twice gives the same id; different channels give different ids.
- The query string chooses the start point. `vp=0gEEEgIwAQ==` is "live". "From the beginning" adds a
  protobuf varint holding the Unix time `1791043200` (2026-10-03 16:00 UTC, the noon kickoff slot), in
  both `vpp` and inside `vp`.
- Because "from the beginning" names an absolute start time, the id most likely identifies the channel's
  continuous stream rather than one programme. Confirmed 2026-10-03: an address learned earlier,
  opened after the programme on that channel changed, played the channel (CBS) live.

**Decided (2026-10-03): build per network.** A Channel is remembered per network and source. The check
above confirmed this key.

Only one thing changes between the two outcomes: the key of a remembered Channel (network and source,
or game, network, and source) and the lookup in `ChannelLineup.availabilityOf`. Everything else in this design is the
same either way.

## Decisions

| Question | Decision |
| --- | --- |
| Scope of this round | Learned channels only, with the deferred desktop-shell findings, because it reworks those files |
| Persistence | Introduce SQLite now: a `Database` module, and a `ChannelStore` that owns its own migrations. Tracker adds its own stores the same way |
| Where domain logic lives | On the domain types, as methods and statics of their classes. Existing logic (`Stage.apply`, `Game.isLive`, the slate's watch order) is converted first, and the rule goes into `AGENTS.md` |
| A game whose networks are all unknown | Its tile opens the live guide. Picking a channel teaches it; **Not on YouTube TV** records the network as not carried |
| A game with several networks | The tile works on one network at a time, in broadcast order, and names it. Not carried moves to the next unknown network; when none remain it is a data tile |
| Picked the wrong channel | A stream tile's **wrong channel** action forgets that network's Channel and reopens the guide |
| How a pick reaches the Hub | The shell reports the address a guide view lands on; the web UI turns it into a typed Hub command. The shell never talks to the Hub API |
| Learning in a plain browser | Not supported. The tile links to the guide and says picking works in the desktop app |
| Address stored | The channel's live address: `https://tv.youtube.com/watch/<id>?vp=0gEEEgIwAQ%3D%3D`. A stored "from the beginning" address would replay every later game from its kickoff |

## Design

### 1. Domain (`packages/domain`)

**Rule: operations on a domain type live on the type.** A method or static of its class
(`Schema.Class`, `Schema.TaggedClass`), or, for a union that never crosses the wire, the constructors of
its `Data.taggedEnum`. A domain module exports no loose functions over its types. This round writes the
rule into `AGENTS.md` and converts the existing logic before adding any:

- `Stage.apply(stage, …)` becomes `stage.apply(…)`, and `Stage.initial` a static of `Stage`.
- `Game.isLive(game)` becomes `game.isLive()`.
- `Slate.inWatchOrder` becomes the static `GameSnapshot.watchOrder`, an `Order<GameSnapshot>`. A slate
  is still a glossary term, but in code it is an array of snapshots, so `Slate.ts` is removed until it
  has a type to own (`SlateWindow`, in the Tracker).

**`Game.ts`** — gains `Network`, a branded string: a network's name as the provider reports it (`"CBS"`,
`"ESPN"`). `GameSnapshot.broadcasts` becomes `Array<Network>`. The ESPN adapter already produces these
names.

**`Source.ts`** (new) — the pure concepts of a video source. The Hub's `Source` port wraps them, as
`StageSessions` wraps `Stage`. There is no `Broadcast.ts`: no type in this design is a Broadcast.

- `SourceName` — a source as people know it (`"YouTube TV"`).
- `Channel` — `{ network, source, locator }`: a network as carried by a source.
- `ChannelCarriage` — whether a source carries a network: `Carried { channel }`, or
  `NotCarried { network, source }`.
- `ChannelLineup` — the carriages one source has learned, with its source name and its guide locator.
  - `availabilityOf(game)` — the game's `ChannelAvailability`.
  - `record(carriage)` — a new lineup, replacing any earlier carriage for the same network.
  - `forget(network)` — a new lineup without that network's carriage.
- `ChannelAvailability` — whether and where a source can show one game:
  - `Carried { channel }` — one of the game's networks has a Channel.
  - `Unlearned { network, source, guide }` — no network is carried, and this is the first of the game's
    networks with no carriage recorded. `guide` is the source's live-guide locator.
  - `NotCarried` — every one of the game's networks is recorded as not carried, or the game lists none.
- `ChannelUrlRefused` — an address a source would not learn, because it is not one of its live
  channels (HTTP 422).

A network with a Channel wins over an earlier network that is unlearned: a game on `ESPN` and
`Disney+` plays on ESPN as soon as ESPN is known, whatever is known about Disney+.

**`Stage.ts`**:

- `Tile` gains `PickingChannel { game, network, source, guide }`, and a `StreamTile` carries its whole
  `Channel`.
- `stage.apply(command, availabilityOf)` takes `availabilityOf: (game: GameId) => ChannelAvailability`
  instead of `locate`. `Assign` produces a `StreamTile` for `Carried`, a `PickingChannel` tile for
  `Unlearned`, and a `DataTile` for `NotCarried`. A game missing from the slate is `NotCarried`.
- `stage.refresh(availabilityOf)` — pure; re-resolves every non-empty tile. It runs whenever what the
  source knows changes, so learning ESPN turns every ESPN tile on every Display into a stream, marking a
  network not carried moves its tiles to their next network, and forgetting a Channel turns its stream
  tiles back into picking tiles. Audio focus is untouched.

### 2. Database and the channel store (`apps/hub/src`)

- **`database/Database.ts`** — the Hub's SQLite database: the client layer for
  `<SPORTAL_DATA_DIR>/sportal.sqlite`, and `migrate(store, migrations)`, which runs one store's
  migrations with Effect's `Migrator` and records them in that store's own table, `<store>_migrations`.
  Stores never share a migration numbering.
- **`source/ChannelStore.ts`** — the port, beside its only consumer:
  - `carriages: Effect<ReadonlyArray<ChannelCarriage>, ChannelStoreError>`
  - `record(carriage)`, `forget(network, source)`, each `Effect<void, ChannelStoreError>`.
- **`source/SqlChannelStore.ts`** — the port over `effect/sql`, driven by `@effect/sql-sqlite-node`
  4.0.0. It owns its migration (recorded in `channel_migrations`), which creates one table:
  `channel_carriage(network TEXT, source TEXT, carried INTEGER, url TEXT NULL, recorded_at TEXT, PRIMARY KEY (network, source))`.
  Every write is an upsert, so recording twice replaces the earlier carriage.
- `SPORTAL_DATA_DIR` defaults to `.sportal/` in the working directory. `*.sqlite` is already gitignored;
  `.sportal/` is added.
- **The driver risk is settled:** `@effect/sql-sqlite-node` 4.0.0 depends only on `effect` and runs on
  Node 24's built-in `node:sqlite`, so nothing native is installed.

### 3. Hub

- **`source/Source.ts`** — the port:
  - `lineup: Effect<ChannelLineup>` — what the source has learned so far.
  - `changes: Stream<void>` — emits after every change to the lineup.
  - `learn(network, url): Effect<void, ChannelUrlRefused | ChannelStoreError>`
  - `markNotCarried(network)`, `forget(network)`: `Effect<void, ChannelStoreError>`
- **`source/YouTubeTv.ts`**:
  - On start, it loads its carriages from the `ChannelStore` into a `SubscriptionRef<ChannelLineup>`.
  - Writes go to the store first and then to the ref, so a failed write changes nothing.
  - `LiveChannelUrl` — a schema that decodes `https://tv.youtube.com/watch/<id>` with any query into the
    address with only the live `vp`, and fails on anything else. `learn` decodes with it and maps a
    failure to `ChannelUrlRefused`.
  - The guide locator is `https://tv.youtube.com/live`.
  - `youtube-tv-channels.json` is deleted, which also settles the deferred "decode the channel map at
    boot" finding.
- **`stage/StageSessions.ts`** — builds `availabilityOf` from the current slate and the source's lineup,
  and subscribes to `Source.changes`. On each change it applies `stage.refresh` and publishes the new
  Stage through the existing live stream.
- **`main.ts`** — provides `Database.layer` with the configured data directory, and
  `SqlChannelStore.layer`.

### 4. API (`packages/api`)

A `channels` group on `SportalApi`. These are commands about what a source carries, not stage
commands: they affect every Display and every later game.

| Endpoint | Payload | Errors |
| --- | --- | --- |
| `POST /api/channels/learn` | `{ network, url }` | `ChannelUrlRefused` (422) |
| `POST /api/channels/not-carried` | `{ network }` | |
| `POST /api/channels/forget` | `{ network }` | |

There is one source today, so the source is not a parameter. It becomes one when a second source
arrives.

### 5. Desktop shell (`apps/desktop`)

**Bridge contract (`packages/api/src/ShellBridge.ts`)**

- `TilePlacement` gains `role: "stream" | "guide"`.
- `ShellBridge` gains `onChannelPicked(listener: (pick: { tile: number; url: string }) => void): () => void`,
  which returns an unsubscribe function. The preload forwards the `sportal:channel-picked` IPC message to
  registered listeners.

**`TileViews`**

- A view placed with `role: "guide"` listens to `did-navigate` and `did-navigate-in-page`. YouTube TV
  changes its address with `pushState`, so `will-navigate` does not fire. Each time the address becomes
  a new `https://tv.youtube.com/watch/…` address, the shell sends one `channel-picked` message for that
  tile, so a pick the Hub refused can be retried.
- The shell does not decode or judge the address; the Hub does. The shell still only sets each
  view's address, bounds, and mute flag. It reads the address the page navigated to and nothing else,
  which keeps ADR 0002's rule that provider pages are loaded unmodified.
- The guide view stays in place while the Hub decides. When the Hub accepts, the Stage changes, the tile
  becomes a stream tile, and the next placement replaces the guide with the channel's live address.

**Deferred findings taken here** (from the review of the Effect-native restructure)

- `main.ts`: launch the program last, after everything it uses is defined.
- `main.ts`: apply sync messages one at a time through a single queue instead of one fiber per message
  over a shared map.
- A window closed while the Hub page is loading is routine, not "the Hub could not be reached"; a view
  removed mid-load does not log a load error.
- `WidevineUnavailable` carries the underlying error as its cause.
- The shell window's and the provider views' navigation guards become one guard.
- Guard subframe navigations with `will-frame-navigate` in the shell window. Provider views do not
  guard subframes: their pages embed frames from hosts the allowlist does not name.

### 6. Web UI (`apps/web`)

- **`PickingChannel` tile, in the shell:** the guide fills the tile's video area. The footer reads
  "Pick the <network> channel" and offers **Not on YouTube TV**.
- **`PickingChannel` tile, in a plain browser:** the tile shows an "Open the guide" link and the line
  "Picking a channel works in the desktop app".
- **`StageView`** maps each `PickingChannel` tile to a `guide` placement. It subscribes to
  `onChannelPicked`, looks up that tile's network in the current Stage, and calls `channels.learn`. There
  is no optimistic state: the tile changes when the Hub's Stage does.
- **Stream tile:** gains a **wrong channel** action that calls `channels.forget`. Its browser link names
  the source instead of hard-coding YouTube TV (a deferred Reach finding).
- **Failures:** a failed learn (for example `ChannelUrlRefused` after the user opened a recording instead of a
  live channel) shows a short message on that tile and leaves the guide open. This covers the deferred
  "surface a rejected command" finding for this path only.

### 7. Language (`CONTEXT.md`)

New rows: **Network**, **Source name**, **Channel carriage**, **Channel lineup**, **Channel
availability** (replacing **Availability**), **Channel URL refused**, **Channel store**, **Channel store
error**, **Database**, **Live channel URL**, **Picking tile** (a tile showing the source's guide until
its network's Channel is known; `PickingChannel` in code), and **Channel pick**. The **Tile** row lists
the picking tile. The existing **Channel**, **Broadcast**, and **Slate** rows already fit. "Answer" is
not domain language.

## Testing

- **Domain, test-first.**
  - `GameSnapshot#isLive` and `GameSnapshot.watchOrder` (the watch-order test moves from `Slate.test.ts`).
  - `ChannelLineup#availabilityOf`: one network; several networks with each mix of carried, not carried,
    and unknown; all not carried; none listed. `record` replaces a network's carriage; `forget` keeps the
    others.
  - `stage.apply` for each availability.
  - `stage.refresh`: learning upgrades every matching tile; not carried advances to the next network;
    forgetting reverts stream tiles; empty tiles and audio focus are untouched.
  - The deferred Stage test gaps: the rejection reason, assign over an occupied tile, audio focus
    unchanged by assign and clear.
- **`YouTubeTv.LiveChannelUrl`:** the four recorded addresses above are the fixtures. The live and
  "from the beginning" FOX addresses decode to the same live address; `https://tv.youtube.com/live` and
  addresses on other hosts are refused.
- **`Database.migrate`:** two stores each run a migration numbered 1, each recorded in its own table;
  a migration runs once.
- **`SqlChannelStore`:** runs against a temporary SQLite file. Each write is visible on read; a second
  carriage for a network replaces the first; carriages survive a new layer over the same file.
- **`HubServer`:** assign a game on an unlearned network, then learn its channel, and see the Stage change
  on `GET /api/live`. This is also the deferred end-to-end live-stream test (framing, content type,
  current state first).
- **`TileViews`:** with the existing Electron mocks. A guide view reports once on an in-page navigation
  to `/watch/…`, does not report for the guide itself or a repeat of the address it just reported, and a
  stream view never reports.
- **By hand:** the game-day checklist's row 7 ("unmapped network") is replaced, and rows are added:

  | Do | Expect |
  | --- | --- |
  | Click a game on a network never seen before | The tile shows YouTube TV's live guide and names the network |
  | Pick the channel in that tile's guide | The tile plays it live within a few seconds |
  | Click another game on the same network | It plays immediately, with no guide |
  | Restart the Hub, then click a game on that network | It plays immediately, with no guide |
  | Click an ESPN+ game, press **Not on YouTube TV** | Data tile; the next ESPN+ game is a data tile at once |
  | On a playing tile, press **wrong channel** | The tile returns to the guide for that network |

## Out of scope

- The stream budget and what happens at the provider's concurrent-stream limit.
- Regional feeds. A learned CBS Channel is your local CBS, which may be showing a different regional game
  from the one you clicked. Recorded as a known limitation; the Tracker's availability work handles it.
- Learning in a plain browser.
- Everything listed for Tracker, Stage, Director, and Reach in the thin vertical slice plan, other than
  the deferred findings named above.
