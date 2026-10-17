# Game-day checklist

Provider playback cannot be tested automatically. Run this by hand during live games after any change
to `apps/desktop` or to how stream tiles are rendered.

Setup: Hub serving the built web UI, desktop shell running, signed in to YouTube TV.

| # | Do | Expect |
| --- | --- | --- |
| 1 | Open the shell, then the command palette (`Ctrl`+`K`) | The palette's Watch group lists today's NFL and FBS games, live first; the top bar counts the games live and its pill reads `Hub live` |
| 2 | Watch a live game's row for a minute | Score and clock update without a reload |
| 3 | Start the Hub, open the shell and watch its terminal | Once the Hub page shows, a game live on a TV network in your guide plays when clicked (as row 4); no `GuideReader:` warning in the shell, no `could not be read` warning in the Hub log |
| 4 | Click a live game on a TV network in your YouTube TV guide | It plays within a few seconds, straight into the tile |
| 5 | Quit the shell for 45 minutes, or start the Hub with no shell; assign a game | Its tile says "Waiting for the YouTube TV guide"; opening the shell turns it into a stream within seconds |
| 6 | Click another game on the same network | It plays at once |
| 7 | Fill all four tiles with games on TV networks in your guide | Tiles up to the stream limit play; note what the provider does past it |
| 8 | Press `audio` on each tile in turn | Exactly one tile is audible each time |
| 9 | From the palette, then from the Remote, pick a game already in a tile | It stays in its tile; it is never shown twice |
| 10 | Click an ESPN+ game | "Streaming only: not on YouTube TV" and no video; the next ESPN+ game is a data tile at once |
| 11 | Press `clear` on a playing tile | Video and sound stop for that tile only |
| 12 | Resize and maximize the window | Every video stays inside its tile; score strips stay visible |
| 13 | Open the web UI in a normal browser on the same machine and fill a tile from its palette | Its palette lists the same games as the shell's; a stream tile shows an "Open in YouTube TV" link instead of video; while the shell has read a guide in the last 45 minutes, tiles there are guide-matched as in the shell; with no guide read (or the last one stale), a game's tile says "Waiting for the YouTube TV guide"; its Screen is its own (row 49) |
| 14 | Stop the Hub, wait, start it | The top bar's pill shows `Reconnecting` then `Hub live`; video keeps playing while the Hub is down, and the Screen stays as it was |
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
| 27 | Press `L` through every layout and back to Quad | Tiles move with their video; shrinking benches the games past the layout's tiles (off screen, and on the Remote's map) and growing restores each to its place |
| 28 | Click into a playing stream, then press `2`, `F`, `Esc` | Sound moves to tile 2; the selected tile solos and unsolos; YouTube TV does not seek |
| 29 | Drag a divider across a playing video | The video tracks the divider live; on release the split holds and survives a reload |
| 30 | Press `F11`, then solo a tile | The top bar hides; the soloed game fills the screen; `Esc` and `F11` undo each in turn |
| 31 | Open the command palette (`Ctrl`+`K`) | Only the videos under the palette blank, with sound still on; they return when it closes |
| 32 | Drag one playing tile's header onto another's | The two swap; each video moves with its game |
| 33 | Fill four tiles from live games, move audio focus (`1`–`4`), then show a game with a drive under way as a data tile | Sound moves with focus. The data tile's field draws each play as it arrives: the ball moves and the play's arrow draws on |
| 34 | With two games playing, rest and move the pointer over each video | No YouTube TV title or controls appear on either |
| 35 | Click a video that is not the selected tile | That tile becomes selected; playback does not pause or change |
| 36 | Select a playing tile and press `I`, then use the player's controls with the mouse | The controls appear and work on that tile only; the other tiles still show no controls |
| 37 | Press `I` again, or select another tile | The player stops getting the mouse; hovering it shows nothing again |
| 38 | Removed with telemetry ([ADR 0019](adr/0019-telemetry-goes.md)) | – |
| 39 | Solo a tile, open the key help, press `Ctrl`+`K` | Only the palette is open. `Esc` closes it; a second `Esc` unsolos |
| 40 | Select tile 4 in Quad, press `L` until Single, or choose Single in the top bar's layout picker | The one tile is selected, and a drop goes into it |
| 41 | Solo a tile, press `?`, then `Esc` | The key help closes and the tile stays soloed |
| 42 | During a live NFL game, read the Hub's log (its console, or `hub.log` in the installed app's log folder) | `FastCast: connected` appears once, with no reconnect after it; no FastCast Warning names a refused or empty subscription |
| 43 | During a live game, put it on a data tile, note its score and the plays on its field, stop the Hub, start it, and look again | The palette is empty until the first poll; the tile shows the game at its current score within 20 seconds of the Hub starting (it never stays on "Loading…"), and its field's plays come back once FastCast follows its topic again |
| 44 | During a live NFL game, put it on a data tile and watch its field | Each new play draws on the field within a minute of the snap, one per play |
| 45 | Once, on a live college Saturday | Confirm the college `gp-` topic, `gp-football-college-football-<id>`, is the one ESPN serves: a college game shows `Plays` deliveries and its plays draw on its data tile's field, and the Hub's log shows no refused or empty subscription. Confirmed 2026-10-09 on FSU @ LOU: `gp-football-college-football-<id>` subscribes and checkpoints with its plays |
| 46 | Once, while a game is live, make a FastCast topic lose its document (cut the network briefly) | A `GameTopics: <topic> lost its document (…)` Warning is logged, then `FastCast: following <topic> again from its checkpoint` (Info). The socket re-sends `S` for that topic and a fresh `H` (checkpoint) arrives, and the game's plays carry on (a checkpoint that fails to load or decode is followed again every 30 s, five tries in all, then left to polling). Unverified live: if no `H` comes back, record it |
| 47 | With a game live, put it on a data tile (a game with no stream) | The tile draws the field with the ball at the game's spot; each new play animates on it, the field dims when the ball is out of play, and a busy stretch of plays does not stall it |
| 48 | Fill tiles, change the layout, reload the web UI (`Ctrl`+`R` in the shell) | The Screen comes back as it was: the same layout, tiles and audio focus |
| 49 | Open the web UI in a second browser and change its layout | Each keeps its own Screen; neither follows the other |
| 50 | The next day, start the shell | Yesterday's tiles are still there: a game no longer on the slate keeps its tile until cleared, and a stream tile may load a channel now showing something else. Clear them by hand (known, until persistence is designed) |
| 51 | Removed with telemetry ([ADR 0019](adr/0019-telemetry-goes.md)) | – |
| 52 | Removed with telemetry ([ADR 0019](adr/0019-telemetry-goes.md)) | – |
| 53 | Reconnect FastCast (cut the network briefly) with several games live | Their checkpoints load together: "Checkpoint duration" shows them overlapping, and plays resume for every game within one checkpoint's time |
| 54 | Install a release build on Windows (VMP-signed) and on Linux (the `.deb`), sign in to YouTube TV, and play a game in a tile | The video plays in each; on Windows a build without the VMP signature is refused by the player, a signed one is not |
| 55 | With the installed app running, scan Join Remote's code from a phone on the home network | The Remote page loads from the embedded Hub (Windows asks once to let Sportal through its firewall) |

