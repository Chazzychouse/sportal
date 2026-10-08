# Sportal — Product Plan

> A web application for **tracking** live football and **multi-viewing** several games at once.
> The first review's answers are in [Decisions](#8-decisions-from-review-1). Architecture lives in [technical-spec.md](./technical-spec.md).

## 1. Vision

On a football Saturday or Sunday there are more good games than screens. Sportal answers two questions continuously:

1. **What is happening right now, everywhere?** (tracking)
2. **What should I be watching, and can I see it without fiddling?** (multi-viewing)

The product is the combination: a live slate that knows game state, wired to a multi-tile viewing surface that can react to it ("Game X just entered the red zone in a one-score game — promote it to the big tile").

It is a personal tool: one person, several devices on one home network — a desk with monitors, a TV driven by a PC, and a phone in hand.

## 2. The streaming reality

**YouTube TV cannot be embedded in an ordinary web page.** There is no public API or embeddable player, the site forbids being framed, and every stream is Widevine DRM-protected. ESPN, Peacock, Paramount+, and Prime Video are the same.

**Chosen approach: a desktop shell.** A desktop app whose tiles are the real provider web players. You sign in yourself inside it; the provider's own player does playback; Sportal controls only where each player sits, what it is tuned to, and whether it is muted. DRM is untouched and nothing is recorded or re-streamed.

- This is an unofficial client UI and therefore a terms-of-service grey area. It is acceptable only because this is personal use of your own subscription; it would need rethinking before anyone else used it.
- Everywhere the shell is not running (phone, a plain browser tab), Sportal is the full tracker and "Watch" is a deep link into the provider.
- **Fallbacks** if the shell proves unworkable: a browser extension that tiles provider windows, or deep links only. The tracker is unaffected either way.

Explicitly **out of scope, permanently**: defeating DRM, capturing or re-streaming provider video, credential sharing, pirate streams.

To verify by spike before building on it: YouTube TV's simultaneous-stream cap (three per membership by default, as far as I know), whether several players in one app session are tolerated, and whether Google sign-in works inside the shell.

## 3. Devices and roles

| Role | Device | What it does |
| --- | --- | --- |
| **Hub** | One machine on the network (later, optionally, a cloud host) | Polls game data, holds your follows/presets/rules, owns the state of every Screen, serves all other devices |
| **Display** | Desk PC with monitors; PC or mini-PC attached to a TV | Runs the desktop shell and shows a Screen with real video |
| **Remote** | Phone, tablet, or any browser | Full tracker; controls a Display's Screen (assign, swap, audio, layout) |

Desk and TV are equal citizens, so the interface has two presentation modes over the same features:

- **Desk mode** — dense, pointer and keyboard.
- **Couch mode** — large type readable from across a room, fully navigable with arrow keys/enter (a cheap remote or keyboard), with the phone as the comfortable way to do anything complicated.

## 4. Feature set

### 4.1 Tracking

- **Slate** — every game for a day or week, NFL and college (FBS): kickoff, teams, records and rankings, broadcast network, status.
- **Live game state** — score, period and clock, possession, down and distance, field position, red-zone flag, timeouts, last play.
- **Game detail** — scoring summary, drive chart, play-by-play, box score, team stats, win probability.
- **Standings and context** — NFL divisions and playoff picture; college conferences and rankings.
- **Follows** — teams, conferences, leagues, individual games; a "my slate" filter. Essential for college, where a Saturday has 50+ games.
- **Watchability** — one score per live game (closeness, time remaining, stakes, situation, your follows) that sorts the slate and drives automation.
- **Availability** — for each game, which of your sources can show it and on what channel.
- **Spoiler shield** — hide scores for chosen games; delay data per tile so the score never beats the picture.

### 4.2 Multi-viewing

- **Layouts** — 1, 2-up, 2×2, 1 big + 3 small, 1 + 5; rearrange; swap any tile with the main tile.
- **Tile content** — a stream, or a data tile (live gamecast for a game with no stream or no spare stream).
- **Audio focus** — exactly one tile has sound; move it by click, hotkey, or remote.
- **Score strips** — compact live score beside each tile from Sportal's own data.
- **Presets** — saved layouts with assignments ("Saturday noon", "Sunday early window").
- **Keyboard-first control** — number keys for tiles; hotkeys for swap, mute, fullscreen, layout.
- **Stream budget** — knows each source's concurrent-stream limit and fills remaining tiles with data tiles instead of failing.
- **Multiple displays** — desk and TV can each run their own Screen at once (sharing one stream budget per source).

