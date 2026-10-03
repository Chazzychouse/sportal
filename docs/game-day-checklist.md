# Game-day checklist

Provider playback cannot be tested automatically. Run this by hand during live games after any change
to `apps/desktop` or to how stream tiles are rendered.

Setup: Hub serving the built web UI, desktop shell running, signed in to YouTube TV.

| # | Do | Expect |
| --- | --- | --- |
| 1 | Open the shell | Slate lists today's NFL and FBS games, live first; header reads `live` |
| 2 | Watch a live game's row for a minute | Score and clock update without a reload |
| 3 | Click a live game on a mapped network | It plays in the selected tile within a few seconds, inside the tile |
| 4 | Fill all four tiles with mapped games | Tiles up to the stream limit play; note what the provider does past it |
| 5 | Press `audio` on each tile in turn | Exactly one tile is audible each time |
| 6 | Pick a game that is already on the Stage | It moves to the selected tile; it is never shown twice |
| 7 | Click a game on an unmapped network | Data-tile message, no video, nothing else disturbed |
| 8 | Press `clear` on a playing tile | Video and sound stop for that tile only |
| 9 | Resize and maximize the window | Every video stays inside its tile; score strips stay visible |
| 10 | Open the web UI in a normal browser on the same machine | Same slate and Stage; a change there changes the shell |
| 11 | Stop the Hub, wait, start it | Header shows `reconnecting…` then `live`; playing video is not interrupted |
| 12 | Quit and reopen the shell | Still signed in to the provider |

Record the date, the build, and any row that failed.
