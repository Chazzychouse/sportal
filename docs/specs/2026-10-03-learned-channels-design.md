# Learned Channels — Design

Date: 2026-10-03
Status: Draft for review
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
  continuous stream rather than one programme. This is not yet confirmed: it is confirmed when the same
  address, opened after the programme on that channel changes, plays the new programme live.

**Decided (2026-10-03): build per network.** A Channel is remembered per network and source. The check
above has not been run yet; if it shows the address names a programme, the key changes to game,
network, and source.

Only one thing changes between the two answers: the key of a remembered Channel (network and source,
or game, network, and source) and the lookup in `availability`. Everything else in this design is the
same either way.

## Decisions

| Question | Decision |
| --- | --- |
| Scope of this round | Learned channels only, with the deferred desktop-shell findings, because it reworks those files |
| Persistence | Introduce the `Store` port with SQLite now, holding only Channels; Tracker adds tables to it |
| A game whose networks are all unknown | Its tile opens the live guide. Picking a channel teaches it; **Not on YouTube TV** records the network as not carried |
| A game with several networks | The tile works on one network at a time, in broadcast order, and names it. Not carried moves to the next unknown network; when none remain it is a data tile |
| Picked the wrong channel | A stream tile's **wrong channel** action forgets that network's Channel and reopens the guide |
| How a pick reaches the Hub | The shell reports the address a guide view lands on; the web UI turns it into a typed Hub command. The shell never talks to the Hub API |
| Learning in a plain browser | Not supported. The tile links to the guide and says picking works in the desktop app |
| Address stored | The canonical live address: `https://tv.youtube.com/watch/<id>?vp=0gEEEgIwAQ%3D%3D`. A stored "from the beginning" address would replay every later game from its kickoff |

## Design

### 1. Domain (`packages/domain`)

**`Broadcast.ts`** (new; the technical spec's tree already places Broadcast, Channel, and Availability
here):

- `Network` — a branded string: a network's name as the provider reports it (`"CBS"`, `"ESPN"`).
- `Channel` — `{ network, source, locator }`: a network as carried by a source.
- `Availability` — whether and where a source can show one game:
  - `Carried { network, locator }` — one of the game's networks has a Channel.
  - `Unlearned { network, guide }` — no network is carried, and this is the first of the game's
    networks with no answer yet. `guide` is the source's live-guide locator.
  - `NotCarried` — every one of the game's networks is recorded as not carried, or the game lists none.

A network with a Channel wins over an earlier network that is unlearned: a game on `ESPN` and
`Disney+` plays on ESPN as soon as ESPN is known, whatever is known about Disney+.

**`Game.ts`** — `GameSnapshot.broadcasts` becomes `Array<Network>`. The ESPN adapter already produces
these names.

**`Stage.ts`**:

- `Tile` gains `PickingChannel { game, network, guide }`.
- `apply(stage, command, availability)` replaces the `locate` parameter with
  `availability: (game: GameId) => Availability`. `Assign` produces a `StreamTile` for `Carried`, a
  `PickingChannel` tile for `Unlearned`, and a `DataTile` for `NotCarried`. A game missing from the slate
  is `NotCarried`.
- `refresh(stage, availability)` — pure; re-resolves every non-empty tile. It runs whenever what the
  source knows changes, so learning ESPN turns every ESPN tile on every Display into a stream, marking a
  network not carried moves its tiles to their next network, and forgetting a Channel turns its stream
  tiles back into picking tiles. Audio focus is untouched.

### 2. Store (`apps/hub/src/store/`)

- **`Store.ts`** — the port. For now it covers Channel answers only:
  - `channelAnswers: Effect<ReadonlyArray<ChannelAnswer>, StoreError>`
  - `learn(network, source, locator)`, `markNotCarried(network, source)`, `forget(network, source)`,
    each `Effect<void, StoreError>`.
  - `ChannelAnswer` is a `Channel`, or a record that a network is not carried by a source.
- **`SqlStore.ts`** — the port over `effect/sql`, driven by `@effect/sql-sqlite-node` 4.0.0 with its
  `Migrator`. Migration 1 creates one table:
  `channel(network TEXT, source TEXT, carried INTEGER, url TEXT NULL, answered_at TEXT, PRIMARY KEY (network, source))`.
  Every write is an upsert, so answering twice replaces the earlier answer.
- The database file is `<SPORTAL_DATA_DIR>/sportal.sqlite`. `SPORTAL_DATA_DIR` defaults to `.sportal/` in
  the working directory. `*.sqlite` is already gitignored; `.sportal/` is added.
- **Risk, checked first in the plan:** `@effect/sql-sqlite-node` uses `better-sqlite3`, a native module,
  and pnpm 12 does not run install scripts for this workspace (the same problem Electron has). If its
  prebuilt binary does not load, the fallback is an `effect/sql` client over Node 24's built-in
  `node:sqlite`. The `Store` port does not change either way.

