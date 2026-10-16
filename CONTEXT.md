# Sportal — Domain Language

One word per concept, used identically in code, UI, documents, and conversation.
Every exported type name must be a term here, except the wire schemas in `*Payload.ts` and `FastCastMessage.ts`, which carry a provider's own vocabulary, and React components, which are named for what they show. Terms the code does not yet have are under [Planned](#planned).

### Competition

| Term | Meaning | Not |
| --- | --- | --- |
| **League** | An organized competition (NFL, FBS, MLB, NBA), and the sport it plays; `League` in code, `League.of`. | association, division |
| **Sport** | What a league plays: `football`, `baseball`, or `basketball`. It says which situation and play detail its games carry. | |
| **Team** | A league member. | club, competitor, franchise |
| **Ranking** | A team's position in a poll (college). | seed |
| **Team record** | A team's wins and losses this season, as the scoreboard gives them, ties left out: `TeamRecord`, `record` on a snapshot's side. | standing |
| **Odds** | A game's pregame betting line: the favored side, the spread in points, and the total expected; `Odds` on `GameSnapshot`. ESPN sends it only before the start. | line, betting |
| **Team colors** | The two colors a team plays in: `color` and `alternateColor` on `Team`, six hex digits without `#`, as ESPN sends them. The Hub reads them from the scoreboard; a team ESPN sends none for has neither. The web paints a team with `teamColor` (`apps/web/src/game/TeamColors.ts`): its alternate color, or its own lightened, when its own is too dark to see (relative luminance under 0.03); graphite when it has none. | |
| **Game** | One scheduled contest between two teams. As the slate holds it, `Game` (`packages/domain/src/Game.ts`): its latest snapshot and its plays, in sequence order. | event, match, competition, fixture |
| **Slate** | The domain `Slate` (`packages/domain/src/Slate.ts`): an ordered list of games: each league's last listing, leagues in `LeagueId` order, each game with its latest snapshot and its plays. `relisted` takes a league's listing and `playsTaken` a game's whole list of plays; the Director takes each frame's deliveries onto them in arrival order. A snapshot behind its game (earlier in game time, or at the same game time with fewer points) is ignored, except that an over game takes one ahead of its end (overtime after a spurious final, a postponed game resuming); plays of a game no listing names are dropped. Pure; each operation returns the next slate and its slate changes, or this one and none when nothing changed. Never sent to a client: the Schedule answers from it. | schedule, scoreboard, live games |
| **Director** | The Hub's `Director` service (`apps/hub/src/Director.ts`), the one holder of what is going on. From an empty slate it takes each frame's deliveries from its provider as they arrive, logs a take that raised a defect, and logs each play a take adds. It offers the slate to the Schedule as it is, then again each time a take changes it; it knows nothing of sources. For now nothing is kept between runs: a restarted Hub starts empty and the next poll fills it. | board, switcher, producer, autopilot, tracker, stage manager |
| **Slate change** | One thing a slate operation changed: a game's snapshot (`Progressed`, including a game newly listed), a game no listing names any more (`Delisted`), or a play a game did not have (`Played`); `SlateChange` in `packages/domain/src/Slate.ts`, given by `Slate#relisted` and `Slate#playsTaken` beside the next slate. The Director logs the plays among them. | diff, delta, event |
| **Start** | A game's scheduled start instant; `startsAt` on a snapshot. | kickoff, start time, date |

### Game state