Record the date, the build, and any row that failed.

## Eye-check: UI overhaul

| # | Do | Expect |
| --- | --- | --- |
| 56 | Switch between Glass and Team in the ribbon, the full guide, a stats page and a stats tile | Each reads clearly in both themes; Team paints in the teams' colors |
| 57 | In the desktop shell, open the ribbon and the full guide while videos play | The ribbon docks under the Screen and every video keeps playing, resized |
| 58 | Focus a player (a YouTube custom tile), then press the arrow keys with the guide closed and with it open | Closed: the player gets them (seek). Open: they move the guide |
| 59 | Add a YouTube video and a YouTube playlist; play each in the shell and in a browser | Both play in the shell (watch page) and in the browser (embed; no autoplay expected) |
| 60 | Put a live game's stats on a page and on a tile | Both update about every 30 s |
| 61 | Choose a highlight into a tile | It plays, muted until it has audio focus |
| 62 | Show a toast over a playing video, then cut the Hub | A toast hides only the strip of video it covers; the connection-lost toast clears when the Hub is back |
| 63 | Press `Ctrl`+`K`, run Add YouTube… and a Stats entry | Both work |
| 64 | From the Remote, move, solo and clear a custom tile | Each does what it says on the Display |
| 65 | Look at a ribbon chip inside its shelf row | The chip's height fits the row, with no clipping or gap |
| 66 | Open a game page and press the arrow keys and `PageDown` | The page scrolls |
| 67 | Open a stats tile with highlights and click a highlight card in it | The clip opens as it does from the guide |
| 68 | Open the full guide with Glass and watch the GPU (or the frame rate) | Glass's stacked blur costs no visible stutter; record the GPU cost if it does |
| 69 | Put a clip in a tile and reload the Display | The reloaded Display has no clip tiles |
| 70 | In the shell, select a playing tile and press `I`, then press `Ctrl`+`K` and type; close it, open the guide and choose Add YouTube by keyboard, and type a link | Typing reaches the palette's search and the YouTube form's fields, not the player |
| 71 | In the shell with videos playing, press `G` to open the full guide and `Esc` to close it, several times | Each time, the provider views resize behind the full guide without flicker, and are back in their tiles after `Esc`; record any view left out of place |
| 72 | On a Saturday morning with `SPORTAL_LINEUP_CHANNELS="News 3,WAVY 10"`, open the guide | The rail lists Channels after the leagues |
| 73 | Open Channels and look at ESPN's card | It shows College GameDay, its minutes left, and what is next |
| 74 | Look through the Channels shelf | News 3 and WAVY 10 are listed; HGTV is not |
| 75 | Select a tile, focus ESPN in Channels and press Enter | ESPN is on the selected tile and plays |
| 76 | Look at that tile's header | It reads "ESPN · College GameDay" |
| 77 | Reload the Display | The channel tile is kept |
| 78 | With no fresh guide (a fresh Hub with the shell not signed in, a guide older than 45 minutes, or a Hub that cannot be reached), open Channels | It shows "No sports channels: no fresh guide" |

Record the date, the build, and any row that failed.
