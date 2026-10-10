# Sportal — Domain Language

One word per concept, used identically in code, UI, documents, and conversation.
Every exported type name must be a term here, except the wire schemas in `*Payload.ts` and `FastCastMessage.ts`, which carry a provider's own vocabulary, and React components, which are named for what they show. Terms the code does not yet have are under [Planned](#planned).

### Competition

| Term | Meaning | Not |
| --- | --- | --- |
| **League** | An organized competition (NFL, FBS). | association, division |
| **Team** | A league member. | club, competitor, franchise |
| **Ranking** | A team's position in a poll (college). | seed |
| **Team record** | A team's wins and losses this season, as the scoreboard gives them, ties left out: `TeamRecord`, `record` on a snapshot's side. | standing |
| **Odds** | A game's pregame betting line: the favored side, the spread in points, and the total expected; `Odds` on `GameSnapshot`. ESPN sends it only before kickoff. | line, betting |
| **Team colors** | The two colors a team plays in: `color` and `alternateColor` on `Team`, six hex digits without `#`, as ESPN sends them. The Hub reads them from the scoreboard; a team ESPN sends none for has neither. | |
| **Game** | One scheduled contest between two teams. As the slate holds it, `Game` (`packages/domain/src/Game.ts`): its latest snapshot and its plays, in sequence order. | event, match, competition, fixture |
| **Slate** | The domain `Slate` (`packages/domain/src/Slate.ts`): an ordered list of games: each league's last listing, leagues in `LeagueId` order, each game with its latest snapshot and its plays. `relisted` takes a league's listing and `playsTaken` a game's whole list of plays; the Director takes each frame's deliveries onto them in arrival order. A snapshot behind its game (earlier in game time, or at the same game time with fewer points) is ignored, except that an over game takes one ahead of its end (overtime after a spurious final, a postponed game resuming); plays of a game no listing names are dropped. Pure; each operation returns the next slate and its slate changes, or this one and none when nothing changed. | schedule, scoreboard, live games |
| **Director** | The Hub's `Director` service (`apps/hub/src/Director.ts`), the one holder of what is going on. From an empty slate it takes each frame's deliveries from its provider as they arrive, logs a take that raised a defect, gauges each listed game's progress and current dashboard values (`sportal_game_state`, status, scores, period, clock, kickoff, and accepted-at gauges), drops every series when the game is delisted, and logs each play a take adds. It offers the slate as it is, then again each time a take changes it; it knows nothing of sources. It classifies the slate with its Classifier after each take and when a held moment runs out, logs each game's new moment, and offers the classifications beside the slate. For now nothing is kept between runs: a restarted Hub starts empty and the next poll fills it. | board, switcher, producer, autopilot, tracker, stage manager |
| **Slate changed** | The live message that carries the slate, each game with its recent plays (`Slate#recent`), and each listed game's availability from every source by its id and its classification by its id, settled 250 ms after a change; `SlateChanged` in code, built by the Hub server's live route, not by the Slate; the live stream joins the Director's slate with the source's availability, and sends the current one, then one for each burst of slate changes once it settles and one when the 30-second availability recheck finds a change. | slate payload, snapshot, published |
| **Slate change** | One thing a slate operation changed: a game's snapshot (`Progressed`, including a game newly listed), a game no listing names any more (`Delisted`), or a play a game did not have (`Played`); `SlateChange` in `packages/domain/src/Slate.ts`, given by `Slate#relisted` and `Slate#playsTaken` beside the next slate. The Director gauges and logs from them. | diff, delta, event |
| **Kickoff** | A game's scheduled start instant. | start time, date |

### Game state

