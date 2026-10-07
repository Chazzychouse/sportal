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
| **Slate** | The domain's `Slate`: each league's last listing and every current game's live game, taken from push and poll deliveries in arrival order, each game it saw finish (its final, while a listing names it, so a snapshot not past its end, later on the clock or at the same clock with more points, is behind: a lagging poll neither starts it again nor shows it live, while overtime after a spurious final or a postponed game resuming does), and the instant it has ticked to. Pure; `take` and `tick` return the next slate, the game events it said, and its slate observations. Replaying the log gives the same slate. | schedule, scoreboard, live games |
| **Live slate** | The Hub's `LiveSlate` service, which runs the slate: it follows the feed log from the game day's start, replaying it quietly and then taking each new frame as it is appended, with a timer and telemetry, and publishes each listed game as the slate has it, with its recent plays, to the strip under the Stage. | slate service, tracker |
| **Published** | What the live slate publishes to the live stream: the listed games as the slate has them and their recent plays, settled 250 ms after a change; `Published` in code. | slate payload, snapshot |
| **Kickoff** | A game's scheduled start instant. | start time, date |

### Game state

| Term | Meaning | Not |
| --- | --- | --- |
| **GameStatus** | `scheduled`, `live`, `halftime`, `delayed`, `final`, `postponed`, `canceled`. | state, phase |
| **GameSnapshot** | The complete normalized state of a game at an instant. | update, payload |
| **Game time** | How far a game has got: before kickoff, in play, or over; then the period; then the clock running down; then, at the same clock, halftime after play (any other statuses at the same clock tie). Orders two snapshots of one game. | timestamp, version |
| **Progress** | Where a game is in its day: `upcoming`, `live`, or `over`. A delay before kickoff is upcoming and a delay during the game is live. | phase, state |
| **Live game** | One game as the Hub follows it: its latest snapshot, the delivery source that gave it, its state (`LiveGameState`): upcoming, live, holding, stale, or over, and its plays. Taken from deliveries by the slate. A covered game takes a poll only ahead of it, by holding it for 15 seconds (`fallbackAfter`). | game state, entity |
| **Covered** | A live game followed by the push: live or holding, its snapshot from the push. | |
| **Ahead** | One snapshot of a game past another: later in game time, or at the same game time with more points, or as many points split differently. A status alone puts a snapshot ahead only where game time orders it (halftime after play at the same clock), so two snapshots are never ahead of each other on their status. | newer |
| **Held snapshot** | A poll snapshot ahead of a covered game, held until the push catches it up or `fallbackAfter` passes; `held` on `LiveGameState.Holding`. | pending |
| **Fallback** | A held snapshot applying as the poll's once the push has not caught it up for `fallbackAfter`, saying its events; the `Took` outcome `fellBack`. | |
| **Took outcome** | What taking a snapshot did to its game: taken, ignored as behind, or held by a covered game; `TookOutcome` in code. A slate observation's `Took` adds `fellBack`, for a fallback. | result |
| **Following** | Where the live slate is in reading the feed log: replaying the day before the Hub serves, live, or halted by a decode defect, when no new frame is taken but the timer still runs and is told; `Following` in code. | phase, mode |
| **Taken** | What one take or tick of the slate did: the next slate, the game events it said, in order, and its slate observations; `Taken` in code. | result, report |
| **Slate observation** | What one take or tick of the slate did to one game, for telemetry only: took a snapshot, started, changed, stopped, dropped, or raised a defect. The game events it said are `Taken.events`, not observations. | report, log entry |
| **Stale** | A live game no snapshot has reached for 90 seconds. It stays current for 30 minutes after its last update. | |
| **Delivery** | What a frame said: a league's listing, one game's snapshot, or one game's whole list of plays. | input, update |
| **Decoder** | The one home of a provider's decode, provided by its adapter as a layer of its own; `HubMode` pairs it with its provider, so a recorded scenario decodes its frames as the provider that recorded them would. | parser |
| **Decoded** | What one frame said, one per frame: its deliveries, the live feed channels to resync, and its decode observations, with the frame's `seq` and receive time. | decoded frame, said |
| **Decode observation** | Something a provider's decode observed in a frame for telemetry to tell: a message received, games pushed, an unlisted game, a document reset, a message of an unknown op, a frame, event, or play that did not decode, or an unknown play type; `DecodeObservation` in code. Told only for frames after a replay. | notice, warning, metric |
| **Delivery source** | Which feed a snapshot came from: `push` or `poll`. | origin, feed type |
| **Test game** | A game snapshot built for a test, with defaults for everything the test does not care about. | fixture, mock |
| **Scenario** | Games a Hub plays as its provider, through the real ingest, feed log, decode, and slate: a name and ESPN's frames, recorded from a game day or written from a scenario script; `Scenario` in code. Every scenario plays through ESPN's decode. | fixture, simulation |
| **Scenario script** | A written scenario before it is written as frames: games and a timeline of changes, some with a play; `ScenarioScript` in code, each offset's slate and the plays run then. The ESPN adapter writes it as ESPN's frames. | |
| **Recorded scenario** | A scenario kept as the raw frames of a recorded window, `fixtures/scenarios/<name>.frames.jsonl.gz`, decoded by the provider that recorded them. | slice, recording |
| **Scenarios** | Every scenario there is, by name: the recorded ones where they are kept, and the written ones as ESPN's writer writes their scripts; reading one back by name. `Scenarios` in code. | scenario store, catalogue |
| **Scenario unknown** | `SPORTAL_SCENARIO` names no written or recorded scenario; `ScenarioUnknown` in code, with the names there are. | |
| **Scenario duplicate** | A recorded scenario and a written one share a name, which stops the Hub at startup; `ScenarioDuplicate` in code. | |
| **Scenario unreadable** | A recorded scenario's file could not be read as gzip'd frames; `ScenarioUnreadable` in code. | |
| **Scenario time** | The clock a scenario plays on: from the Hub's start, at the scenario's speed. Ingest and the live slate run on it. A scenario's frames are received at their offsets on it, but what they say, kickoffs among them, stays as recorded or written. | |
| **Situation** | Live football state: possession, down, distance, field position, red zone (the 20 and in), timeouts. | context |
| **Ball spot** | Where a spot is on the field: yards from the home goal line (0–100) and the way its team is going, from a team and its yards to the goal it attacks. | |
| **Period** | A quarter or an overtime. | quarter (in code) |
| **Play** | The plays of every sport, as a game's play-by-play lists them; football's only, for now, so `Play` is `FootballPlay`. | |
| **Football play** | A single snap, kick, try, penalty, timeout, stoppage, or the end of a period, as the play-by-play lists it: its clock, text, score after, start and end, win probability, and the case its feed's play type says, with what that type says of it; `FootballPlay` in code. The cases: `Rush` and `Completion` (a touchdown or not), `Incompletion`, `Interception` (returned, for a touchdown, or not), `Sack` (the defense recovering a fumble or not), `Fumble` (recovered by its own side, the other, for a touchdown, or not said), `TwoPointTry` (passed or run), `Kickoff` (returned for a touchdown or not), `Punt` (returned, for a touchdown, or not), `FieldGoal` (good, missed, or blocked), `ExtraPoint` (good or not), `Safety`, and `Penalty`, each with the team with the ball and the yards gained; `Timeout`, with the team that called it when the feed marks one; `Stoppage` (an official timeout, the two-minute warning, the coin toss); `PeriodEnd` (of a period, the half, regulation, or the game); and `Other`, a play type no case knows, kept as the feed spells it. | play kind, play type |
| **Play outcome** | A football play's case and what its feed's play type says of it: its `_tag` and outcome fields, without what every play carries or what it gained, as `{ _tag: "Punt", return: "none" }`; `PlayOutcome` in code. | play type, play kind |
| **Game id** / **Team id** / **League id** | A provider's own id for a game or a team, and a league's (`nfl` or `fbs`); `GameId`, `TeamId`, `LeagueId` in code. | |
| **Recent plays** | Each game's last ten plays, in sequence order, sent to the web with the slate; `RecentPlays` in code. A game with no plays is absent. | |
| **Play id** | The feed's own id for one play; `PlayId` in code. Not ordered: plays are ordered by their sequence. | |
| **GameEvent** | Something that happened in a game, stamped with the game, the instant it was told, and what happened (a **Game event kind**). Derived, never stored: from its snapshot's changes, or from its plays for a play event. | alert, update |
| **Game event kind** | What happened, without when or where: a score, a turnover, a play, a period ending. A play event (a play, a big play, a sack) from a game's plays; every other from comparing two snapshots. | event |

