# Sportal — Domain Language

One word per concept, used identically in code, UI, documents, and conversation.
Every exported type name must be a term here, except the wire schemas in `*Payload.ts` and `FastCastMessage.ts`, which carry a provider's own vocabulary, and React components, which are named for what they show. Terms the code does not yet have are under [Planned](#planned).

### Competition

| Term | Meaning | Not |
| --- | --- | --- |
| **League** | An organized competition (NFL, FBS). | association, division |
| **Team** | A league member. | club, competitor, franchise |
| **Ranking** | A team's position in a poll (college). | seed |
| **Game** | One scheduled contest between two teams. | event, match, competition, fixture |
| **Slate** | The games in a time window (a Saturday, an NFL week). Shown as a strip under the Stage. The Hub's `Slate` publishes it: each listed game as the fold has it. | schedule, scoreboard |
| **Kickoff** | A game's scheduled start instant. | start time, date |

### Game state

| Term | Meaning | Not |
| --- | --- | --- |
| **GameStatus** | `scheduled`, `live`, `halftime`, `delayed`, `final`, `postponed`, `canceled`. | state, phase |
| **GameSnapshot** | The complete normalized state of a game at an instant. | update, payload |
| **Game time** | How far a game has got: before kickoff, in play, or over; then the period; then the clock running down. Orders two snapshots of one game. | timestamp, version |
| **Progress** | Where a game is in its day: `upcoming`, `live`, or `over`. A delay before kickoff is upcoming and a delay during the game is live. | phase, state |
| **Live game** | One game as the Hub follows it: its latest snapshot, the delivery source that gave it, its state (`LiveGameState`): upcoming, live, stale, or over, and its plays. Folded from deliveries. A poll at the same game time as a live game's pushed snapshot only refreshes it: the push wins a tie. | game state, entity |
| **Live games** | The fold: each league's last listing and every current game's live game, applied from deliveries in `seq` order, and the instant it has ticked to. The domain's `LiveGames` is the pure fold; the Hub's service of the same name runs it with a timer and telemetry. Replaying the log gives the same live games. | game actors, registry |
| **Fold report** | What one step of the live games did to one game, for telemetry to tell: took a snapshot, started, changed, stopped, happened (a game event), dropped, or raised a defect. | fold event, log entry |
| **Stale** | A live game no snapshot has reached for 90 seconds. It stays current for 30 minutes after its last update. | |
| **Delivery** | What a frame said: a league's listing, one game's snapshot, or one game's whole list of plays. | input, update |
| **Decoded** | What one frame said, as a provider decodes it: a `Delivered` delivery with the instant and `seq` of its frame, a `Resync` of a live feed channel, or a `Noted` notice. | decoded frame, said |
| **Notice** | Something a provider's decode noticed in a frame for telemetry to tell: a message received, games pushed, an unlisted game, a document reset, a message of an unknown op, a frame, event, or play that did not decode, or an unknown play type. Told only for frames after a replay. | warning, metric |
| **Delivery source** | Which feed a snapshot came from: `push` or `poll`. | origin, feed type |
| **Test game** | A game snapshot built for a test, with defaults for everything the test does not care about. | fixture, mock |
| **Scenario** | A timeline of game snapshots for several games, written or cut from a recording, that a Hub can play instead of a provider. | fixture, simulation |
| **Scenario time** | The clock a scenario plays on: from the Hub's start, at the scenario's speed. | |
| **Situation** | Live football state: possession, down, distance, field position, red zone (the 20 and in), timeouts. | context |
| **Period** | A quarter or an overtime. | quarter (in code) |
| **Play** | A single snap, or a timeout, a penalty, or the end of a period, as the game's play-by-play lists it: its kind, clock, text, yardage, start and end, score after, and win probability. | |
| **Game id** / **Team id** / **League id** | A provider's own id for a game or a team, and a league's (`nfl` or `fbs`); `GameId`, `TeamId`, `LeagueId` in code. | |
| **Play id** | The feed's own id for one play; `PlayId` in code. Not ordered: plays are ordered by their sequence. | |
| **Play kind** | What a play was: a rush, a pass or incompletion, a sack, an interception, a fumble the offense kept or one it lost, a kick, a try, a penalty, a timeout, or the end of a period; `PlayKind` in code. | play type |
| **GameEvent** | Something that happened in a game: from its plays when it has them, from comparing two snapshots otherwise. Derived, never stored. | alert, update |