| Term | Meaning | Not |
| --- | --- | --- |
| **GameStatus** | `scheduled`, `live`, `halftime`, `delayed`, `final`, `postponed`, `canceled`. | state, phase |
| **GameSnapshot** | The complete normalized state of a game at an instant. | update, payload |
| **Game time** | How far a game has got: before kickoff, in play, or over; then the period; then the clock running down; then, at the same clock, halftime after play (any other statuses at the same clock tie). Orders two snapshots of one game. | timestamp, version |
| **Progress** | Where a game is in its day: `upcoming`, `live`, or `over`. A delay before kickoff is upcoming and a delay during the game is live. | phase, state |
| **Ahead** | One snapshot of a game past another: later in game time, or at the same game time with more points, or as many points split differently (`isAheadOf`). Ahead of a game's end (`isAheadOfOver`) is later on the clock whatever either's status, or at the same clock with more points. | newer |
| **Delivery** | `Delivery` in `apps/hub/src/provider/Provider.ts`, beside the port that gives it: what a frame said: a league's listing, or one game's whole list of plays. | input, update |
| **Test game** | A game snapshot built for a test, with defaults for everything the test does not care about. | fixture, mock |
| **Situation** | Live football state: possession, down, distance, field position, red zone (the 20 and in), timeouts. | context |
| **Ball spot** | Where a spot is on the field: yards from the home goal line (0–100) and the way its team is going, from a team and its yards to the goal it attacks. | |
| **Period** | A quarter or an overtime. | quarter (in code) |
| **Play** | The plays of every sport, as a game's play-by-play lists them; football's only, for now, so `Play` is `FootballPlay`. | |
| **Football play** | A single snap, kick, try, penalty, timeout, stoppage, or the end of a period, as the play-by-play lists it: its clock, text, score after, start and end, win probability, and the case its feed's play type says, with what that type says of it; `FootballPlay` in code. The cases: `Rush` and `Completion` (a touchdown or not), `Incompletion`, `Interception` (returned, for a touchdown, or not), `Sack` (the defense recovering a fumble or not), `Fumble` (recovered by its own side, the other, for a touchdown, or not said), `TwoPointTry` (passed or run), `Kickoff` (returned for a touchdown or not), `Punt` (returned, for a touchdown, or not), `FieldGoal` (good, missed, or blocked), `ExtraPoint` (good or not), `Safety`, and `Penalty`, each with the team with the ball and the yards gained; `Timeout`, with the team that called it when the feed marks one; `Stoppage` (an official timeout, the two-minute warning, the coin toss); `PeriodEnd` (of a period, the half, regulation, or the game); and `Other`, a play type no case knows, kept as the feed spells it. | play kind, play type |
| **Play outcome** | A football play's case and what its feed's play type says of it: its `_tag` and outcome fields, without what every play carries or what it gained, as `{ _tag: "Punt", return: "none" }`; `PlayOutcome` in code. | play type, play kind |
| **Big play** | A play worth a look by itself: a touchdown, a turnover, a sack, a kick returned past the receiving team's 45, or a run or catch of 25 yards or more; `FootballPlay.bigPlay` gives its `BigPlayKind`. | highlight |
| **Possession change** | A play after which the other team has the ball: a punt, a turnover, a field goal missed or blocked, or a fourth-down snap short of the line to gain; `FootballPlay.changesPossession`. | turnover |
| **Game id** / **Team id** / **League id** | A provider's own id for a game or a team, and a league's (`nfl` or `fbs`); `GameId`, `TeamId`, `LeagueId` in code. | |
| **Recent plays** | A game's last ten plays, in sequence order: what each game on `SlateChanged` carries (`Game#recent`, over the slate `Slate#recent`). | |
| **Play id** | The feed's own id for one play; `PlayId` in code. Not ordered: plays are ordered by their sequence. | |

### Data and video

| Term | Meaning | Not |
| --- | --- | --- |
| **Provider** | An adapter that supplies **game data** (ESPN, CollegeFootballData) and runs itself: it decides when to poll, what its push follows, and when to reconnect, and reads each frame it receives with its own decode; `deliveries` is what each frame said, one array per frame, in the order received. | source, feed |
| **Provider unavailable** | FastCast could not be followed: it refused, closed, or went silent; `ProviderUnavailable` in code, in `apps/hub/src/provider/espn/FastCast.ts`. Logged with its reason, and the socket opens again on its backoff; the poll goes on. | provider error, live feed error |
| **Live feed** | A provider's push: the connection carrying updates for live games between polls (ESPN FastCast). | socket, stream, webhook |
| **FastCast** | ESPN's live feed, as the ESPN provider's push: one socket following the wanted topics the ESPN provider names, giving the socket as frames through `follow`, reconnecting itself; it never fails. | |
| **Provider feed** | How a test drives a provider: `TestHub.offered` offers one frame saying the test's own delivery, returning once the provider's reader has taken it, and ending the queue ends its frames; `Provider.layerTest`, with `TestHub.Frames`. | snapshot feed |
| **Game topics** | Each followed FastCast game topic's document and the plays decoded from it, each frame folded in once; `GameTopics` in `apps/hub/src/provider/espn/GameTopics.ts`. A topic's document is rebuilt from its checkpoint and the patches after it: waiting for its checkpoint, or synced as of a message; a missed message, a patch that will not apply, or one that does not decode sends it back to waiting. Its `take` gives each frame's `Plays`; its `retainedFor` keeps only the topics still wanted. | decoder state, cache, ESPN state, topic documents, document change |
| **Wanted topics** | What the live feed is told to follow: the topic of each listed game live or within 30 minutes of kickoff, each with whether its document is synced or waits for its checkpoint; `Wanted` in code, beside `FastCast`, which the ESPN provider gives from each league's last good listing and the game topics, with `Topic.wantedAt` naming the topics. FastCast subscribes to each newly wanted topic and each whose document goes from synced back to waiting; a topic no longer wanted is not subscribed to again. | subscriptions, follows |
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