### Data and video

| Term | Meaning | Not |
| --- | --- | --- |
| **Provider** | An adapter that supplies **game data** (ESPN, CollegeFootballData): its poll, its push (the live feed), its polling Schedule, and how its push is reconnected. | source, feed |
| **Provider error** | A provider could not supply data: a poll of a league unreachable or refused, or a push refused, closed, or gone silent. | fetch error, live feed error |
| **Live feed** | A provider's push: the connection carrying updates for live games between polls (ESPN FastCast). `LiveFeed` in code. | socket, stream, webhook |
| **Live feed demand** | What the live feed should follow: the current games whenever which games they are changes, and each channel whose document must be read again from a checkpoint; `LiveFeedDemand` in code. | wanted, subscriptions |
| **FastCast** | ESPN's live feed, as the ESPN provider's push: one socket following each league's scoreboard and each game its demand names, with FastCast's checkpoint retry. | |
| **Snapshot feed** | A provider whose frames are our own deliveries, one per frame, and its decode: what tests drive, in `TestSnapshotFeed.ts`. | |
| **ESPN event** | One game as either ESPN feed spells it, the polled site scoreboard or a FastCast scoreboard topic, read as a GameSnapshot; `EspnEvent` in code. | payload, DTO |
| **Topic owner** | What a live feed topic carries: one league's scoreboard, or one game's plays; `Owner` in code. | subscription |
| **Checkpoint error** | A live feed topic's checkpoint could not be loaded or did not decode; retried on FastCast's checkpoint retry, then the game is left to polling. | |
| **Ingesting** | The Hub's loop that polls the provider on its polling and runs its push, retried on its reconnect, appending every frame to the feed log; the slate takes what it appends. | poller, sync, fetcher |
| **Polling** | When a provider is polled again, given the slate the last poll left and the leagues that failed: a Schedule its adapter declares. ESPN's is 10 s while a game is live, 1 min within 30 minutes of a kickoff, 15 min otherwise. | cadence, interval |
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
| **Database** | The Hub's SQLite database. Each store migrates its own tables in it. | store, persistence |
| **Game history** | Past plays and each game's latest snapshot, derived from the slate into the Hub's database. Rebuildable from the feed log. | archive, stats |
| **Game history error** | The game history could not read. | database error |
| **Feed log** | Every frame the feeds delivered, raw, in the order the Hub received it. The truth the Hub's game state is derived from. | event store, journal |
| **Frame** | One thing a feed delivered: a poll response, a FastCast message, or a FastCast checkpoint. | message, payload |
| **Corpus** | Game days kept typed for runs to play through the slate, in `HubConfig.corpusDir`: each day's corpus inputs, read back as the deliveries the live decode handed over. | dataset, fixtures |
| **Corpus day** | One game day of the corpus: its kind, format, leagues, game count, and when it was built, beside its poll and push files of corpus lines; `CorpusDay` in code. `CorpusDays` writes and reads them. A day without its `day.json` has not been built. | |
| **Captured day** | A corpus day built from the feed log's frames for the day, through the provider's decode. | recorded day |
| **Backfilled day** | A corpus day synthesized from the archive, for a day the feed log does not have; `CorpusBuild.backfilled` in code, which `corpus backfill` runs for a span of days that have ended. Both leagues of a date share one, and a captured day is never replaced by one. | |
| **Corpus input** | One line's input in a corpus day: a listing changed or unchanged since its league's last, a pushed snapshot, or a game's plays added, changed, and removed; `CorpusInput` in code. | |
| **Corpus line** | A corpus input as a day stores it, with its frame's `seq` and arrival instant; `CorpusLine` in code, which says a frame's lines from its deliveries and the deliveries back from its lines. | row, record |
| **Had** | What a corpus day had delivered so far, threaded across its frames: each league's last listing and each game's last plays. | state, cache |
| **Corpus day unreadable** | A corpus day that has not been built, does not decode, or was built to another format and must be built again; `CorpusDayUnreadable` in code. | |
| **Corpus run** | A corpus day played through the slate on virtual time: each frame taken at its arrival instant, which first ticks every instant due before it, then a tick to the next day's start; no clock runs. `CorpusRun.day` in code. A captured day's run gives the events the Hub's slate published live. | replay, simulation |
| **Subject** | What a corpus run plays a day through: a pure step over each take or tick of the slate, and what it gives at the end; `Subject` in code. `CorpusRun.events`, the day's game events in order, is the only one so far. | consumer, reducer |
| **Corpus build failed** | A corpus day that could not be built: the feed log has no frame received in it, a frame of it does not decode, or the archive has no final game with plays on it; `CorpusBuildFailed` in code. Nothing of the day is written. | |
| **Run day** | A worker thread's request to run one corpus day with the events subject; `RunDay` in code. `corpus run` sends one per day, one day to a worker at a time. | job, task |
| **Day run** | A worker's reply to a run day: how many events the day's run gave and how long it took; `DayRun` in code. A failed day crosses back as its failure instead. | result, report |
| **Days failed** | How many of the days a corpus build, backfill, or run named did not succeed: a day that did not decode, could not be read or fetched, or whose worker thread crashed; `DaysFailed` in code. The command logs each, then exits nonzero. A day the feed log or archive does not have, or that has no games, is not one. | errors |
| **Archive** | A provider's finished games, kept under the corpus's `archive/` exactly as fetched: a date's scoreboard and each final game's summary, each fetched once, and a refused summary as a refusal marker (its status, and when) so the date still rebuilds without fetching it again; `Archive` in code, a port whose adapter declares its pacing and retry. What a backfilled day is synthesized from. | cache, history |
| **Archived game** | A finished game as the archive gives it: as scheduled, as final, and its plays with the wallclock each was run at; `ArchivedGame` in code. A postponed or canceled game, one whose summary is refused, or one without plays with wallclocks, is skipped and logged. | |
| **Archived play** | A play of an archived game with the wallclock instant it was run at, as the provider's summary gives it; `ArchivedPlay` in code. A play without a wallclock is not one. | |
| **Synthesis** | Turning a date's archived games into a backfilled day's poll and push lines (`Synthesis.day`): each game pushed as scheduled half an hour before kickoff, then each play with the snapshot it leaves (its period, clock, scores, end spot, and each team's timeouts less those it called in the half; halftime after the second period ends, final after the last play), and a poll of every league every 10 s, each game as its last play the poll had reached left it. The lines come from `CorpusLine.of`, as a captured day's do. | |
| **Lag model** | How long after a play is run each feed shows it on a backfilled day: the push 28 s, the poll 41 s, ADR 0007's medians; fixed, with no jitter. | delay |
| **Archive fetch failed** | The archive could not give a date's games, or one game of them: a fetch did not connect or was answered with a server error after its retries, was refused, gave what does not read, or, reading the archive only, a file is not archived; `ArchiveFetchFailed` in code. Nothing is written for that fetch, so the next run fetches it again, except a refusal marker for a summary that is gone (404 or 410), whose game is then skipped rather than failed. | |
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
| **Live stage** | The Hub's one Stage, shared by every Display: applies stage commands one at a time and refreshes channel availability when the source changes. | stage store, stage manager, stage sessions |
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
| **Stage command** | An instruction to change a Stage: assign, clear, swap, promote, solo, change layout or split, or focus audio. Issued by people and by the Director alike. | action, event |
| **Layout name** | A layout's own name, as the Stage and the layout picker name it; `LayoutName` in code. | |
| **Stage rejection** | The reason a stage command was refused. | error |
| **Layout** | A named arrangement of tile slots whose dividers can be moved. | grid, template |
| **Split** | Where a layout's dividers sit, as fractions of the Stage area. | ratio, sizes |
| **Tile** | One slot's content: a **stream tile**, a **data tile**, or empty. | pane, cell, window |
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
| **Trigger** | A condition over events and snapshots. | |
| **Rule** | A trigger bound to a stage command and a revert condition. | automation |
| **Director** | The Hub component that evaluates rules and issues stage commands. | autopilot |
| **Alert** | A user-facing notification produced by a rule. | event |
| **Ticket** | A bet you have placed, tracked by the betting lens (later). | bet, wager |
