# Game-day checklist

Provider playback cannot be tested automatically. Run this by hand during live games after any change
to `apps/desktop` or to how stream tiles are rendered.

Setup: Hub serving the built web UI, desktop shell running, signed in to YouTube TV.

| # | Do | Expect |
| --- | --- | --- |
| 1 | Open the shell | Slate lists today's NFL and FBS games, live first; header reads `live` |
| 2 | Watch a live game's row for a minute | Score and clock update without a reload |
| 3 | With a fresh `.sportal/` data directory, open the shell and watch its terminal | No `GuideReader:` warning; within a minute the Hub log shows no `could not be read` |
| 4 | Click a live game on a network never used before | It plays within a few seconds, with no guide shown in the tile |
| 5 | Click another game on the same network | It plays at once, with no guide |
| 6 | Fill all four tiles with games on learned networks | Tiles up to the stream limit play; note what the provider does past it |
| 7 | Press `audio` on each tile in turn | Exactly one tile is audible each time |
| 8 | Pick a game that is already on the Stage | It moves to the selected tile; it is never shown twice |
| 9 | Click an ESPN+ game, press **Not on YouTube TV** | Data-tile message, no video; the next ESPN+ game is a data tile at once |
| 10 | On a playing tile, press **wrong channel** | The tile returns to the guide for that network |
| 11 | Press `clear` on a playing tile | Video and sound stop for that tile only |
| 12 | Resize and maximize the window | Every video and guide stays inside its tile; score strips stay visible |
| 13 | Open the web UI in a normal browser on the same machine | Same slate and Stage; a stream tile shows an "Open in YouTube TV" link and a picking tile an "Open the guide" link instead of video; a change there changes the shell |
| 14 | Stop the Hub, wait, start it | Header shows `reconnecting…` then `live`; video keeps playing while the Hub is down; when the Hub returns the Stage is empty again, because the Stage is not saved yet |
| 15 | After the Hub restart, click a game on a network learned earlier | It plays at once, with no guide: learned channels are saved |
| 16 | Quit and reopen the shell | Still signed in to the provider |
| 17 | Once, after a channel's programme changes, click a game on that network | It plays the channel live, showing the new programme (first passed 2026-10-03). If it plays the old programme or fails, record it: a Channel is kept per network on the strength of this row (see ADR 0002) |
| 18 | Open the shell and watch its terminal while the Hub page loads | No `refused shell navigation` warning for the Hub's own frames (the subframe guard could refuse an `about:blank` frame) |
| 19 | Press **Sign in to YouTube TV**, sign in, close the window | Every tile plays without signing in again; the sign-in survives a shell restart |
| 20 | Click a game kicking off in more than half an hour | The tile reads "On <channel> at <time>"; it plays on its own within two minutes of that time |
| 21 | On an NFL Sunday, click two CBS games at 1:00 PM | Each plays its own game, each on its own "NFL ST - CBS" station |
| 22 | Click an ESPN+ game | "Streaming only: not on YouTube TV", with no picking tile |
| 23 | With three tiles playing, wait for a guide read (or reopen the shell) | All three keep playing through the read; record anything the provider shows about the stream limit |
| 24 | During a read, look for a window or sound | None: the guide view is never shown and is muted |

Record the date, the build, and any row that failed.