| Term | Meaning | Not |
| --- | --- | --- |
| **Hub** | The server process that owns all shared state. | backend, server |
| **Hub API** | The Hub's HTTP API, declared once as `SportalApi`: the Hub serves it and every client derives its typed client from it. | REST layer |
| **Hub config** | Every setting a Hub reads from its environment, decoded once at startup; `HubConfig` in code. | settings, env |
| **Hub mode** | What a Hub plays: the live day from its providers and sources. | profile |
| **Live message** | One update the Hub pushes to clients on the live stream: the slate changed, each game beside its availability and its classification; `LiveMessage`, and `LiveMessageJson` its JSON form. | event, notification |
| **Live stream** | The Hub's server-sent events at `/api/live` that carry live messages; in the web UI, the `LiveStream.live` atom holds what they said and the connection. | event stream, socket |
| **Connection** | Whether a client's live stream is up: connecting (never yet connected), connected, or lost (since an instant, retrying). | online, status |
| **Hub client** | The web UI's way to the Hub's API, `HubClient` in code. It runs in the web UI's one runtime (`WebRuntime.ts`), beside the Shell. | API client, fetcher |
| **Telemetry** | The traces, logs, and metrics the Hub exports for people to read in Grafana. | monitoring, observability stack |
| **Display** | A device running the shell and presenting a Screen. It owns its Screen (`apps/web/src/screen/DisplayScreen.ts`), kept in its browser. Its local state (selected tile, interacting tile, pick, slate drawer, and the one open overlay) is the web UI's `Display`, held in the `DisplayState.display` atom. | screen, client, player |
| **Overlay** | The one dialog a Display has open — the key help or the command palette — or none; `Overlay` beside `Display` in `apps/web/src/display/Display.ts`. Local to the Display. | modal, popup |
| **Shell config** | Every setting the desktop shell reads from its environment: the Hub's address; `ShellConfig` in code. | settings, env |
| **Shell window** | The shell's one window, showing the Hub's web UI, confined to the Hub's origin; `ShellWindow` in code. | main window, BrowserWindow |
| **Shell bridge** | The small interface the desktop shell exposes to the web UI; its IPC channel names are `ShellChannel`. | IPC, native API |
| **Full screen** | A Display's window filling its monitor with only the Screen: the window's state, not the Screen's, and local to the Display. | solo |
| **Hotkey** | A key Sportal acts on, wherever it was pressed: in the web UI or in a stream view with focus. | shortcut, keybind |
| **Provider session** | The shell's single persistent browser session shared by every provider view, with its navigation allowlist and permissions. | partition, profile |
| **Tile views** | The shell component that keeps one provider web view per stream tile, placed where the web UI says. | view manager |
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
| **Main tile** | The largest slot of a layout. | hero, primary |
| **Bench** | The tiles a layout has no slot for, kept in order and not played. | queue, reserve |
| **Pick** | The slate game a Display has stepped to with `[` `]`, ready to drop into the selected tile with Enter. Local to the Display, like the selected tile. | highlight, cursor |
| **Solo** | One on-screen game filling the whole Screen. | fullscreen, maximize |
| **Swap** | Exchange two tiles, on screen or benched. | move |
| **Audio focus** | The single game whose sound is on; it follows the game when tiles move. | active, unmuted |
| **Strip card** | One card in the slate strip: a benched game, or a slate game in its section (Bench, Live, Next, Final), the Live section ordered by classification score, highest first, each card with its moment badge, marked with its slot when it is on screen or its tile when benched; `StripCard` in code, its place a `Place` (Slot or Bench). | tile, slate item |
| **Display input** | What a person did on a Display: a hotkey, a click on a tile or a video, a slate card dropped, a screen command, or an overlay opened or closed; `DisplayInput` in `apps/web/src/display/Display.ts`. Written to the Display's atom (`DisplayState.display`), which applies it and sends its screen commands to the Screen. | action, event |
| **Slot** | A place in a layout: a rectangle as fractions of the Screen area; `Slot` in `apps/web/src/layout/Layout.ts`. | rect, cell |
| **Shell** | The web UI's edge to its window and the shell bridge: page and stream hotkeys, full screen, presses on a video, the guide the shell reads, and the calls that place and hide videos; `Shell` in `apps/web/src/shell/Shell.ts`, the one reader of `window.sportalShell`. | bridge, native |
| **Tile action** | One thing that can be done to an on-screen tile: hear it, promote it, solo or unsolo it, clear it; its label, hotkey, and the screen command it sends; `TileAction` in `apps/web/src/screen/TileAction.ts`. A host renders it as a button or a palette item. | button, control |
| **Field drawing** | Which plays a tile's field has drawn: settled after a play, or animating one with the newest few queued; `FieldDrawing` in `apps/web/src/game/FieldDrawing.ts`, moved by `FieldEvent`s (plays arrived, a play drawn). | animation state |
| **Field event** | What a field's drawing hears: plays arrived from the Hub, or a play finished drawing; `FieldEvent` beside `FieldDrawing`. | |
| **Display step** | A Display after an input, and the screen commands that input sends; `DisplayStep` in code. | result, update |
| **Interacting tile** | The one stream tile whose player gets the mouse, after `I`; every other stream tile's player never sees the pointer. Local to the Display, like the selected tile. | active, unlocked |
| **Promote** | Move a game into the main tile. | feature |
| **Tile placement** | Where a game's stream tile sits in a Display's window, what it loads, and whether it is muted or interactive, as told to the shell. | bounds, rect |
| **Screen transition** | How tiles move to new places: one duration and easing, shared by the web UI and the shell. | animation |

