# 15. Each Display owns its Screen

Date: 2026-10-09
Status: Accepted. Supersedes 0003.

## Context

ADR 0003 put the Screen in the Hub so a phone could change what a TV shows and automation could change the Screen
while no client was focused. Automation does not exist yet, the Remote is parked, and one shared Screen contradicts
the product plan, where each Display runs its own. The Hub also chose which source's answer won for a game.

## Decision

The Hub publishes the slate, each game beside every source's answer for where it can be streamed. Each Display owns
its Screen: it applies screen commands, refreshes its tiles from each slate, and chooses between sources. The Screen
module lives in the web app.

## Consequences

Two sources for one game are two answers, not a conflict the Hub settles. A command costs no round trip. A Display keeps
its Screen in its browser until persistence is designed, so a Screen outlives the day: a game no longer on the slate keeps its tile until someone clears it. When automation
comes, the Hub delivers a ranking of games by watchability, not screen commands, and each Display decides how its
layout shows it. A stream budget shared across Displays will need the Hub's coordination; the Remote comes back with
its own design.
