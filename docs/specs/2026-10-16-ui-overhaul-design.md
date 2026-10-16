# UI overhaul

2026-10-16. From a brainstorm with mockups (`.superpowers/brainstorm/`). The web app's rules are loosened where they
fought React; the top bar goes; a TV-guide by league takes its place, in two themes; a Display can play YouTube
videos and playlists as custom tiles; a game gets a stats view, as a page and as a tile; finished games' highlights
play in a tile.

This is one unit of work, run start to finish by an agent without the user. Every decision is made here. Where this
spec and the code disagree on a name, the code's existing name wins unless this spec renames it.

Phases, each its own commit (or commits) on branch `ui-overhaul`, each ending with `pnpm check` green:

1. [Web rules](#1-web-rules)
2. [TileKey](#2-tilekey)
3. [Guide, themes, no top bar](#3-guide-themes-no-top-bar)
4. [Custom tile](#4-custom-tile)
5. [Hub summary](#5-hub-summary)
6. [Stats view](#6-stats-view)
7. [Highlights](#7-highlights)
8. [Docs and eye-check](#8-docs-and-eye-check)

Not in this unit: the Remote choosing from the guide, Hub-side persistence of custom streams, YouTube search, theme
variants of the Remote's own UI, full-game replays beyond YouTube playlists.

## 1. Web rules

`AGENTS.md` gains a section **"In the web app"**, after "How code is written", overriding the general rules for
`apps/web` only:

- **State.**
  - Atoms or Effects hold Hub data, the `Screen`, and any state an outside input writes or another view reads (Shell
    hotkeys, the Remote, the shell's provider views). The guide's level, league and focus are such state.
  - Plain React state (`useState`, `useReducer`, refs) holds what only a component's own DOM events touch: hover, a
    collapsed section, a text field's draft, scroll, animation.
  - A pure class with a fold (`Display.apply`) only when the logic has rules worth testing apart. Opening and closing
    something is not such logic.
  - Effect discipline (no bare promises, tagged errors, `Effect.fn`) is for code that does IO, not for UI-only code.
- **Props.** A component may declare its props as a non-exported `interface` directly above it, or inline them. Props
  take domain values; they never copy a domain type's fields.
- **Order.** A `.tsx` file may hold several components in the order that reads best. A component two files use moves
  to its own file.
- **Placement.** `apps/web/src/ui/` holds reusable, sport-agnostic presentational components (rails, shelves, cards'
  frames, stat blocks, the page frame). `ui` is allowed here despite the banned-names list. `design/` stays shadcn
  only. Everything else is by concept, as now.
- **Expressions.** Rules 9–11 of "Inside a file" and the "One spelling per kind" table apply to Effect code. JSX,
  handlers and render logic are exempt: inline ternaries, maps and handlers are fine.
- **Tests.** Pure logic with rules keeps tests beside it. Components and UI-only state need none. `TestWeb.ts` stays
  the one shared test module.

Everything else in `AGENTS.md` still holds for the web app.

## 2. TileKey

A tile can now show something that is not a game's stream, so tiles get an identity that is not only a `GameId`.

- `TileKey` (in `apps/web/src/screen/Screen.ts`, and in `packages/api/src/ShellBridge.ts` where the shell needs it;
  define it once in `packages/api` and import it in web) is a branded string:
  - a game's stream or data tile: the `GameId` itself;
  - a custom stream: `custom:<CustomStreamId>`;
  - a game's stats: `stats:<GameId>`;
  - a highlight clip: `clip:<HighlightId>`.
  Statics build each (`TileKey.game(id)`, `TileKey.custom(id)`, `TileKey.stats(id)`, `TileKey.clip(id)`).
- `Tile` gets `key(tile): TileKey | undefined` (undefined for `Empty`).
- Moved from `GameId` to `TileKey`, with no behaviour change: `Screen.audioFocus`, `Screen.solo`, `Screen.slotOf`, every
  `ScreenCommand` field naming an on-screen thing, `ShellBridge`'s `TilePlacement.game` (renamed `key`), `setHidden`,
  `onTilePressed`, `Shell.tilePressed`, `DisplayInput.VideoPressed`, `Display.interacting`, `Covering`,
  `TilePlacements`, `TileRects`, desktop `TileViews` (views keyed by `TileKey`), and the Remote's report and
  `ScreenMap`. `DisplayInput.Chosen({ game })` stays a game.
- Every existing test keeps its assertions under `TileKey`. The commit body lists rewritten test files as `AGENTS.md`
  asks.

## 3. Guide, themes, no top bar

### The Display

- `DisplayView` is one column: the Screen, and under it, while open, the ribbon. `TopBar.tsx` goes. `Brand.tsx` keeps
  only what the guide uses (`ConnectionPill`, `BrandMark` in the rail head); `LayoutPicker` moves into the rail foot.
- The ribbon is docked, never floating: the Screen's box shrinks to the space above it (about 25% of the height for
  the ribbon), and tile placements follow from the DOM as they do now. Provider views resize; none is hidden by the
  ribbon.
- The full guide covers the whole Display. Its root takes `useOverlayRef`, so Covering hides every video under it, as
  the palette does now.
- No bar, so status moves:
  - the count of live games shows on the rail's **All live** entry;
  - a lost Hub connection shows one persistent toast (sonner, `duration: Infinity`) until the connection is back,
    then dismisses it;
  - YouTube TV sign-in, layout, Remote, keys, full screen and the connection pill sit in the rail foot.
- The `Toaster` moves to the bottom center (no bar to sit in), offset above the ribbon when it is open.

### The guide

Two levels of one guide, by league.

- **Rail entries**, in order: All live, then every `LeagueId` in `League` order by `League.name` (NFL, College
  Football, MLB, NBA), then **Custom** (phase 4). All live lists every league's live games and nothing else.
- **Ribbon** (level 1): league tabs over one row of game chips: the league's live games, then upcoming, in
  `GameSnapshot.watchOrder`. Final games are not in the ribbon. A label at the right says which tile a pick goes to.
- **Full guide** (level 2): the rail at the left; at the right, shelves for the league: **Live now**, **Later
  today**, **Final**, and (phase 7) **Highlights**. Cards carry team logos (`TeamLogo`), scores, records or
  rankings, status, the situation's short line (down and distance, or count and outs), and the network.
- Data: the guide reads `Games.today` filtered by league in the web; no new RPC.
- Empty states: a league with no games today shows "No <league> games today" in the shelf area; All live with none
  shows "Nothing live right now".

### Guide state and keys

- `Overlay` gains `Guide({ level: "Ribbon" | "Full", entry: GuideEntry, focus: GuideFocus })` where `GuideEntry` is
  `"AllLive" | LeagueId | "Custom"` and `GuideFocus` is `{ shelf: number; item: number }` (the ribbon uses shelf 0).
  These names get `CONTEXT.md` rows (phase 8 at the latest; in the same commit if the check needs it).
- `Display.apply` handles them as pure steps:
  - `Guide` hotkey: None → Ribbon (entry: the last entry used, else All live); Ribbon → Full; Full → Full.
  - `Unsolo` (Escape): Full → Ribbon; Ribbon → None; otherwise as now.
  - `Move({ direction })`: in the Ribbon, left/right move the item, up opens Full; in Full, left on item 0 moves focus
    to the rail, up/down on the rail change the entry, right leaves the rail; up/down move between shelves, left/right
    within one. Focus clamps to what exists; the fold takes the counts it needs (shelf lengths) as an argument, so it
    stays pure.
  - `NextEntry` / `PreviousEntry` (`]` / `[`): change the entry at either level, focus to `{0, 0}`.
  - `Confirm` (Enter): on a game card or chip, the step is the existing `Chosen({ game })` path; on a custom card
    `ChosenCustom` (phase 4); on a highlight `ChosenClip` (phase 7). The guide closes after a choice.
  - `Info` (`I`): on a game card, opens `GamePage` (phase 6).
- `Hotkey` gains `Guide` (`KeyG`), `Move({ direction: "up" | "down" | "left" | "right" })`, `Confirm`,
  `NextEntry`, `PreviousEntry`, `Info`, each with its row in `Hotkey.keys` (group "Guide"). `Hotkey.of` takes a
  new `guideOpen: boolean` in its key argument: arrows, Enter, `[`, `]` and `I` map only when it is true. `G` maps
  always.
- The shell: `ShellBridge` gains `setGuideOpen(on: boolean)`; the desktop main keeps it and passes it to
  `Hotkey.of` in `TileViews`' `before-input-event`, so a player keeps its arrows unless the guide is open. The web's
  `Shell` gains `setGuideOpen`, called from an atom that follows whether the Display's overlay is a `Guide`. The
  browser layer reads the same flag for page keys.
- `KeysDialog` lists the new group from `Hotkey.keys`, unchanged in code.

### Themes

- Two themes: **Glass** (default) and **Team**. `theme.css` keeps the current tokens as the shared base and adds a
  block per theme under `:root[data-theme="glass"]` and `:root[data-theme="team"]`: surfaces, card radius,
  translucency and blur, focus treatment. Dark only, as now.
- `ui/Theme.ts`: the theme atom, read from and written to `localStorage` under `sportal.theme` (reads and writes
  wrapped; a failure or unknown value falls back to Glass). An effect sets `data-theme` on `document.documentElement`.
  `useTheme()` reads it.
- The rail foot has the theme switch.
- Structure per theme:
  - **Glass:** translucent cards, full team names, a thin edge in the two teams' colors, the focused card lifts and
    scales (1.04) with a shadow.
  - **Team:** a card split into two halves painted in each team's `color` (fallback: a neutral graphite), big logos
    and scores, a dark footer with status and network; focus is a white outline.
  - Team colors come from `Team.color` / `alternateColor`. When a team's color is too dark against the surface
    (relative luminance under 0.03), Team uses its `alternateColor`, else lightens the color.
- `game/GameCard.tsx` (the full guide's card) and `game/GameChip.tsx` (the ribbon's chip) each render a Glass and a
  Team variant from the same `GameSnapshot`. The tiles' chrome and the data-tile scoreboard take the theme's tokens;
  their structure stays.
- Motion: the ribbon slides up (150 ms), the full guide fades in (120 ms), focus moves animate (100 ms). Respect
  `prefers-reduced-motion`.

### Unchanged

The Ctrl+K palette, `Screen` commands, layouts, solo, audio focus, the Remote, and Covering's mechanism.

### Tests

- `Display` fold: one test per guide transition above (open, up a level, down a level, close, move in ribbon, move in
  full, rail, entry change, clamp, confirm on a game).
- `Hotkey.of`: arrows map only with `guideOpen`; `G` maps either way.
- `Theme`: an unknown or missing stored value reads as Glass.
- Desktop `TileViews`: arrows reach the player while the guide is closed and become hotkeys while it is open.

## 4. Custom tile

- `apps/web/src/custom/CustomStream.ts`: `CustomStream` is a `Schema.Class` with `id: CustomStreamId` (a branded
  string, a random UUID at creation), `name: string`, and `target`, a `Schema.TaggedUnion`: `Video({ videoId })` or
  `Playlist({ listId, videoId?: string })`.
  - `CustomStream.parse(url, name?)` reads `youtube.com/watch?v=`, `youtu.be/<id>`, `youtube.com/live/<id>`,
    `youtube.com/shorts/<id>`, `youtube.com/embed/<id>`, `youtube.com/playlist?list=`, and `watch?v=…&list=…`
    (a playlist starting at that video), with or without `www.`/`m.`. Anything else fails with `NotYouTube`
    (`Schema.TaggedError`). With no name, the name is "YouTube video" or "YouTube playlist" until renamed.
  - `watchUrl`: the shell's address: `https://www.youtube.com/watch?v=<id>` or
    `https://www.youtube.com/watch?list=<listId>[&v=<id>]`.
  - `embedUrl`: the browser's: `https://www.youtube.com/embed/<id>` or
    `https://www.youtube.com/embed/videoseries?list=<listId>`.
- `custom/CustomStreams.ts`: the list as an atom, stored in `localStorage` under `sportal.custom` (schema-decoded;
  a failed decode reads as empty), with add, rename and remove.
- `Tile` gains `CustomTile({ stream: CustomStreamId, name, locator: StreamLocator })`. The tile carries what the
  shell needs to load it, so placements need no lookup. `StreamLocator` stays `WebView({ url })`.
- `DisplayInput.ChosenCustom({ stream: CustomStream })` places it by the same rule as `Chosen`: a stream already on
  screen stays where it is; else the selected slot, or the next empty one.
- Removing a stream from the list also clears any tile showing it (one Screen command per tile).
- The shell loads a `CustomTile` as a provider view at `watchUrl`, unmodified. The plain browser shows an `<iframe>`
  at `embedUrl` in `TileBody` (`allow="autoplay; encrypted-media; picture-in-picture"`, `allowFullScreen`).
- Entry points: the palette's **Add YouTube…** (a field for the URL and one for the name, with the `NotYouTube`
  message inline); the guide's **Custom** entry, whose shelf lists saved streams and ends with an **+ Add** card that
  opens the same form; an × on a focused custom card, or the new `Remove` hotkey (`Delete`/`Backspace`, mapped
  only while the guide is open, group "Guide"), removes it.
- The Remote shows custom tiles by name in `ScreenMap` and can move, solo, audio-focus and clear them. It cannot add
  them.
- Tests: one `CustomStream.parse` test per URL form and one per rejection (a non-YouTube host, a YouTube URL with no
  id); `watchUrl` and `embedUrl` per target; `Screen`/`Display` placing, soloing, audio-focusing and clearing a custom
  tile; removing from the list clears its tiles; `TileViews` loads a custom tile's locator.

## 5. Hub summary

- `packages/domain/src/GameStats.ts`: `GameStats` (`Schema.Class`), sport-neutral:
  - `game: GameId`;
  - `linescore`: `{ home: ReadonlyArray<number>, away: ReadonlyArray<number> }`, points per period;
  - `teamStats`: `ReadonlyArray<{ label: string, home: string, away: string }>`, in ESPN's order and words;
  - `leaders`: `ReadonlyArray<{ category: string, side: "home" | "away", athlete: { name: string, headshot?: string }, line: string }>`;
  - `winProbability`: optional `ReadonlyArray<{ play: PlayId, home: number }>` (0–1);
  - `scoringPlays`: `ReadonlyArray<PlayId>`;
  - `highlights`: `ReadonlyArray<Highlight>` (phase 7 fills the web side; the decode lands here).
- `packages/domain/src/Highlight.ts`: `Highlight` (`Schema.Class`): `id: HighlightId` (branded), `game: GameId`,
  `headline`, `duration` (seconds), `video` (the HD mp4 href when present, else the plain one), `thumbnail?`.
- Hub: `apps/hub/src/provider/espn/EspnSummaryPayload.ts` (the wire spelling of the summary's `boxscore`,
  `leaders`, `winprobability`, `scoringPlays`, `videos`, `header` competitors for the linescore), and its decode into
  `GameStats` in the ESPN adapter (`EspnSummary.ts`, a namespace module), reached through `Espn.ts`.
  - The port gains `stats(game): Effect<GameStats, StatsUnavailable>`. `StatsUnavailable` is a `Schema.TaggedError`
    in `packages/api`.
  - A cache per game in the Hub, beside where the port is used (follow how the existing play pages are served). A
    final game's stats are fetched once and kept. A live game's are refetched every `HubConfig.statsRefresh`
    (`SPORTAL_STATS_REFRESH`, default 30 s) while any `statsLive` subscriber follows it, and not at all otherwise.
    Upcoming games answer with empty stats and no fetch.
- `HubApi` gains `stats({ id })` (one-shot), `statsLive({ id })` (stream), and `highlights({ league, date })`: the
  highlights of that day's final games of that league, fetching any uncached final game's summary with concurrency 4,
  each once per Hub run.
- Fixtures in `apps/hub/src/provider/espn/fixtures/`: replace the trimmed `nfl-summary-401872971.json` with the full
  summary of a finished NFL game, and add one finished FBS, one MLB and one NBA summary (`<league>-summary-<id>.json`),
  recorded with curl from `site.api.espn.com/apis/site/v2/sports/<sport>/<league>/summary?event=<id>`. If no finished
  NBA game is listed, use the latest finished one from the preseason or prior season by date. Keep any test that read
  the old trimmed file passing (it read `drives`, which the full file still has).
- Tests: decode per fixture (linescore, a team stat, a leader, win probability present or absent, scoring plays,
  highlights); a final game fetches once; a live game refetches on the test clock only while followed; an upcoming
  game makes no fetch; `highlights` fetches each final game once.

## 6. Stats view

- `stats/GameStats.tsx`: one view, `fit: "page" | "tile"`, reading `statsLive` for a live game and `stats` otherwise
  (`hub/` gains the atoms, as `Games.ts` does for games).
  - Sections, in priority order: header (logos, names, score, status), linescore, team stats (a two-sided bar per
    stat, numeric stats only get bars; text stats show as text), leaders, win probability (an inline SVG line over
    the game, 50% marked), scoring summary (the scoring plays' text, from the game's plays), highlights (phase 7).
  - In a tile, the view shows as many sections as fit, in that order, measured with a `ResizeObserver`; never a
    scrollbar in a tile. On a page, all sections, and the page scrolls.
  - Glass and Team variants, as the cards.
  - `StatsUnavailable` shows "Stats unavailable" with the header still drawn from the snapshot.
- Page: `Overlay` gains `GamePage({ game })`, full screen with `useOverlayRef`. It is opened by `Info` on a guide
  card and from the palette ("Stats: <scoreline>"). Escape closes it back to where it was opened from (the guide, at
  the same focus, or nothing).
- Tile: `Tile` gains `StatsTile({ game })`, keyed `stats:<game>`, placed from the palette ("Stats for <scoreline> in
  tile N") and by a tile action on a game tile, **Stats beside**: into the next empty slot, else the slot after the
  game's. It has no provider view and no audio.
- Tests: the tile-fit order (a pure function from available height and section heights to shown sections); `Screen`
  placing a stats tile next to its game's stream tile; Escape from a page returns to the guide's focus.

## 7. Highlights

- The game page's highlights section lists the game's highlights as thumbnails with headline and duration.
- The full guide has a **Highlights** shelf under Final for each league: `highlights({ league, date: today })`, then
  yesterday's appended, fetched when the shelf first shows.
- `Tile` gains `ClipTile({ highlight: Highlight })`, keyed `clip:<id>`, placed by `DisplayInput.ChosenClip` with
  `Chosen`'s rule. `TileBody` plays it in a page `<video>` (`autoplay`, `controls`, muted unless it has audio focus)
  with a **Replay** badge. No provider view. At the end it stays on its last frame. Clips are not kept anywhere.
- Audio focus mutes and unmutes the `<video>` as it does a stream.
- Tests: placing a clip; audio focus on a clip tile; the shelf's today-then-yesterday order (pure).

## 8. Docs and eye-check

- `CONTEXT.md`: rows for TileKey, Guide (ribbon, full guide, guide entry), Theme, CustomStream, CustomTile,
  GameStats, StatsTile, GamePage, Highlight, ClipTile; remove the top bar if named.
- `docs/technical-spec.md`: the Display section without the top bar, the guide, `setGuideOpen`, the new RPCs, the
  summary cache, and the trees.
- `docs/game-day-checklist.md` gains an **Eye-check: UI overhaul** list for the user, at minimum: both themes in the
  ribbon and the full guide; the ribbon docks and every video keeps playing in the shell; arrows reach a player with
  the guide closed; a YouTube video and a playlist play in the shell and in a browser; a stats page and a stats tile for
  a live game update; a highlight plays with audio focus; Ctrl+K still works; the Remote still moves a custom tile.

## Done

Every phase merged on `ui-overhaul` with `pnpm check` green, the branch's final review findings fixed, and the eye-check
list written. The branch is not merged to `main` without the user.