### Data and video

| Term | Meaning | Not |
| --- | --- | --- |
| **Provider** | An adapter that supplies **game data** (ESPN, CollegeFootballData): its poll, its push (the live feed), its decode, and its polling Schedule. | source, feed |
| **Provider error** | A provider could not supply data: a poll of a league unreachable or refused, or a push refused, closed, or gone silent. | fetch error, live feed error |
| **Live feed** | A provider's push: the connection carrying updates for live games between polls (ESPN FastCast). | socket, stream, webhook |
| **ESPN event** | One game as either ESPN feed spells it, the polled site scoreboard or a FastCast scoreboard topic, read as a GameSnapshot; `EspnEvent` in code. | payload, DTO |
| **Topic owner** | What a live feed topic carries: one league's scoreboard, or one game's plays; `Owner` in code. | subscription |
| **Checkpoint error** | A live feed topic's checkpoint could not be loaded or did not decode; retried by FastCast's checkpoint retry, then the game is left to polling. | |
| **Recording** | A day of one league's raw polls and socket lines recorded by hand before the Hub kept a feed log, which the dev tools cut into a scenario or import into the feed log. Not the feed log, which the Hub keeps itself. | feed log |
| **Recording unreadable** | A recording's folder is no league's, or its polls could not be listed; `RecordingUnreadable` in code. | |
| **Ingesting** | The Hub's loop, in `ingest/`, that replays the day from the feed log into the live games, then polls the provider on its polling and runs its push, appending every frame to the log and folding what each says into the live games. | poller, sync, fetcher |
| **Polling** | When a provider is polled again, given the slate the last poll left and the leagues that failed: a Schedule its adapter declares. ESPN's is 10 s while a game is live, 1 min within 30 minutes of a kickoff, 15 min otherwise. | cadence, interval |
| **Source** | A way you obtain **video** (YouTube TV). | provider, service |
| **Source name** | A source as people know it ("YouTube TV"); how code and the UI name a source. | source id |
| **Broadcast** | The fact that a network is airing a game, on television or streaming only. | channel, stream |
| **Network** | A network's name as a provider reports it ("CBS", "ESPN"). | channel, station |
| **Channel** | A station as a source names it ("News 3", "ESPN2"), with the address that plays it live. | network |
| **Channel id** | A source's own id for one of its channels (YouTube TV's station id); `ChannelId` in code. | station id |
| **Channel carriage** | Whether a source carries a network: on a channel, or not at all. | answer, mapping |
| **Channel lineup** | The channel carriages one source has learned, and the guide where the rest are picked. | channel map |
| **Channel availability** | Whether and where a source can show a game: carried, upcoming, unlearned (its network still to be picked), or not carried, with why. | availability |
| **Guide** | One reading of a source's listing of the channels this account gets, with their live addresses, and what each airs. | schedule, EPG |
| **Airing** | One programme on a channel, with its begin and end. | listing, show |
| **Guide unreadable** | A guide response the source could not read. | |
| **Channel URL refused** | An address a source would not learn, because it is not one of its live channels. | not a channel |
| **Channel store** | Where the Hub keeps the channel carriages it has learned. | channel repository |
| **Channel store error** | The channel store could not read or write. | database error |
| **Database** | The Hub's SQLite database. Each store migrates its own tables in it. | store, persistence |
| **Game history** | Past plays and each game's latest snapshot, derived from the fold into the Hub's database. Rebuildable from the feed log. | archive, stats |
| **Game history error** | The game history could not read. | database error |
| **Feed log** | Every frame the feeds delivered, raw, in the order the Hub received it. The truth the Hub's game state is folded from. | event store, journal |
| **Frame** | One thing a feed delivered: a poll response, a FastCast message, or a FastCast checkpoint. | message, payload |
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
| **Hub client** | The web UI's way to the Hub's API, `HubClient` in code: stage and channel commands, and the stage commands that failed: refused by the Hub, or never reaching it. It runs in the web UI's one runtime (`HubRuntime.ts`), with the live stream. | API client, fetcher |
| **Stage sessions** | The Hub component holding the authoritative Stage for each Display and applying stage commands to it. | stage store, stage manager |
| **Telemetry** | The traces, logs, and metrics the Hub exports for people to read in Grafana. | monitoring, observability stack |
| **Display** | A device running the shell and presenting a Stage. Its local state (selected tile, interacting tile, pick, slate drawer, and the one open overlay) is the web UI's `Display`. | screen, client, player |
| **Remote** | A client controlling a Display's Stage without presenting it. | controller |
| **Shell bridge** | The small interface the desktop shell exposes to the web UI; its IPC channel names are `ShellChannel`. | IPC, native API |
| **Full screen** | A Display's window filling its monitor with only the Stage; local to the Display, not a Stage state. | solo |
| **Hotkey** | A key Sportal acts on, wherever it was pressed: in the web UI or in a stream view with focus. | shortcut, keybind |
| **Provider session** | The shell's single persistent browser session shared by every provider view, with its navigation allowlist and permissions. | partition, profile |
| **Tile views** | The shell component that keeps one provider web view per stream or picking tile, placed where the web UI says. | view manager |
| **Tile bounds** | A tile view's rectangle in the web UI's window, in whole CSS pixels; `TileBounds` in code. | rect, frame |
| **Channel pick** | The shell's report that a picking tile's guide view landed on a channel's address, for its game. | selection |
| **Guide reader** | The shell component that reads a source's guide with the source's own guide request, sent on the provider session. | scraper, EPG fetcher |