### Automation

| Term | Meaning | Not |
| --- | --- | --- |
| **Moment** | What kind of thing is happening in a game now — a big play, a break, a scoring threat (red zone), crunch time, live play, upcoming, or final — one per game, the highest in precedence of those that hold, in that order; `Moment` in `packages/domain/src/Moment.ts`. | event, state |
| **Break** | A live game stopped: halftime, a delay, the end of a period, the two-minute warning, a timeout, a review or an injury its latest play names, the gap from a score to the next kickoff, the kickoff after a score (the double dip), a possession change, or a stall; the `Break` moment, with its `BreakReason`, when it is likely back (`expectedEnd`, from the reason's typical length), and what was at stake when it stopped (`during`). Inferred from the data, never the video. | commercial, lull |
| **Stall** | A live game in play that has not moved for 90 s, by when the Hub sees it: no new play, and the same status, period, clock and score; a break of last resort. | lull |
| **Double dip** | The break after the kickoff that follows a score, the second of the two the score brings. | |
| **Classification** | A game's moment, since when, and its score 0–100 with the points each part gave it; `Classification` in `packages/domain/src/Classification.ts`. | rating, watchability |
| **Matchup prior** | What a game promises before it starts: the mean of how close its line is, how highly its teams are ranked, and how often they have won. It fades as the game is played. | |
| **Classifier** | The pure fold that classifies the slate's games, stepped by the Director after each take and when a held moment runs out; it keeps each game's pregame line, its big play for a minute, when each game last moved (its stall clock), and its moment, which holds 20 s before a lower one replaces it. `Classifier` in `packages/domain/src/Classifier.ts`. | analyzer, scorer |
| **Autopilot** | A Display's follower of the classifications: shows the best game by its ranking in the main tile, the sound on it, and fits the layout under the ceiling. Off by default; your commands win. | director, auto-switcher |
| **Ranking** | The autopilot's order of games: a red zone, crunch time, a big play, live play, a break, not live; then score, then tile. | priority |
| **Dwell** | The 30 s the main tile's game holds the tile against a game in a higher rank, unless it stops. | hold |
| **Suspension** | The 3 min a command you send keeps the autopilot off the main tile, the sound or the layout it touched. | pause, lock |
| **Ceiling** | The layout you chose (when you turn the autopilot on, and each one you set): the autopilot fits the layout down from it as games end and back up to it as they start, never past. | max layout |
| **Fit** | The autopilot's choice of layout and tile order: the smallest layout on the ceiling's ladder with a slot for the main tile and each other game in progress or just over. | auto-layout |

## Planned

Names the design uses that no code has yet. Move a row up, into its table, in the commit that builds it.

| Term | Meaning | Not |
| --- | --- | --- |
| **Remote** | A client controlling a Display's Screen without presenting it. | controller |
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
| **Follow** | Your declared interest in a team, conference, league, or game. | favourite, subscription |
| **Persistence** | What the Hub keeps between runs: none for now, added back on top of the simplified model. | storage, database |
| **Ticket** | A bet you have placed, tracked by the betting lens (later). | bet, wager |