| Term | Meaning | Not |
| --- | --- | --- |
| **GameStatus** | `scheduled`, `live`, `break` (any stop between periods, halftime included), `delayed`, `final`, `postponed`, `canceled`. | state, phase |
| **GameSnapshot** | The complete normalized state of a game at an instant. | update, payload |
| **Status text** | The provider's short status of a game ("Top 7th", "7:21 - 2nd"), shown as it is; `statusText`. | |
| **Game time** | How far a game has got: before the start, in play, or over; then the period; then the clock running down; then the situation's own order (baseball: the bottom half after the top, then outs); then, at the same clock, a break after play (any other statuses at the same clock tie). Orders two snapshots of one game. | timestamp, version |
| **Progress** | Where a game is in its day: `upcoming`, `live`, or `over`. A delay before the start is upcoming and a delay during the game is live. | phase, state |
| **Plays page** | A page of a game's plays, newest first, and whether earlier ones remain; `PlaysPage` in `packages/domain/src/Game.ts`, given by `Game#playsPage`. | |
| **Plays change** | What changed in a game's plays: plays added after the last it had (`Appended`) or a reset to its latest page (`Reset`) when one was revised or removed; `PlaysChange` in `packages/domain/src/Game.ts`, given by `Game#playsChange`. Each list is newest first. | |
| **Ahead** | One snapshot of a game past another: later in game time, or at the same game time with more points, or as many points split differently (`isAheadOf`). Ahead of a game's end (`isAheadOfOver`) is later on the clock whatever either's status, or at the same clock with more points. | newer |
| **Delivery** | `Delivery` in `apps/hub/src/provider/Provider.ts`, beside the port that gives it: what a frame said: a league's listing, or one game's whole list of plays. | input, update |
| **Test game** | A game snapshot built for a test, with defaults for everything the test does not care about. | fixture, mock |
| **Situation** | A live game's state, by sport: `FootballSituation` (possession, down, distance, field position, red zone, timeouts) or `BaseballSituation` (half inning, outs, count, runners). | context |
| **Football situation** | Live football state: possession, down, distance, field position, red zone (the 20 and in), timeouts. | |
| **Baseball situation** | Live baseball state: the half inning, outs, balls and strikes, and the runners on base. | |
| **Ball spot** | Where a spot is on the field: yards from the home goal line (0–100) and the way its team is going, from a team and its yards to the goal it attacks. | |
| **Period** | A quarter, an overtime, or an inning. | quarter (in code) |
| **Play** | One play in any sport, as a game's play-by-play lists it: its sequence, period, clock, text, the feed's type, scoring, the score after it, its team, and its sport's detail (`Play#offense` is the team with the ball; summary plays carry no team, so `offense()` reads the start spot). | |
| **Play detail** | What a play adds for its sport: `FootballDetail` (its kind, yards, and spots), `BaseballDetail` (outs and count), `BasketballDetail` (nothing yet). | |
| **Football kind** | How a football play moved the ball, as the field draws it: run, pass, incomplete, sack, kick, penalty, or other; `FootballKind` in code. | play type, outcome |
| **Football detail** | A football play's football kind, the yards it gained, and where it started and ended; `FootballDetail` in code. | football play |
| **Baseball detail** | A baseball play's outs and count after it; `BaseballDetail` in code. | |
| **Basketball detail** | A basketball play's detail: none yet; `BasketballDetail` in code. | |
| **Game id** / **Team id** / **League id** | A provider's own id for a game or a team, and a league's (`nfl`, `fbs`, `mlb` or `nba`); `GameId`, `TeamId`, `LeagueId` in code. | |
| **Play id** | The feed's own id for one play; `PlayId` in code. Not ordered: plays are ordered by their sequence. | |

### Data and video

