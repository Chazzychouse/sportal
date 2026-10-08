# Sportal — Domain Language

One word per concept, used identically in code, UI, documents, and conversation.
Every exported type name must be a term here, except the wire schemas in `*Payload.ts` and `FastCastMessage.ts`, which carry a provider's own vocabulary, and React components, which are named for what they show. Terms the code does not yet have are under [Planned](#planned).

### Competition

| Term | Meaning | Not |
| --- | --- | --- |
| **League** | An organized competition (NFL, FBS). | association, division |
| **Team** | A league member. | club, competitor, franchise |
| **Ranking** | A team's position in a poll (college). | seed |
| **Team colors** | The two colors a team plays in: `color` and `alternateColor` on `Team`, six hex digits without `#`, as ESPN sends them. The Hub reads them from the scoreboard; a team ESPN sends none for has neither. | |
| **Game** | One scheduled contest between two teams. | event, match, competition, fixture |
| **Slate** | The Hub's `Slate` (`apps/hub/src/slate/Slate.ts`): the games each league's last listing names, in its order, each as its latest snapshot, and each game's plays, taken from push and poll deliveries in arrival order. A snapshot behind its game (earlier in game time, or at the same game time with fewer points, as a poll lagging a pushed score) is ignored, except that an over game takes one ahead of its end (overtime after a spurious final, a postponed game resuming); a snapshot or plays of a game no listing names are dropped. Pure; `take` returns the next slate, or this one when nothing changed. | schedule, scoreboard, live games |
| **Board** | The Hub's `Board` service (`apps/hub/src/slate/Board.ts`), the one holder of the day's slate: from an empty slate, it takes each frame's deliveries from its provider as they arrive, logs a take that raised a defect, and offers the latest slate and each change. For now nothing is kept between runs: a restarted Hub starts empty and the next poll fills it. | live slate, slate service, tracker |
| **Slate changed** | The live message that carries the listed games as the slate has them and their recent plays, settled 250 ms after a change; `SlateChanged` in code, and what `Slate#published` builds; the live stream sends the current one, then one for each burst of the Board's changes once it settles. | slate payload, snapshot, published |
| **Kickoff** | A game's scheduled start instant. | start time, date |

### Game state