### 4.3 Automation ("Director")

- **Alerts** — score change, red zone, turnover, one-score game late, overtime, upset brewing, followed team kicking off.
- **Auto-promote** — rules that move a game to the main tile or move audio when a trigger fires, then revert — a personal RedZone channel.
- **Auto-fill** — at kickoff windows, propose a layout from the best available games given follows and stream budget.
- **Manual always wins** — touching a tile suspends automation on it for a while.

### 4.4 After the core

Kept on the roadmap:

- **Phone as remote** — control any Display's Screen from the phone.
- **More sources** — ESPN, Peacock, Paramount+, Prime Video as additional web-player sources, so games not on YouTube TV still get a tile.
- **Betting lens** — enter your tickets; see them live across games; let them feed watchability and alerts.

Cut in review: other sports, fantasy lens, over-the-air tuner. The domain model stays sport-generic where that costs nothing, but nothing is built for them.

## 5. Game data

- **Primary:** ESPN's public scoreboard and summary endpoints — free, unofficial, undocumented, but rich (situation, win probability, broadcasts) and covering both NFL and FBS.
- **Supplement:** CollegeFootballData (free tier, API key) wherever ESPN's college coverage has gaps — missing games, rankings, or conference data. The first college spike measures the gaps.
- Both sit behind one provider boundary, so the rest of the app never knows which feed a fact came from.

## 6. Roadmap

Each phase ends in something usable on a game day.

| Phase | Goal | Contents |
| --- | --- | --- |
| **0 — Spikes** | Kill the unknowns cheaply | Shell playback of several YouTube TV channels; stream-cap behaviour; feed fidelity across a live FBS Saturday and an NFL Sunday; broadcast-to-channel mapping |
| **1 — Thin vertical** | One click from slate to picture | Minimal NFL + FBS slate with live scores; click a game; it plays in a tile in the shell |
| **2 — Tracker** | Know what is happening | Full slate, live game state, game detail, standings, follows, watchability, availability; works on every device in a browser |
| **3 — Screen** | Watch several games properly | Layouts, audio focus, hotkeys, presets, score strips, stream budget, data tiles, desk and couch modes |
| **4 — Director** | Let it drive | Alerts, auto-promote rules, auto-fill, spoiler shield with per-tile delay |
| **5 — Reach** | More control, more games | Phone remote; additional streaming sources; betting lens |

The order of phases 1–3 is a recommendation and is asked about in the technical spec.

## 7. Success criteria and risks

**Success**

- On a game day, the slate shows every NFL and FBS game with live state no more than about 15 seconds stale.
- A game goes from the slate to a tile in one action — from the desk, the couch, or the phone.
- A four-tile Screen runs through a full game window without babysitting, within the stream budget.
- An auto-promote rule fires correctly on a real red-zone trip and reverts.
- Moving the Hub to another machine or a cloud host is configuration, not code.

**Risks**

| Risk | Impact | Mitigation |
| --- | --- | --- |
| YouTube TV blocks or degrades playback in the shell | The chosen multi-view approach fails | Spike first; fall back to extension or deep links; tracker unaffected |
| Concurrent-stream cap | Fewer video tiles than wanted, shared across displays | Stream budget with data tiles; additional sources add their own budgets |
| Unofficial feed changes or rate-limits | Tracker breaks mid-game | Provider boundary, recorded fixtures, polite polling, second feed for college |
| Provider terms of service | Account-level risk | Personal use, provider's own unmodified player, no redistribution |
| Data ahead of video | Spoilers | Per-tile delay |
| Hub exposed beyond the home network | Someone else controls or reads it | Local network only until real authentication exists; cloud move requires it |

## 8. Decisions from review 1

| Question | Decision |
| --- | --- |
| Viewing approach | Desktop shell |
| Audience | Just me — no accounts |
| Viewing surface | Desk and TV equally |
| Football scope | NFL and college (FBS) from the start |
| Optional features kept | College (now core), betting lens, phone remote, other streaming sources |
| Optional features cut | Other sports, fantasy lens, over-the-air tuner |
| Game data | Free ESPN endpoints; CollegeFootballData where ESPN has college gaps |
| Hosting | My machine, serving several devices on my network; built so the Hub can move to a cloud deployment easily |
