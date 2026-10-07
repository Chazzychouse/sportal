# Game-day checklist

Provider playback cannot be tested automatically. Run this by hand during live games after any change
to `apps/desktop` or to how stream tiles are rendered.

Setup: Hub serving the built web UI, desktop shell running, signed in to YouTube TV.

| # | Do | Expect |
| --- | --- | --- |
| 1 | Open the shell | Slate lists today's NFL and FBS games, live first; header reads `live` |
| 2 | Watch a live game's row for a minute | Score and clock update without a reload |
| 3 | With a fresh `.sportal/` data directory, open the shell and watch its terminal | Once the Hub page shows, a game live on a TV network in your guide plays when clicked (as row 4); no `GuideReader:` warning in the shell, no `could not be read` warning in the Hub log |
| 4 | Click a live game on a TV network in your YouTube TV guide | It plays within a few seconds, straight into the tile |
| 5 | Quit the shell for 45 minutes, or start the Hub with no shell; assign a game | Its tile says "Waiting for the YouTube TV guide"; opening the shell turns it into a stream within seconds |
| 6 | Click another game on the same network | It plays at once |
| 7 | Fill all four tiles with games on TV networks in your guide | Tiles up to the stream limit play; note what the provider does past it |
| 8 | Press `audio` on each tile in turn | Exactly one tile is audible each time |
| 9 | Pick a game that is already on the Stage | It moves to the selected tile; it is never shown twice |
| 10 | Click an ESPN+ game | "Streaming only: not on YouTube TV" and no video; the next ESPN+ game is a data tile at once |
| 11 | Press `clear` on a playing tile | Video and sound stop for that tile only |
| 12 | Resize and maximize the window | Every video stays inside its tile; score strips stay visible |
| 13 | Open the web UI in a normal browser on the same machine | Same slate and Stage; a stream tile shows an "Open in YouTube TV" link instead of video; while the shell has read a guide in the last 45 minutes, tiles there are guide-matched as in the shell; with no guide read (or the last one stale), a game's tile says "Waiting for the YouTube TV guide"; a change there changes the shell |
| 14 | Stop the Hub, wait, start it | Header shows `reconnecting…` then `live`; video keeps playing while the Hub is down; when the Hub returns the Stage is empty again, because the Stage is not saved yet |
| 15 | After the Hub restart, click a game on a network | It plays once the shell's next guide read lands (the guide is kept in memory only); until then its tile says "Waiting for the YouTube TV guide" |
| 16 | Quit and reopen the shell | Still signed in to the provider |
| 17 | Once, after a channel's programme changes, click a game on that network | It plays the channel live, showing the new programme (first passed 2026-10-03). If it plays the old programme or fails, record it |
| 18 | Open the shell and watch its terminal while the Hub page loads | No `refused shell navigation` warning for the Hub's own frames (the subframe guard could refuse an `about:blank` frame) |
| 19 | Press **Sign in to YouTube TV**, sign in, close the window | Every tile plays without signing in again; the sign-in survives a shell restart |
| 20 | Click a game kicking off in more than half an hour | The tile reads "On <channel> at <time>"; it plays on its own within two minutes of that time |
| 21 | On an NFL Sunday, click two CBS games at 1:00 PM | Each plays its own game, each on its own "NFL ST - CBS" station |
| 22 | With three tiles playing, wait 5 minutes for a guide read | All three keep playing; the read plays nothing and the Hub logs `YouTubeTv: read a guide of …` |
| 23 | During a read, look for a window or sound | None: a read opens no view |
| 24 | During a game that runs past its listed time (overtime, a long review), wait through the guide reads after its airing ends | The tile keeps playing; it never turns into a data tile while the game is on |
| 25 | In YouTube TV, set the live guide's sort to Custom, then wait 5 minutes for a read | The Hub logs fewer channels; games on hidden channels are "Not in your YouTube TV guide". Set the sort back to Default |
| 26 | Fill four tiles with live streams, then promote tile 4 (`Shift`+`4`) | Tile 4's video slides into the main tile while it plays and takes the sound; neither player reloads or goes black |
| 27 | Press `L` through every layout and back to Quad | Tiles move with their video; shrinking benches games (listed under the slate) and growing restores each to its place |
| 28 | Click into a playing stream, then press `2`, `F`, `Esc` | Sound moves to tile 2; the selected tile solos and unsolos; YouTube TV does not seek |
| 29 | Drag a divider across a playing video | The video tracks the divider live; on release the split holds and survives a reload |
| 30 | Press `F11`, then solo a tile | Top bar and slate hide; the soloed game fills the screen; `Esc` and `F11` undo each in turn |
| 31 | Open the command palette (`Ctrl`+`K`) | Only the videos under the palette blank, with sound still on; they return when it closes |
| 32 | Drag a benched game onto a tile's header | The two swap; the benched game's player starts, the other's closes |
| 33 | Run `SPORTAL_SCENARIO=two-minute-drill-tie SPORTAL_SCENARIO_SPEED=10 pnpm dev`, fill four tiles from the strip | Each tile plays a synthetic stream: colour bars moving, its game's score and clock ticking; no sign-in. Moving audio focus (`1`–`4`) moves the tone you hear. `tie-uga-ala` shows RED ZONE about 12 seconds in and goes final about 22 seconds in; these timings hold. The field draws each play as it arrives: the ball moves and the play's arrow draws on |
| 34 | During a live window, open **Transitions** on the Live games dashboard (mode `live`) | `Live → Stale` and `Stale → Live` counts move as games go stale and come back; `Upcoming → Live` rises as games kick off |
| 35 | With two games playing, rest and move the pointer over each video | No YouTube TV title or controls appear on either |
| 36 | Click a video that is not the selected tile | That tile becomes selected; playback does not pause or change |
| 37 | Select a playing tile and press `I`, then use the player's controls with the mouse | The controls appear and work on that tile only; the other tiles still show no controls |
| 38 | Press `I` again, or select another tile | The player stops getting the mouse; hovering it shows nothing again |
| 39 | With Docker running, run `pnpm telemetry`, then a scenario at 10× with `SPORTAL_OTLP_URL=http://localhost:4318`, and open the Hub dashboard (`localhost:3000`, folder Sportal) | The dashboard fills; a poll's trace shows its provider calls; logs filter by mode |
| 40 | With a game live, run `pnpm telemetry` and the Hub with `SPORTAL_OTLP_URL=http://localhost:4318`, and open the Live games row of the Hub dashboard (mode `live`). Then check staleness: cut the network for two minutes (Wi-Fi off or cable out), then restore it. A scenario cannot do this, since it keeps answering with its last frame | Live games by state fill; a game that stops updating turns stale about 90 seconds later and live again on its next snapshot (`Live → Stale` about 90 s after the cut, `Stale → Live` on the first poll after the network returns); one game's transitions read in order in its logs panel (type its id into **Game**) |
| 41 | Solo a tile, open the key help, press `Ctrl`+`K` | Only the palette is open. `Esc` closes it; a second `Esc` unsolos |
| 42 | Select tile 4 in Quad, switch to Single from the Remote | The one tile is selected, and a drop goes into it |
| 43 | Solo a tile, press `?`, then `Esc` | The key help closes and the tile stays soloed |
| 44 | After a real game day, check that the feed log recorded it (`feed.sqlite` in the data directory), note its modification time, then run `SPORTAL_SCENARIO=late-go-ahead-cascade SPORTAL_SCENARIO_SPEED=10 pnpm dev` | The feed log holds the day; the strip plays the recorded games with their plays arriving; the Feed log row shows `poll` and `fastcast` frames in mode `scenario`; `feed.sqlite`'s modification time does not change |
| 45 | With a game live and telemetry on, open **Live games** from the Hub dashboard's links (mode `live`), then click a game in **Games** | Games lists each game with its state and counts; clicking one narrows every panel below to it; its state timeline matches its transitions, scores and turnovers mark its graphs |
| 46 | During a live NFL game with `pnpm telemetry` and the Hub on `SPORTAL_OTLP_URL=http://localhost:4318`, open the Live feed row of the Hub dashboard (mode `live`) | Connected shows 1; `P` messages for `nfl` arrive about every few seconds and `B` whenever 10 s pass without another message; Connects in range stays at 1; Errors by reason is empty. Snapshots shows push `taken`, poll `behind`, and poll `kept` (a poll that ties a push). A `Slate.take` trace in Tempo carries the frame's `sportal.seq` and its `sportal.deliveries` count |
| 47 | During a live game, watch `feed.sqlite` in the data directory (`ls -l`) and open the Feed log row of the Hub dashboard (mode `live`) | The file grows for the whole game; Frames by feed and kind shows `fastcast message` frames and `poll response` frames, and `fastcast`/`message` frames keep rising while the game is live (query `sportal_feed_frames_total{feed="fastcast",kind="message"}`; the metric has no channel, so it cannot single out `gp-` topics: Plays by league, `sportal_plays`, counts the plays they bring); Write failures and frames lost, and Decode failures, stay empty |
| 48 | During a live game, note one game's `plays` row count (`sqlite3 sportal.sqlite "select count(*) from play where game = '<id>'"`), stop the Hub, start it, and count again | The Hub replays the day before serving (one `Slate: replayed … frames: … deliveries` Info line); the count is the same or higher, never lower, and the game's state is as before the stop; the decode counters on the Feed log and Live feed rows (messages, games pushed, unlisted, undecoded, document resets) restart from zero and rise only with new frames, and no `waits for its next checkpoint` Warning is logged for the replayed frames |
| 49 | During a live NFL game, type its id into **Game** on the Live games dashboard and read its logs panel | Its `Played` events appear within a minute of the snap, one per new play; Plays by league on the Feed log row counts them |
| 50 | Once, on a live college Saturday, with the Hub on `SPORTAL_OTLP_URL=http://localhost:4318` | Confirm the college `gp-` topic, `gp-football-college-football-<id>`, is the one ESPN serves: a college game shows `Plays` deliveries and its plays row count grows, and Live feed logs show no refused or empty subscription. Unverified until a live college day; if the topic name is wrong, record it |
| 51 | Once, while a game is live, make the decoder reset (a patch that will not apply shows as a document reset on the Feed log row, or cut the network briefly) | The socket re-sends `S` for that topic and a fresh `H` (checkpoint) arrives: Document resets rises, Checkpoint failures does not (it counts only checkpoints that fail to load or decode, each topic followed again every 30 s, five tries in all, then left to polling), and the game's plays carry on. Unverified live: if no `H` comes back, record it |
| 52 | With a game live, put it on a data tile (a game with no stream) | The tile draws the field with the ball at the game's spot; each new play animates on it, the field dims when the ball is out of play, and a busy stretch of plays does not stall it |

Record the date, the build, and any row that failed.