| Term | Meaning | Not |
| --- | --- | --- |
| **GameStatus** | `scheduled`, `live`, `halftime`, `delayed`, `final`, `postponed`, `canceled`. | state, phase |
| **GameSnapshot** | The complete normalized state of a game at an instant. | update, payload |
| **Game time** | How far a game has got: before kickoff, in play, or over; then the period; then the clock running down; then, at the same clock, halftime after play (any other statuses at the same clock tie). Orders two snapshots of one game. | timestamp, version |
| **Progress** | Where a game is in its day: `upcoming`, `live`, or `over`. A delay before kickoff is upcoming and a delay during the game is live. | phase, state |
| **Ahead** | One snapshot of a game past another: later in game time, or at the same game time with more points, or as many points split differently (`isAheadOf`). Ahead of a game's end (`isAheadOfOver`) is later on the clock whatever either's status, or at the same clock with more points. | newer |
| **Delivery** | `Delivery` in `apps/hub/src/slate/Delivery.ts`: what a frame said: a league's listing, one game's snapshot, or one game's whole list of plays. | input, update |
| **Delivery source** | Which way a provider delivered a frame: `push` or `poll`; a `Frame`'s `source` in code. | origin, feed type, feed |
| **Test game** | A game snapshot built for a test, with defaults for everything the test does not care about. | fixture, mock |
| **Scenario** | Games a Hub plays as its provider, through the real decode and slate: a name, when it starts (its first frame's receipt), and a stream of a provider's raw frames recorded over a window of a game day, kept as `fixtures/scenarios/<name>.frames.jsonl.gz`; `Scenario` in code. Every scenario plays through ESPN's decode, and only its recorded frames. | fixture, simulation, recorded scenario, slice |
| **Scenarios** | Every scenario there is, by name: the recordings in a folder, the committed ones in `fixtures/scenarios/` unless a test names another, and reading one back by name; `Scenarios` in code. | scenario store, catalogue |
| **Scenario unknown** | `SPORTAL_SCENARIO` names no recording; `ScenarioUnknown` in code, with the names there are. | |
| **Scenario unreadable** | A scenario's file could not be read as gzip'd frames; `ScenarioUnreadable` in code. | |
| **Scenario time** | The clock a scenario plays on: from the Hub's start, at the scenario's speed. The provider and the Board run on it. A scenario's frames are received at their offsets on it, but what they say, kickoffs among them, stays as recorded. | |
| **Situation** | Live football state: possession, down, distance, field position, red zone (the 20 and in), timeouts. | context |
| **Ball spot** | Where a spot is on the field: yards from the home goal line (0–100) and the way its team is going, from a team and its yards to the goal it attacks. | |
| **Period** | A quarter or an overtime. | quarter (in code) |
| **Play** | The plays of every sport, as a game's play-by-play lists them; football's only, for now, so `Play` is `FootballPlay`. | |
| **Football play** | A single snap, kick, try, penalty, timeout, stoppage, or the end of a period, as the play-by-play lists it: its clock, text, score after, start and end, win probability, and the case its feed's play type says, with what that type says of it; `FootballPlay` in code. The cases: `Rush` and `Completion` (a touchdown or not), `Incompletion`, `Interception` (returned, for a touchdown, or not), `Sack` (the defense recovering a fumble or not), `Fumble` (recovered by its own side, the other, for a touchdown, or not said), `TwoPointTry` (passed or run), `Kickoff` (returned for a touchdown or not), `Punt` (returned, for a touchdown, or not), `FieldGoal` (good, missed, or blocked), `ExtraPoint` (good or not), `Safety`, and `Penalty`, each with the team with the ball and the yards gained; `Timeout`, with the team that called it when the feed marks one; `Stoppage` (an official timeout, the two-minute warning, the coin toss); `PeriodEnd` (of a period, the half, regulation, or the game); and `Other`, a play type no case knows, kept as the feed spells it. | play kind, play type |
| **Play outcome** | A football play's case and what its feed's play type says of it: its `_tag` and outcome fields, without what every play carries or what it gained, as `{ _tag: "Punt", return: "none" }`; `PlayOutcome` in code. | play type, play kind |
| **Game id** / **Team id** / **League id** | A provider's own id for a game or a team, and a league's (`nfl` or `fbs`); `GameId`, `TeamId`, `LeagueId` in code. | |
| **Recent plays** | Each game's last ten plays, in sequence order, sent to the web with the slate; `RecentPlays` in code. A game with no plays is absent. | |
| **Play id** | The feed's own id for one play; `PlayId` in code. Not ordered: plays are ordered by their sequence. | |

### Data and video

| Term | Meaning | Not |
| --- | --- | --- |
| **Provider** | An adapter that supplies **game data** (ESPN, CollegeFootballData) and runs itself: it decides when to poll, what its push follows, and when to reconnect, and reads each frame it receives with its own decode; `deliveries` is what each frame said, one array per frame, in the order received. | source, feed |
| **Provider unavailable** | ESPN could not supply data: a poll of a league unreachable or refused, or FastCast refused, closed, or gone silent; `ProviderUnavailable` in code, in `espn/`. Logged and counted where it happens; the provider's frames go on. | provider error, fetch error, live feed error |
| **Live feed** | A provider's push: the connection carrying updates for live games between polls (ESPN FastCast). | socket, stream, webhook |
| **FastCast** | ESPN's live feed, as the ESPN provider's push: one socket following each league's scoreboard, and each game while that scoreboard shows it live or within 30 minutes of kickoff, following a topic again from its checkpoint when it loses its document and reconnecting itself; its `frames` never fail. | |
| **Snapshot feed** | A provider whose frames say our own deliveries, one per frame: what tests drive, in `TestSnapshotFeed.ts`. | |
| **ESPN event** | One game as either ESPN feed spells it, the polled site scoreboard or a FastCast scoreboard topic, read as a GameSnapshot; `EspnEvent` in code. | payload, DTO |
| **Topic owner** | What a live feed topic carries: one league's scoreboard, or one game's plays; `Owner` in code, in `FastCastTopic.ts`. | subscription |
| **Checkpoint unread** | A live feed topic's checkpoint could not be loaded or did not decode; retried on FastCast's checkpoint retry, then the topic is left to polling until the socket reconnects; `CheckpointUnread` in code. | checkpoint error |
| **Source** | A way you obtain **video** (YouTube TV). | provider, service |
| **Source name** | A source as people know it ("YouTube TV"); how code and the UI name a source. | source id |
| **Broadcast** | The fact that a network is airing a game, on television or streaming only. | channel, stream |
| **Network** | A network's name as a provider reports it ("CBS", "ESPN"). | channel, station |
| **Channel** | A station as a source names it ("News 3", "ESPN2"), with the address that plays it live. | network |
| **Channel id** | A source's own id for one of its channels (YouTube TV's station id); `ChannelId` in code. | station id |
| **Channel availability** | Whether and where a source can show a game: carried, upcoming, no guide (the source has no fresh guide to say), or not carried, with why. | availability |
| **No guide** | A source's answer while it has no fresh guide: before the first read, and once the last is stale. | unknown |
| **Guide** | One reading of a source's listing of the channels this account gets, with their live addresses, and what each airs. | schedule, EPG |
| **Airing** | One programme on a channel, with its begin and end. | listing, show |
| **Guide unreadable** | A guide response the source could not read. | |
| **Frame** | One thing a provider delivered, as received, before its decode reads it: its delivery source, its channel, its body, and whether it is the `whole` document or a `change` to one (a poll response and a pushed checkpoint are whole; a pushed message is a change), with the provider's own `number` for it when it has one; `Frame` in code. | message, payload, feed frame |
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
| **Hub mode** | What a Hub plays: the live day from its providers and sources, or a scenario in their place. | scenario mode, profile |
| **Live message** | One update the Hub pushes to clients on the live stream: the slate changed, or the Stage changed; `LiveMessage`, and `LiveMessageJson` its JSON form. | event, notification |
| **Live stream** | The Hub's server-sent events at `/api/live` that carry live messages; in the web UI, `LiveStream` holds what they said and the connection. | event stream, socket |
| **Connection** | Whether a client's live stream is up: connecting (never yet connected), connected, or lost (since an instant, retrying). | online, status |
| **Hub client** | The web UI's way to the Hub's API, `HubClient` in code: stage commands, and the stage commands that failed: refused by the Hub, or never reaching it. It runs in the web UI's one runtime (`HubRuntime.ts`), with the live stream. | API client, fetcher |
| **Switcher** | The Hub's `Switcher` service (`apps/hub/src/Switcher.ts`), holder of the one Stage, shared by every Display: applies stage commands one at a time and refreshes channel availability when the source changes. | live stage, stage store, stage manager, stage sessions |
| **Telemetry** | The traces, logs, and metrics the Hub exports for people to read in Grafana. | monitoring, observability stack |
| **Display** | A device running the shell and presenting a Stage. Its local state (selected tile, interacting tile, pick, slate drawer, and the one open overlay) is the web UI's `Display`. | screen, client, player |
| **Remote** | A client controlling a Display's Stage without presenting it. | controller |
| **Shell config** | Every setting the desktop shell reads from its environment: the Hub's address; `ShellConfig` in code. | settings, env |
| **Shell window** | The shell's one window, showing the Hub's web UI, confined to the Hub's origin; `ShellWindow` in code. | main window, BrowserWindow |
| **Shell bridge** | The small interface the desktop shell exposes to the web UI; its IPC channel names are `ShellChannel`. | IPC, native API |
| **Full screen** | A Display's window filling its monitor with only the Stage; local to the Display, not a Stage state. | solo |
| **Hotkey** | A key Sportal acts on, wherever it was pressed: in the web UI or in a stream view with focus. | shortcut, keybind |
| **Provider session** | The shell's single persistent browser session shared by every provider view, with its navigation allowlist and permissions. | partition, profile |
| **Tile views** | The shell component that keeps one provider web view per stream tile, placed where the web UI says. | view manager |
| **Tile bounds** | A tile view's rectangle in the web UI's window, in whole CSS pixels; `TileBounds` in code. | rect, frame |
| **Guide reader** | The shell component that reads a source's guide with the source's own guide request, sent on the provider session. | scraper, EPG fetcher |

