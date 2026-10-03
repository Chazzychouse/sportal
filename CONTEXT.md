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
| **Slate** | The games in a time window (a Saturday, an NFL week). | schedule, scoreboard |
| **Kickoff** | A game's scheduled start instant. | start time, date |

### Game state

| Term | Meaning | Not |
| --- | --- | --- |
| **GameStatus** | `scheduled`, `live`, `halftime`, `delayed`, `final`, `postponed`, `canceled`. | state, phase |
| **GameSnapshot** | The complete normalized state of a game at an instant. | update, payload |
| **GameDetail** | A snapshot plus drives, plays, and statistics. | summary |
| **Situation** | Live football state: possession, down, distance, field position, red zone, timeouts. | context |
| **Period** | A quarter or an overtime. | quarter (in code) |
| **Drive** / **Play** | A possession sequence / a single snap. | |
| **GameEvent** | Something that happened, derived by diffing snapshots. | alert, update |

### Data and video

| Term | Meaning | Not |
| --- | --- | --- |
| **Provider** | An adapter that supplies **game data** (ESPN, CollegeFootballData). | source, feed |
| **Provider error** | A provider could not supply data for a league: unreachable, rate-limited, or unreadable. | fetch error |
| **Source** | A way you obtain **video** (YouTube TV). | provider, service |
| **Broadcast** | The fact that a network is airing a game. | channel, stream |
| **Channel** | A network as carried by a specific source. | |
| **Availability** | Whether and where a source can show a game. | |
| **Stream** | One playing instance of a game from a source. | feed, video |
| **StreamLocator** | What a Display must load to play a stream. | URL, link |
| **StreamBudget** | How many concurrent streams a source allows. | limit, cap |

Provider and Source are the two words most likely to be swapped. Provider is always data; Source is always video.

### Devices

| Term | Meaning | Not |
| --- | --- | --- |
| **Hub** | The server process that owns all shared state. | backend, server |
| **Display** | A device running the shell and presenting a Stage. | screen, client, player |
| **Remote** | A client controlling a Display's Stage without presenting it. | controller |
| **Desk mode** / **Couch mode** | The two presentation densities. | desktop/TV layout |
| **Shell bridge** | The small interface the desktop shell exposes to the web UI. | IPC, native API |

### Viewing

| Term | Meaning | Not |
| --- | --- | --- |
| **Stage** | A Display's multi-view surface and its state. | grid, multiview, wall |
| **Stage command** | An instruction to change a Stage: assign, clear, or focus audio. Issued by people and by the Director alike. | action, event |
| **Stage rejection** | The reason a stage command was refused. | error |
| **Layout** | A named arrangement of tile slots. | grid, template |
| **Tile** | One slot's content: a **stream tile**, a **data tile**, or empty. | pane, cell, window |
| **Main tile** | The largest slot of a layout. | hero, primary |
| **Audio focus** | The single tile whose sound is on. | active, unmuted |
| **Promote** | Move a game into the main tile. | feature |
| **Preset** | A saved layout with tile assignments. | |
| **Tile placement** | Where a stream tile sits in a Display's window and what it plays, as told to the shell. | bounds, rect |
| **Tile delay** | Seconds that data is held back for a tile to match its video. | offset, latency |
| **Spoiler shield** | Hiding or delaying scores for chosen games. | |

### Personalization and automation

| Term | Meaning | Not |
| --- | --- | --- |
| **Follow** | Your declared interest in a team, conference, league, or game. | favourite, subscription |
| **Watchability** | A 0–100 score of how worth watching a live game is right now. | excitement, heat |
| **Trigger** | A condition over events and snapshots. | |
| **Rule** | A trigger bound to a stage command and a revert condition. | automation |
| **Director** | The Hub component that evaluates rules and issues stage commands. | autopilot |
| **Alert** | A user-facing notification produced by a rule. | event |
| **Ticket** | A bet you have placed, tracked by the betting lens (later). | bet, wager |