| Term | Meaning | Not |
| --- | --- | --- |
| **Provider** | An adapter that supplies **game data** (ESPN, CollegeFootballData) and runs itself: it decides when to poll, what its push follows, and when to reconnect, and reads each frame it receives with its own decode; `deliveries` is what each frame said, one array per frame, in the order received. It also answers on request: `listing` a day's games in every league it serves, and `plays` a game's plays so far. | source, feed |
| **Provider unavailable** | The provider could not be followed or asked: FastCast refused, closed, or went silent, or a request for a listing or plays went unanswered; `ProviderUnavailable` in code, in `apps/hub/src/provider/Provider.ts`. FastCast's is logged with its reason, and the socket opens again on its backoff; the poll goes on. | provider error, live feed error |
| **Live feed** | A provider's push: the connection carrying updates for live games between polls (ESPN FastCast). | socket, stream, webhook |
| **FastCast** | ESPN's live feed, as the ESPN provider's push: one socket following the wanted topics the ESPN provider names, giving the socket as frames through `follow`, reconnecting itself; it never fails. | |
| **Provider feed** | How a test drives a provider: `TestHub.offered` offers one frame saying the test's own delivery, returning once the provider's reader has taken it, and ending the queue ends its frames; `Provider.layerTest`, with `TestHub.Frames`. | snapshot feed |
| **Game topics** | Each followed FastCast game topic's document and the plays decoded from it, each frame folded in once; `GameTopics` in `apps/hub/src/provider/espn/GameTopics.ts`. A topic's document is rebuilt from its checkpoint and the patches after it: waiting for its checkpoint, or synced as of a message; a missed message, a patch that will not apply, or one that does not decode sends it back to waiting. Its `take` gives each frame's `Plays`; its `retainedFor` keeps only the topics still wanted. | decoder state, cache, ESPN state, topic documents, document change |
| **Wanted topics** | What the live feed is told to follow: the topic of each listed game live or within 30 minutes of its start, each with whether its document is synced or waits for its checkpoint; `Wanted` in code, beside `FastCast`, which the ESPN provider gives from each league's last good listing and the game topics, with `Topic.wantedAt` naming the topics. FastCast subscribes to each newly wanted topic and each whose document goes from synced back to waiting; a topic no longer wanted is not subscribed to again. | subscriptions, follows |
| **ESPN league** | A league ESPN serves the Hub: its scoreboard and summary path and its FastCast topic prefix; `EspnLeague` in code, `EspnLeague.followed`. | |
| **ESPN event** | The site scoreboard's event, read as a GameSnapshot (`EspnEvent` in code); a poll's events, read together, are its league's listing (`listingOf`, beside it). | payload, DTO |
| **Topic** | A live feed topic: one game's package, which carries its plays; `Topic` in code, beside `FastCast`, read from FastCast's `tc` once where it arrives (`Topic.fromTc`), and named for it by `tc()`. | subscription, owner, channel |
| **Checkpoint unread** | A live feed topic's checkpoint could not be loaded or did not decode; logged, and FastCast subscribes to the topic again after 30 s while it is still wanted, unless a later checkpoint of the topic, in the socket's order, succeeds first; `CheckpointUnread` in code. | checkpoint error |
| **Source** | A way you obtain **video** (YouTube TV, Twitch). | provider, service |
| **Source name** | A source as people know it ("YouTube TV"); how code and the UI name a source. | source id |
| **Broadcast** | The fact that a network is airing a game, on television or streaming only. | channel, stream |
| **Network** | A network's name as a provider reports it ("CBS", "ESPN"). | channel, station |
| **Channel** | A station as a source names it ("News 3", "ESPN2"), with the address that plays it live, and, for a channel that is one network's stream (Twitch's Prime Video), the network whose every broadcast it carries. | network |
| **Channel id** | A source's own id for one of its channels (YouTube TV's station id); `ChannelId` in code. | station id |
| **Channel availability** | Whether and where a source can show a game: carried (on a channel on the air, once the game has started), upcoming (before it starts, with the channel and begin when known), no guide (the source has no fresh guide to say), or not carried, with why. | availability |
| **No guide** | A source's availability for a game while it has no fresh guide: before the first read, and once the last is stale. | unknown |
| **Guide** | One reading of a source's listing of the channels this account gets, with their live addresses, and what each airs. Twitch's is a fixed lineup, never read. | schedule, EPG |
| **Airing** | One programme on a channel, with its begin and end. | listing, show |
| **Guide unreadable** | A guide response the source could not read. | |
| **Frame** | One thing FastCast delivered, as received, before its decode reads it: a socket text (`Pushed`, read once into its envelope, the JSON object with its op, or none when the text is not one; with its topic and mid when it frames as a known op naming them), or the checkpoint an `H` pointed to, decoded into its topic's document (`Checkpoint`, the whole document as of its mid); `Frame` in code. | message, payload, feed frame |
| **Live channel URL** | A source's address for a channel, reduced to the one that plays it live. | canonical URL |
| **Stream** | One playing instance of a game from a source. | feed, video |
| **StreamLocator** | What a Display must load to play a stream. | URL, link |