### Viewing

| Term | Meaning | Not |
| --- | --- | --- |
| **Stage** | A Display's multi-view surface and its state. | grid, multiview, wall |
| **Stage command** | An instruction to change a Stage: assign, clear, swap, promote, solo, change layout or split, or focus audio. Issued by people and by the Producer alike. | action, event |
| **Layout name** | A layout's own name, as the Stage and the layout picker name it; `LayoutName` in `Stage.ts`, beside each layout's slot count. | |
| **Stage rejection** | The reason a stage command was refused. | error |
| **Layout** | A named arrangement of tile slots whose dividers can be moved. The geometry is the web's: `Layout` in `apps/web/src/layout/Layout.ts` gives the slots, dividers, next layout, and clamped split. | grid, template |
| **Split** | Where a layout's dividers sit, as fractions of the Stage area; `Split` in `Stage.ts`, which keeps it within `Stage.splitBounds`. | ratio, sizes |
| **Tile** | One slot's content: a **stream tile**, a **data tile**, or empty. | pane, cell, window |
| **Main tile** | The largest slot of a layout. | hero, primary |
| **Bench** | The tiles a layout has no slot for, kept in order and not played. | queue, reserve |
| **Pick** | The slate game a Display has stepped to with `[` `]`, ready to drop into the selected tile with Enter. Local to the Display, like the selected tile. | highlight, cursor |
| **Solo** | One on-stage game filling the whole Stage. | fullscreen, maximize |
| **Swap** | Exchange two tiles, on stage or benched. | move |
| **Audio focus** | The single game whose sound is on; it follows the game when tiles move. | active, unmuted |
| **Strip card** | One card in the slate strip: a benched game, or a slate game in its section (Bench, Live, Next, Final), marked with its slot when it is on stage or its tile when benched; `StripCard` in code, its place a `Place` (Slot or Bench). | tile, slate item |
| **Display step** | A Display after an input, and the stage commands that input sends; `DisplayStep` in code. | result, update |
| **Interacting tile** | The one stream tile whose player gets the mouse, after `I`; every other stream tile's player never sees the pointer. Local to the Display, like the selected tile. | active, unlocked |
| **Promote** | Move a game into the main tile. | feature |
| **Tile placement** | Where a game's stream tile sits in a Display's window, what it loads, and whether it is muted or interactive, as told to the shell. | bounds, rect |
| **Stage transition** | How tiles move to new places: one duration and easing, shared by the web UI and the shell. | animation |

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
| **Spoiler shield** | Hiding or delaying scores for chosen games. | |
| **Follow** | Your declared interest in a team, conference, league, or game. | favourite, subscription |
| **Persistence** | What the Hub keeps between runs: none for now, added back on top of the simplified model. | storage, database |
| **Game event** | Something that happened in a game (a score, a turnover, a play, a period ending), derived from a game's snapshot changes and plays. The code had it and dropped it while nothing read it; the Producer derives it again. | alert, update |
| **Trigger** | A condition over game events and snapshots. | |
| **Rule** | A trigger bound to a stage command and a revert condition. | automation |
| **Producer** | Planned. The Hub component that evaluates rules and issues stage commands: the Producer switches the Slate of games on the Board. | director, autopilot |
| **Alert** | A user-facing notification produced by a rule. | event |
| **Ticket** | A bet you have placed, tracked by the betting lens (later). | bet, wager |