### 3. Hub

- **`source/Source.ts`** — the port grows to match the technical spec:
  - `availability(game: GameSnapshot): Availability`
  - `changes: Stream<void>` — emits after every change to what the source knows.
  - `learn(network, url): Effect<void, NotAChannel | StoreError>`
  - `markNotCarried(network)`, `forget(network)`: `Effect<void, StoreError>`
- **`source/YouTubeTv.ts`**:
  - On start, it loads its Channel answers from the `Store` into a `SubscriptionRef`.
  - Writes go to the `Store` first and then to the ref, so a failed write changes nothing.
  - `canonical(url)` — pure and exported for tests. It accepts `https://tv.youtube.com/watch/<id>` with
    any query, and returns the address with only the live `vp`. Anything else fails with
    `NotAChannel`.
  - The guide locator is `https://tv.youtube.com/live`.
  - `youtube-tv-channels.json` is deleted, which also settles the deferred "decode the channel map at
    boot" finding.
- **`stage/StageSessions.ts`** — builds `availability` from the current slate and `Source`, and
  subscribes to `Source.changes`. On each change it applies `Stage.refresh` and publishes the new Stage
  through the existing live stream.
- **`main.ts`** — provides `SqlStore.layer` with the configured data directory.

### 4. API (`packages/api`)

A `channels` group on `SportalApi`. These are commands about what a source carries, not stage
commands: they affect every Display and every later game.

| Endpoint | Payload | Errors |
| --- | --- | --- |
| `POST /api/channels/learn` | `{ network, url }` | `NotAChannel` (422) |
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
  changes its address with `pushState`, so `will-navigate` does not fire. When the address first becomes
  `https://tv.youtube.com/watch/…`, the shell sends one `channel-picked` message for that tile and stops
  reporting for that view.
- The shell does not canonicalise or judge the address; the Hub does. The shell still only sets each
  view's address, bounds, and mute flag. It reads the address the page navigated to and nothing else,
  which keeps ADR 0002's rule that provider pages are loaded unmodified.
- The guide view stays in place while the Hub decides. When the Hub accepts, the Stage changes, the tile
  becomes a stream tile, and the next placement replaces the guide with the canonical address.

**Deferred findings taken here** (from the review of the Effect-native restructure)

- `main.ts`: launch the program last, after everything it uses is defined.
- `main.ts`: apply sync messages one at a time through a single queue instead of one fiber per message
  over a shared map.
- A window closed while the Hub page is loading is routine, not "the Hub could not be reached"; a view
  removed mid-load does not log a load error.
- `WidevineUnavailable` carries the underlying error code.
- The shell window's and the provider views' navigation guards become one guard.
- Guard subframe navigations with `will-frame-navigate`.

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
- **Failures:** a failed learn (for example `NotAChannel` after the user opened a recording instead of a
  live channel) shows a short message on that tile and leaves the guide open. This covers the deferred
  "surface a rejected command" finding for this path only.

### 7. Language (`CONTEXT.md`)

New rows: **Network** (a network's name as a provider reports it), **Picking tile** (a tile showing the
source's guide until its network's Channel is known; `PickingChannel` in code), **Store** (the Hub's
persistence port), **Store error** (the store could not read or write), **Channel answer** (what is
known about a network on a source: carried with a Channel, or not carried), and **Not a channel** (an
address a source refused to learn because it is not one of its live channels). The **Tile** row lists the picking tile. The existing **Channel**,
**Availability**, and **Broadcast** rows already fit.

## Testing

- **Domain, test-first.**
  - `Availability` resolution: one network; several networks with each mix of carried, not carried, and
    unknown; all not carried; none listed.
  - `Stage.apply` for each availability.
  - `Stage.refresh`: learning upgrades every matching tile; not carried advances to the next network;
    forgetting reverts stream tiles; empty tiles and audio focus are untouched.
  - The deferred Stage test gaps: the rejection reason, assign over an occupied tile, audio focus
    unchanged by assign and clear.
- **`YouTubeTv.canonical`:** the four recorded addresses above are the fixtures. The live and
  "from the beginning" FOX addresses give the same canonical address; `https://tv.youtube.com/live` and
  addresses on other hosts are refused.
- **`SqlStore`:** runs against a temporary SQLite file with migrations applied. Each write is visible on
  read; a second answer replaces the first; answers survive a new layer over the same file.
- **`HubServer`:** assign a game on an unlearned network, then learn its channel, and see the Stage change
  on `GET /api/live`. This is also the deferred end-to-end live-stream test (framing, content type,
  current state first).
- **`TileViews`:** with the existing Electron mocks. A guide view reports once on an in-page navigation
  to `/watch/…`, does not report for the guide itself or a second navigation, and a stream view never
  reports.
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