### Viewing

| Term | Meaning | Not |
| --- | --- | --- |
| **Stage** | A Display's multi-view surface and its state. | grid, multiview, wall |
| **Stage command** | An instruction to change a Stage: assign, clear, swap, promote, solo, change layout or split, or focus audio. Issued by people and by the Director alike. | action, event |
| **Layout name** | A layout's own name, as the Stage and the layout picker name it; `LayoutName` in code. | |
| **Stage rejection** | The reason a stage command was refused. | error |
| **Layout** | A named arrangement of tile slots whose dividers can be moved. | grid, template |
| **Split** | Where a layout's dividers sit, as fractions of the Stage area. | ratio, sizes |
| **Tile** | One slot's content: a **stream tile**, a **picking tile**, a **data tile**, or empty. | pane, cell, window |
| **Picking tile** | A tile showing a source's guide until its game's network has a channel; `PickingChannel` in code. | setup tile |
| **Main tile** | The largest slot of a layout. | hero, primary |
| **Bench** | The tiles a layout has no slot for, kept in order and not played. | queue, reserve |
| **Pick** | The slate game a Display has stepped to with `[` `]`, ready to drop into the selected tile with Enter. Local to the Display, like the selected tile. | highlight, cursor |
| **Solo** | One on-stage game filling the whole Stage. | fullscreen, maximize |
| **Swap** | Exchange two tiles, on stage or benched. | move |
| **Audio focus** | The single game whose sound is on; it follows the game when tiles move. | active, unmuted |
| **Strip card** | One card in the slate strip: a benched game, or a slate game in its section (Bench, Live, Next, Final), marked with its slot when it is on stage; `StripCard` in code. | tile, slate item |
| **Display step** | A Display after an input, and the stage commands that input sends; `DisplayStep` in code. | result, update |
| **Interacting tile** | The one stream tile whose player gets the mouse, after `I`; every other stream tile's player never sees the pointer. Local to the Display, like the selected tile. | active, unlocked |
| **Promote** | Move a game into the main tile. | feature |
| **Tile placement** | Where a game's stream or picking tile sits in a Display's window, what it loads, and whether it is a stream or a guide, as told to the shell. | bounds, rect |
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
| **Trigger** | A condition over events and snapshots. | |
| **Rule** | A trigger bound to a stage command and a revert condition. | automation |
| **Director** | The Hub component that evaluates rules and issues stage commands. | autopilot |
| **Alert** | A user-facing notification produced by a rule. | event |
| **Ticket** | A bet you have placed, tracked by the betting lens (later). | bet, wager |
