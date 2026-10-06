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
| 27 | Fill four tiles with live streams, then promote tile 4 (`Shift`+`4`) | Tile 4's video slides into the main tile while it plays and takes the sound; neither player reloads or goes black |
| 28 | Press `L` through every layout and back to Quad | Tiles move with their video; shrinking benches games (listed under the slate) and growing restores each to its place |
| 29 | Click into a playing stream, then press `2`, `F`, `Esc` | Sound moves to tile 2; the selected tile solos and unsolos; YouTube TV does not seek |
| 30 | Type in a picking tile's guide search box | Every key reaches the guide; none acts as a hotkey |
| 31 | Drag a divider across a playing video | The video tracks the divider live; on release the split holds and survives a reload |
| 32 | Press `F11`, then solo a tile | Top bar and slate hide; the soloed game fills the screen; `Esc` and `F11` undo each in turn |
| 33 | Open the command palette (`Ctrl`+`K`) | Only the videos under the palette blank, with sound still on; they return when it closes |
| 34 | Drag a benched game onto a tile's header | The two swap; the benched game's player starts, the other's closes |
| 35 | Run `SPORTAL_SCENARIO=two-minute-drill-tie SPORTAL_SCENARIO_SPEED=10 pnpm dev`, fill four tiles from the strip | Each tile plays a synthetic stream: colour bars moving, its game's score and clock ticking; no sign-in, no picking tile. Moving audio focus (`1`–`4`) moves the tone you hear. `tie-uga-ala` shows RED ZONE about 12 seconds in and goes final about 22 seconds in |
| 36 | During a live window, hover the score badges on the strip | Live games carry a score; the closest late game is highest; a game at halftime or in a TV break shows its badge dimmed; the tooltip gives reasons that match the game |
| 37 | With two games playing, rest and move the pointer over each video | No YouTube TV title or controls appear on either |
| 38 | Click a video that is not the selected tile | That tile becomes selected; playback does not pause or change |
| 39 | Select a playing tile and press `I`, then use the player's controls with the mouse | The controls appear and work on that tile only; the other tiles still show no controls |
| 40 | Press `I` again, or select another tile | The player stops getting the mouse; hovering it shows nothing again |
| 41 | With Docker running, run `pnpm telemetry`, then a scenario at 10× with `SPORTAL_OTLP_URL=http://localhost:4318`, and open the Hub dashboard (`localhost:3000`, folder Sportal) | The dashboard fills; a poll's trace shows its provider calls; logs filter by mode |
| 42 | With a game live, run `pnpm telemetry` and the Hub with `SPORTAL_OTLP_URL=http://localhost:4318`, and open the Game actors row of the Hub dashboard (mode `live`). Then check staleness: cut the network for two minutes (Wi-Fi off or cable out), then restore it. A scenario cannot do this, since it keeps answering with its last frame | Live games by state fill; a game that stops updating turns stale about 90 seconds later and live again on its next snapshot (`Live → Stale` about 90 s after the cut, `Stale → Live` on the first poll after the network returns); one game's transitions read in order in its logs panel (type its id into **Game**) |
| 43 | Solo a tile, open the key help, press `Ctrl`+`K` | Only the palette is open. `Esc` closes it; a second `Esc` unsolos |
| 44 | Select tile 4 in Quad, switch to Single from the Remote | The one tile is selected, and a drop goes into it |
| 45 | Solo a tile, press `?`, then `Esc` | The key help closes and the tile stays soloed |
| 46 | After a real game day, record it with the recorder into `fixtures/espn-recordings/<date>/<league>/` (never `~/.cache`), then cut its moments with `pnpm --filter @sportal/hub scenario:cut` | The recording folder holds the day's polls; each cut writes `fixtures/scenarios/<name>.json` with more than one frame, every named game in every frame |
| 47 | During a live NFL game with `pnpm telemetry` and the Hub on `SPORTAL_OTLP_URL=http://localhost:4318`, open the Live feed row of the Hub dashboard (mode `live`) | Connected shows 1; `P` messages for `nfl` arrive about every few seconds and `B` every 10 s; Errors by reason is empty. Snapshots shows push `taken` and poll `behind`. One game's `Ingest.push` trace in Tempo has its `GameActors.receive` children |

Record the date, the build, and any row that failed.