Provider and Source are the two words most likely to be swapped. Provider is always data; Source is always video.

### Devices

A client asks the Hub over the Hub socket: once (`list`), or live (`listLive`) for the answer and each change.

| Term | Meaning | Not |
| --- | --- | --- |
| **Hub** | The server process that owns all shared state. | backend, server |
| **Hub API** | The Hub's whole API, declared once as `HubApi` (`packages/api`): RPCs over one WebSocket per page, at `/api/socket`. The Hub serves it and every client derives its typed client from it. Its live queries (a games query, one game, a game's plays, a Display's inputs, a Remote's follow) are streams that send their current answer, then each change, while their client reads them; every other read and write is a request. | REST layer, SSE |
| **Hub config** | Every setting a Hub reads from its environment, decoded once at startup; `HubConfig` in code. | settings, env |
| **Hub mode** | What a Hub plays: the live day from its providers and sources. | profile |
| **Schedule** | What the games API answers, the Hub's `Schedule` service: a day's games, one game, and a game's plays, each once or live. Today is live from the Director's slate; another day is the provider's listing, held in memory (a past day until the Hub restarts, a later one for 10 minutes). | calendar, games service |
| **Listed game** | A game as a list or a tile shows it: its snapshot and its availability from every source, never its plays; `ListedGame`. | game summary |
| **Game list** | A day and its games, filtered and in watch order, as a games query answers; `GameList`. | games response |
| **Games query** | What a list of games asks for: a day, a list of leagues, a list of progress, and whether only carried games; `GamesQuery`, whose `answer` filters and orders. | filter |
| **Calendar date** | A day as `YYYY-MM-DD`, in the Hub's time zone; `CalendarDate` in code. | date |
| **Game not found** | No day the Hub holds lists a game with that id; `GameNotFound`, the error of the `game`, `plays`, `gameLive` and `playsLive` RPCs. | |
| **Schedule unavailable** | The provider could not be reached for a day, or a game's plays, the Hub does not hold; `ScheduleUnavailable`, the error of the games RPCs. | |
| **Remote message** | One update the Hub pushes to a Remote about its Display: its latest report (`Reported`, passed on unread) or `Offline`; `RemoteMessage`. | event |
| **Display message** | One update the Hub pushes to a Display on its input stream: that the Hub has registered it (`Registered`, first), then each input a Remote sent (`Sent`, passed on unread); `DisplayMessage`. | event |
| **Live stream** | A live query as a client reads it: answers, then changes, over the Hub socket. In the web UI, `LiveStream.of` folds one's elements into an atom of `Live`, the value so far and the socket's connection; `Games` holds one per query the views make. | event stream |
| **Connection** | Whether the Hub socket is up: connecting (never yet connected), connected, or lost (since an instant, reconnecting); `Connection` beside `HubSocket`. | online, status |
| **Hub client** | The web UI's requests and writes to the Hub, `HubClient` in code, over the Hub socket. It runs in the web UI's one runtime (`WebRuntime.ts`), beside the Shell. | API client, fetcher |
| **Hub socket** | The web UI's one WebSocket to the Hub, `HubSocket` in `apps/web/src/hub/HubSocket.ts`: it carries every request and live query a page makes, asks each live query again when it reconnects, and gives its connection. It runs in the web runtime beside the Hub client; `HubApiClient`, beside it, is the typed client of `HubApi`. | event source, stream |
| **Display** | A device running the shell and presenting a Screen. It owns its Screen (`apps/web/src/screen/DisplayScreen.ts`), kept in its browser. Its local state (selected tile, interacting tile, and the one open overlay) is the web UI's `Display`, held in the `DisplayState.display` atom. | screen, client, player |
| **Remote** | A phone's view and control of one Display, at /remote/<display id>: its layout and tiles, and today's games. It sends Remote inputs and follows the Display's Remote report through the Hub; it works only while the page is open. | controller |
| **Display id** | A Display's own id, made once and kept in its browser (`sportal/display-id`); a Remote names its Display by it. `DisplayId` in `packages/api`. | display name |
| **Displays** | The Hub's in-memory relay between each connected Display and its Remotes (`apps/hub/src/Displays.ts`): the Display's latest report and the inputs waiting for it, neither of which the Hub reads. A Display is connected while its input stream is open; when it closes, the Display and its report are forgotten. | registry, sessions |
| **Display offline** | The Hub's answer to a report or input for a Display that is not connected: `DisplayOffline`, the error of the `report` and `send` RPCs. | |
| **Remote report** | What a Display tells its Remotes through the Hub: its Screen; `RemoteReport` in `apps/web/src/remote/RemoteReport.ts`. Sent once the Hub has registered its input stream, and again on each change. | state, snapshot |
| **Remote input** | What a Remote sends a Display: a screen command, applied to its Screen, or a hotkey, routed as if pressed on the Display; `RemoteInput` in `apps/web/src/remote/RemoteInput.ts`. | command, event |
| **Remote link** | A Display's side of its Remotes (`apps/web/src/remote/RemoteLink.ts`): its input stream at the Hub, its reports, and the inputs it applies. | |
| **Followed** | The Display as a Remote sees it through the Hub: connecting (not heard from yet), offline, or as it last reported; `Followed` in `apps/web/src/remote/RemoteState.ts`. A report that does not decode reads as offline. | status |
| **Overlay** | The one overlay a Display has open — the key help, the command palette, Join Remote, or the guide (at its level, on its entry, with its focus) — or none; `Overlay` beside `Display` in `apps/web/src/display/Display.ts`. Local to the Display. | modal, popup |
| **Guide level** | Which level of a Display's guide is open: the **ribbon** (league tabs over one row of a league's live then upcoming games, docked under the Screen, which shrinks above it) or the **full guide** (over the whole Display: the rail of guide entries, whose foot holds the Display's controls, and the entry's shelves); `GuideLevel` beside `Display`. A Display's guide shows games by league; it is not a source's **Guide**. | menu, EPG |
| **Guide entry** | One entry of the guide's rail: All live, a league, or Custom; `GuideEntry` beside `Display`. The rail lists All live, then each league with a game today, in league order (`GuideShelves.entries`). The guide opens on the one last shown (`lastEntry`), or on All live once the rail no longer lists it. | tab, category |
| **Guide focus** | Where the open guide's focus is: on the rail, or on one item of one shelf; `GuideFocus` beside `Display`. Arrows move it, and every step clamps it to what the shelves hold. | cursor, selection |
| **Guide shelves** | What the guide shows: its entries, and for an entry at a level its rows of guide items from today's games (live now, later today, final, for a league in the full guide); `GuideShelves` in `apps/web/src/guide/GuideShelves.ts`, built by `guideShelves`, given to the Display's fold. | rows, lists |
| **Guide item** | One thing on a guide shelf: a game, for now; `GuideItem` in `apps/web/src/guide/GuideItem.ts`. | card, tile |
| **Theme** | How a Display's guide, cards and tile chrome look: Glass (translucent and blurred, full team names, a thin edge in the teams' colors; the default) or Team (cards split into the teams' colors, big logos and scores); `ThemeName` and the `theme` atom in `apps/web/src/ui/Theme.ts`, kept in the browser under `sportal.theme`, set on the page as `data-theme`. Dark only. | skin, mode |
| **Shell config** | Every setting the desktop shell reads from its environment: the Hub's address, and, when none is given, the embedded Hub it starts; `ShellConfig` in code. | settings, env |
| **Embedded Hub** | The Hub the desktop app ships with, bundled into one script beside the web UI's build, which the shell runs as a utility process for as long as it runs, unless `SPORTAL_HUB_URL` names a Hub already running; `EmbeddedHub` in `apps/desktop/src/main/EmbeddedHub.ts`. Its output goes to `hub.log` in the app's log folder. | bundled Hub, local server |
| **Shell window** | The shell's one window, showing the Hub's web UI, confined to the Hub's origin; `ShellWindow` in code. | main window, BrowserWindow |
| **Shell bridge** | The small interface the desktop shell exposes to the web UI; its IPC channel names are `ShellChannel`. | IPC, native API |
| **Full screen** | A Display's window filling its monitor with only the Screen: the window's state, not the Screen's, and local to the Display. | solo |
| **Hotkey** | A key Sportal acts on, wherever it was pressed: in the web UI or in a stream view with focus. The guide's keys (arrows, Enter, `[`, `]`, `I`) are read only while the guide is open; `G` always. | shortcut, keybind |
| **Provider session** | The shell's single persistent browser session shared by every provider view, with its navigation allowlist and permissions. | partition, profile |
| **Tile views** | The shell component that keeps one provider web view per stream tile, placed where the web UI says. While the web UI says the guide is open, a view's guide keys are hotkeys, not the player's. | view manager |
| **Tile bounds** | A rectangle in whole CSS pixels: a tile's within the Screen area, or a tile view's within the window; `TileBounds` in code. | rect, frame |
| **Guide reader** | What reads a source's guide. The shell's (`GuideReader` in the desktop app) fetches it with the source's own request, sent on the provider session. In the Hub, YouTube TV's source keeps the latest guide it decodes from what the shell fetched (a complete guide, stamped when read) and gives availability from it while it is fresh. | scraper, EPG fetcher |

### Viewing

| Term | Meaning | Not |
| --- | --- | --- |
| **Screen** | What a Display shows: its multi-view surface and its state (layout, split, tiles, bench, solo, audio focus); `Screen` in `apps/web/src/screen/Screen.ts`, owned by its Display; it chooses between sources: the most useful availability for a game, and a stream tile moves only when its own source carries it on another channel. Called the Stage until 2026-10-08. | stage, grid, multiview, wall |
| **Screen command** | An instruction to change a Screen: assign, clear, swap, promote, solo, change layout or split, or focus audio. Issued by people on a Display. | action, event |
| **Layout name** | A layout's own name, as the Screen and the layout picker name it; `LayoutName` in `Screen.ts`, beside each layout's slot count. | |
| **Screen rejection** | The reason a Display refused a screen command. | error |
| **Layout** | A named arrangement of tile slots whose dividers can be moved. The geometry is the web's: `Layout` in `apps/web/src/layout/Layout.ts` gives the slots, dividers, next layout, and clamped split. | grid, template |
| **Split** | Where a layout's dividers sit, as fractions of the Screen area; `Split` in `Screen.ts`, which keeps it within `Screen.splitBounds`. | ratio, sizes |
| **Tile** | One slot's content: a **stream tile**, a **data tile**, or empty. | pane, cell, window |
| **Tile key** | What a tile shows, as one string: a game's stream or data tile is the game's id. Audio focus, solo, the interacting tile, tile placements and the shell's provider views name a tile by it, so what a tile shows keeps them when it moves; `TileKey` in `packages/api/src/TileKey.ts`, and `Tile.key` gives a tile's. | tile id, slot id |
| **Main tile** | The largest slot of a layout. | hero, primary |
| **Bench** | The tiles a layout has no slot for, kept in order and not played. | queue, reserve |
| **Solo** | One on-screen game filling the whole Screen. | fullscreen, maximize |
| **Swap** | Exchange two tiles, on screen or benched. | move |
| **Audio focus** | The single game whose sound is on; it follows the game when tiles move. | active, unmuted |
| **Display input** | What a person did on a Display: a hotkey, a click on a tile or a video, a game chosen for the selected tile (`Chosen`), the guide opened, an entry or an item clicked in it, a screen command, or an overlay opened or closed; `DisplayInput` in `apps/web/src/display/Display.ts`. Written to the Display's atom (`DisplayState.display`), which applies it and sends its screen commands to the Screen. | action, event |
| **Slot** | A place in a layout: a rectangle as fractions of the Screen area; `Slot` in `apps/web/src/layout/Layout.ts`. | rect, cell |
| **Shell** | The web UI's edge to its window and the shell bridge: page and stream hotkeys, full screen, presses on a video, whether the guide is open (`setGuideOpen`), the guide the shell reads, and the calls that place and hide videos; `Shell` in `apps/web/src/shell/Shell.ts`, the one reader of `window.sportalShell`. | bridge, native |
| **Tile action** | One thing that can be done to an on-screen tile: hear it, promote it, solo or unsolo it, clear it; its label, hotkey, and the screen command it sends; `TileAction` in `apps/web/src/screen/TileAction.ts`. A host renders it as a button or a palette item. | button, control |
| **Field drawing** | Which plays a tile's field has drawn: settled after a play, or animating one with the newest few queued; `FieldDrawing` in `apps/web/src/game/FieldDrawing.ts`, moved by `FieldEvent`s (plays arrived, a play drawn). | animation state |
| **Field event** | What a field's drawing hears: plays arrived from the Hub, or a play finished drawing; `FieldEvent` beside `FieldDrawing`. | |
| **Display step** | A Display after an input, and the screen commands that input sends; `DisplayStep` in code. | result, update |
| **Interacting tile** | The one stream tile whose player gets the mouse, after `I`; every other stream tile's player never sees the pointer. Local to the Display, like the selected tile. | active, unlocked |
| **Promote** | Move a game into the main tile. | feature |
| **Tile placement** | Where a game's stream tile sits in a Display's window, what it loads, and whether it is muted or interactive, as told to the shell. | bounds, rect |
| **Screen transition** | How tiles move to new places: one duration and easing, shared by the web UI and the shell. | animation |

## Planned

Names the design uses that no code has yet. Move a row up, into its table, in the commit that builds it.

| Term | Meaning | Not |
| --- | --- | --- |
| **Sport** | A kind of game (football). | |
| **Conference** | A grouping of teams within a league (SEC, AFC). | |
| **Season** | One league year, with a **SeasonPhase**: preseason, regular, postseason. | |
| **Drive** | A possession sequence. | |
| **GameDetail** | A snapshot plus drives, plays, and statistics. | summary |
| **StreamBudget** | How many concurrent streams a source allows. | limit, cap |
| **Desk mode** / **Couch mode** | The two presentation densities. | desktop/TV layout |
| **Preset** | A saved layout with tile assignments. | |
| **Tile delay** | Seconds that data is held back for a tile to match its video. | offset, latency |
| **Scenario** | A game day a Hub plays offline in place of its providers and sources. Removed to be designed again ([ADR 0013](docs/adr/0013-scenarios-go.md)). | |
| **Spoiler shield** | Hiding or delaying scores for chosen games. | |
| **Autopilot** | A Display's follower of the games' ranking: puts the best game in the main tile and the sound on it, and fits the layout. Built once and removed for the first installable build, to be designed again ([ADR 0018](docs/adr/0018-autopilot-and-prompts-go.md)). | director, auto-switcher |
| **Prompt** | Asking whether to bring a game on no tile into the main tile when it reaches a red zone or crunch time. Removed with the autopilot ([ADR 0018](docs/adr/0018-autopilot-and-prompts-go.md)). | notification, alert, suggestion, toast |
| **Phone push** | A prompt delivered to a phone's lock screen; needs HTTPS (Tailscale or the home box), so the Remote cannot do it over the home network's plain HTTP. | notification |
| **Follow** | Your declared interest in a team, conference, league, or game. | favourite, subscription |
| **Persistence** | What the Hub keeps between runs: none for now, added back on top of the simplified model. | storage, database |
| **Ticket** | A bet you have placed, tracked by the betting lens (later). | bet, wager |
