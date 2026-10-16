# 18. The autopilot and the prompts go; automation is designed again

Date: 2026-10-15
Status: Accepted

## Context

Sportal is being trimmed to its core for a first installable build: the slate, the Screen, the shell's stream tiles
and the Remote. Two Display features sat on top of the Hub's classifications and were not part of that core.

- The autopilot followed the classifications on a Display: it ranked the games on its tiles, promoted the best into
  the main tile after a dwell, moved the sound with it, fitted the layout under a ceiling, and stood back for a while
  after each command of yours. Every command of yours went through it, so the Display, the Remote link and their tests
  all knew of it.
- The prompts asked, in the top bar and on the Remote with a chime, whether to bring a game on no tile into the main
  tile, with their own hotkeys (`A`, `P`, `Y`, `N`), their own state and the dismissed games.

Both were still being tuned (the game-day cuts changed how a game beats another), and their rules shaped the Display,
the Remote report and the hotkeys.

## Decision

Remove the autopilot and the prompts, and everything that existed only for them: `apps/web/src/autopilot/`,
`apps/web/src/prompts/`, the Remote's prompt and chime, their hotkeys, and their fields of the Remote report. A screen
command of yours goes straight to the Screen.

The Hub's Classifier stays, with each game's moment and score: the slate strip orders its Live games by score and
shows each game's moment badge.

Automation is designed again on top of the classifications, as a new design rather than a restoration of this one.

## Consequences

- A Display does only what a person tells it. The Remote reports only its Screen.
- `A`, `P`, `Y` and `N` are free keys.
- The old code and its designs stay in git and in `docs/specs/` for the redesign to read.
