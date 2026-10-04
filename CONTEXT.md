# Sportal — Domain Language

One word per concept, used identically in code, UI, documents, and conversation.
Every exported type name must be a term here.

### Competition

| Term | Meaning | Not |
| --- | --- | --- |
| **Sport** | A kind of game (football). | |
| **League** | An organized competition (NFL, FBS). | association, division |
| **Conference** | A grouping of teams within a league (SEC, AFC). | |
| **Season** | One league year, with a **SeasonPhase**: preseason, regular, postseason. | |
| **Team** | A league member. | club, competitor, franchise |
| **Ranking** | A team's position in a poll (college). | seed |
| **Game** | One scheduled contest between two teams. | event, match, competition, fixture |
| **Slate** | The games in a time window (a Saturday, an NFL week). Shown as a strip under the Stage. | schedule, scoreboard |
| **Kickoff** | A game's scheduled start instant. | start time, date |

### Game state

| Term | Meaning | Not |
| --- | --- | --- |
| **GameStatus** | `scheduled`, `live`, `halftime`, `delayed`, `final`, `postponed`, `canceled`. | state, phase |
| **GameSnapshot** | The complete normalized state of a game at an instant. | update, payload |
| **Test game** | A game snapshot built for a test, with defaults for everything the test does not care about. | fixture, mock |
| **Scenario** | A timeline of game snapshots for several games, written or cut from a recording, that a Hub can play instead of a provider. | fixture, simulation |
| **Scenario time** | The clock a scenario plays on: from the Hub's start, at the scenario's speed. | |
| **GameDetail** | A snapshot plus drives, plays, and statistics. | summary |
| **Situation** | Live football state: possession, down, distance, field position, red zone, timeouts. | context |
| **Period** | A quarter or an overtime. | quarter (in code) |
| **Drive** / **Play** | A possession sequence / a single snap. | |
| **GameEvent** | Something that happened in a game between two snapshots of it: a score, the ball changing hands, a drive reaching the 40, the red zone, goal to go, fourth down, a timeout, a period or the game ending. Derived, never stored. | alert, update |

### Data and video

| Term | Meaning | Not |
| --- | --- | --- |
| **Provider** | An adapter that supplies **game data** (ESPN, CollegeFootballData). | source, feed |
| **Provider error** | A provider could not supply data for a league: unreachable, rate-limited, or unreadable. | fetch error |
| **Ingest** | The Hub's loop that polls providers and keeps the current slate. | poller, sync, fetcher |
| **Cadence** | How long Ingest waits between polls, given what the last poll saw. | interval, rate |
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
| **Live channel URL** | A source's address for a channel, reduced to the one that plays it live. | canonical URL |
| **Stream** | One playing instance of a game from a source. | feed, video |
| **StreamLocator** | What a Display must load to play a stream. | URL, link |
| **StreamBudget** | How many concurrent streams a source allows. | limit, cap |

Provider and Source are the two words most likely to be swapped. Provider is always data; Source is always video.

### Devices

| Term | Meaning | Not |
| --- | --- | --- |
| **Hub** | The server process that owns all shared state. | backend, server |
| **Hub config** | Every setting a Hub reads from its environment, decoded once at startup; `HubConfig` in code. | settings, env |
| **Live message** | One update the Hub pushes to clients on the live stream: the slate changed, or the Stage changed. | event, notification |
| **Stage sessions** | The Hub component holding the authoritative Stage for each Display and applying stage commands to it. | stage store, stage manager |
| **Display** | A device running the shell and presenting a Stage. | screen, client, player |
| **Remote** | A client controlling a Display's Stage without presenting it. | controller |
| **Desk mode** / **Couch mode** | The two presentation densities. | desktop/TV layout |
| **Shell bridge** | The small interface the desktop shell exposes to the web UI. | IPC, native API |
| **Full screen** | A Display's window filling its monitor with only the Stage; local to the Display, not a Stage state. | solo |
| **Hotkey** | A key Sportal acts on, wherever it was pressed: in the web UI or in a stream view with focus. | shortcut, keybind |
| **Provider session** | The shell's single persistent browser session shared by every provider view, with its navigation allowlist and permissions. | partition, profile |
| **Tile views** | The shell component that keeps one provider web view per stream or picking tile, placed where the web UI says. | view manager |
| **Channel pick** | The shell's report that a picking tile's guide view landed on a channel's address, for its game. | selection |
| **Guide reader** | The shell component that reads a source's guide with the source's own guide request, sent on the provider session. | scraper, EPG fetcher |

### Viewing

| Term | Meaning | Not |
| --- | --- | --- |
| **Stage** | A Display's multi-view surface and its state. | grid, multiview, wall |
| **Stage command** | An instruction to change a Stage: assign, clear, swap, promote, solo, change layout or split, or focus audio. Issued by people and by the Director alike. | action, event |
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
| **Promote** | Move a game into the main tile. | feature |
| **Preset** | A saved layout with tile assignments. | |
| **Tile placement** | Where a game's stream or picking tile sits in a Display's window, what it loads, and whether it is a stream or a guide, as told to the shell. | bounds, rect |
| **Stage transition** | How tiles move to new places: one duration and easing, shared by the web UI and the shell. | animation |
| **Tile delay** | Seconds that data is held back for a tile to match its video. | offset, latency |
| **Spoiler shield** | Hiding or delaying scores for chosen games. | |

### Personalization and automation

| Term | Meaning | Not |
| --- | --- | --- |
| **Follow** | Your declared interest in a team, conference, league, or game. | favourite, subscription |
| **Watchability** | A 0–100 score of how worth watching a live game is right now, whether it is in a lull, and why; folded forward one snapshot at a time. | excitement, heat |
| **Lull** | A live game with nothing happening: halftime, a delay, between periods, a TV break after a timeout, score, or change of possession, or no play for a minute. | break, stoppage |
| **Trigger** | A condition over events and snapshots. | |
| **Rule** | A trigger bound to a stage command and a revert condition. | automation |
| **Director** | The Hub component that evaluates rules and issues stage commands. | autopilot |
| **Alert** | A user-facing notification produced by a rule. | event |
| **Ticket** | A bet you have placed, tracked by the betting lens (later). | bet, wager |
