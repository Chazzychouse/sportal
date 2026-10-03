# Game-day checklist

Provider playback cannot be tested automatically. Run this by hand during live games after any change
to `apps/desktop` or to how stream tiles are rendered.

Setup: Hub serving the built web UI, desktop shell running, signed in to YouTube TV.

| # | Do | Expect |
| --- | --- | --- |
| 1 | Open the shell | Slate lists today's NFL and FBS games, live first; header reads `live` |
| 2 | Watch a live game's row for a minute | Score and clock update without a reload |
| 3 | With a fresh `.sportal/` data directory, open the shell and watch its terminal | Once the Hub page shows, a game live on a TV network in your guide plays when clicked (as row 4); no `GuideReader:` warning in the shell, no `could not be read` warning in the Hub log |
| 4 | Click a live game on a TV network in your YouTube TV guide | It plays within a few seconds; no guide and no channel picking appear in the tile |
| 5 | Click another game on the same network | It plays at once, with no guide |
| 6 | Fill all four tiles with games on TV networks in your guide | Tiles up to the stream limit play; note what the provider does past it |
| 7 | Press `audio` on each tile in turn | Exactly one tile is audible each time |
| 8 | Pick a game that is already on the Stage | It moves to the selected tile; it is never shown twice |
| 9 | Click an ESPN+ game | "Streaming only: not on YouTube TV", with no picking tile and no video; the next ESPN+ game is a data tile at once. Fallback (plain browser, or no guide read yet): the tile offers **Not on YouTube TV**; pressing it gives a data tile |
| 10 | Fallback (plain browser, or no guide read yet): on a tile whose channel was picked by hand, press **wrong channel** | The tile returns to the guide for that network; the button never appears on a guide-matched tile |
| 11 | Press `clear` on a playing tile | Video and sound stop for that tile only |
| 12 | Resize and maximize the window | Every video and guide stays inside its tile; score strips stay visible |
| 13 | Open the web UI in a normal browser on the same machine | Same slate and Stage; a stream tile shows an "Open in YouTube TV" link instead of video; while the shell has read a guide in the last 45 minutes, tiles there are guide-matched as in the shell; only with no guide read (or the last one stale) is a game's tile a picking tile with an "Open the guide" link (hand-picked fallback); a change there changes the shell |
| 14 | Stop the Hub, wait, start it | Header shows `reconnecting…` then `live`; video keeps playing while the Hub is down; when the Hub returns the Stage is empty again, because the Stage is not saved yet |
| 15 | After the Hub restart, click a game on a network | It plays once the shell's next guide read lands (the guide is kept in memory only); until then a hand-picked channel, if one was picked earlier, plays at once: hand-picked channels are saved |
| 16 | Quit and reopen the shell | Still signed in to the provider |
| 17 | Once, after a channel's programme changes, click a game on that network | It plays the channel live, showing the new programme (first passed 2026-10-03). If it plays the old programme or fails, record it: a hand-picked channel is kept per network on the strength of this row (see ADR 0002) |
| 18 | Open the shell and watch its terminal while the Hub page loads | No `refused shell navigation` warning for the Hub's own frames (the subframe guard could refuse an `about:blank` frame) |
| 19 | Press **Sign in to YouTube TV**, sign in, close the window | Every tile plays without signing in again; the sign-in survives a shell restart |
| 20 | Click a game kicking off in more than half an hour | The tile reads "On <channel> at <time>"; it plays on its own within two minutes of that time |
| 21 | On an NFL Sunday, click two CBS games at 1:00 PM | Each plays its own game, each on its own "NFL ST - CBS" station |
| 22 | Click an ESPN+ game | "Streaming only: not on YouTube TV", with no picking tile |
| 23 | With three tiles playing, wait 5 minutes for a guide read | All three keep playing; the read plays nothing and the Hub logs `YouTubeTv: read a guide of …` |
| 24 | During a read, look for a window or sound | None: a read opens no view |
| 25 | During a game that runs past its listed time (overtime, a long review), wait through the guide reads after its airing ends | The tile keeps playing; it never turns into a data tile while the game is on |
| 26 | In YouTube TV, set the live guide's sort to Custom, then wait 5 minutes for a read | The Hub logs fewer channels; games on hidden channels are "Not in your YouTube TV guide". Set the sort back to Default |

Record the date, the build, and any row that failed.
