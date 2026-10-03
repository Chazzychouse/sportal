# Guide-Matched Channels — Design

Date: 2026-10-03
Status: Draft for review. The spike in section 0 has been run; nothing else is built
Follows: `docs/specs/2026-10-03-learned-channels-design.md` (learned channels; this replaces how channels
are found), `docs/adr/0002-desktop-shell-playback.md` (amended by this design, see section 6)

## Goal

A game clicked on the slate plays the right game with no manual step after the one-time sign-in: no
channel picks, no **Not on YouTube TV** presses, and no regional game shown in place of the one clicked.
The picking tile stays only as the fallback for when the guide cannot be read.

## Why learned channels is not enough

| Flaw | Evidence |
| --- | --- |
| People are asked what the data already says | On the 2026-10-03 FBS slate, 19 of 61 broadcasts are `Streaming` in ESPN's `geoBroadcasts` (ESPN+, MW+, Disney+). Each costs a **Not on YouTube TV** press |
| A fresh install needs a pick per network, at kickoff | The same slate has 15 distinct TV networks |
| A Channel is right but the game is wrong | The 2026-10-04 NFL slate has 7 CBS games, all `market: "National"`. A network has one Channel, so all 7 play the local affiliate's game |
| Network names do not match channel names | The local CBS is "News 3" in the guide, ESPN's "USA Net" is "USA", "CBSSN" is "CBS Sports Network" |
| What was learned never goes stale | A dropped add-on or a carriage dispute leaves a Carried channel that no longer plays |

## 0. What the spike found (2026-10-03)

A throwaway shell (`spikes/guide-capture`, not committed) opened `https://tv.youtube.com/live` on the
signed-in provider session and saved the page's own responses through the debugger protocol.

**Where the guide comes from.** `POST /youtubei/v1/browse` with `browseId: "FEunplugged_epg"`, JSON. The
first response covers about four hours from the current half hour (`initialEpgFetchDurationMs`
13,578,000) for every row; scrolling right loads continuation pages of about two hours
(`paginationDurationMs`) up to seven days ahead (`maxDurationMs`). Continuation rows carry only
`stationId` and airings.

**A row (`epgRowRenderer`)** is a station: `stationId` (stable, e.g. `UCPc5PkgTSfcJCi3-dJyg3Tg`), its
name in `icon.accessibility.accessibilityData.label` ("News 3", "ESPN2", "NFL ST - CBS"), and
`isDiscreteStation` (true for ESPN's overflow event channels). 55 rows for this account.

**An airing (`epgAiringRenderer`)** has `beginTimeMs`, `endTimeMs`, a title ("Ohio State at Iowa",
"Old Dominion vs. Georgia State"), a description, and `spoilerModeEntities` (the teams' entity ids).
An airing on now offers **Join live**: a `watchEndpoint` whose `videoId` is the station's channel
address with the live `params` `0gEEEgIwAQ%3D%3D`. For News 3 it is `y6zFA17zDsw`, the CBS address the
learned-channels observation recorded by hand. Airings not yet on have no watch endpoint.

**Sunday Ticket.** This account has seven "NFL ST - CBS" and five "NFL ST - FOX" stations. Every CBS and
FOX game of 2026-10-04 is listed, each on its own station, at its kickoff.

**Matching by title alone** (a throwaway matcher: both teams named in the title by location, short
name, or display name, airing starting within 45 minutes of kickoff), against the ESPN recordings:

| Slate in the guide's first page | Result |
| --- | --- |
| 12 FBS games on TV | 11 matched to one airing; 1 tie (Miami at Clemson on "ABC 13" and "ACC Network", ESPN says ABC) |
| 7 FBS games streaming only | No airing; correctly not carried |
| 12 NFL CBS and FOX games, 2026-10-04 | 12 matched, each to its own "NFL ST" station |
| Late FBS games and night NFL games | In the continuation pages, not the first; their kickoff is past the first page's end |

No network name was compared to make any match.

**Cost.** The guide page autoplays a muted preview: 202 video requests in about two minutes. A guide
kept open uses a stream and bandwidth the whole time.

**Account data.** The payload names the account's local stations, which reveal its home market.

## The idea

```
ESPN slate (teams, kickoff, broadcasts with TV/Streaming)
        │
        ▼
  guide.availabilityOf(game)  ◄──  Guide: channels (station id, name) and airings
        │                          (title, begin, end, live address when on now)
        ▼                          read by the shell from the guide page's own response
ChannelAvailability: Carried | Upcoming | NotCarried (with reason) | Unlearned (fallback)
```

## Decisions

| Question | Decision |
| --- | --- |
| Where guide data comes from | The guide page's own `FEunplugged_epg` response, observed by the shell through the debugger protocol. Nothing is injected, no request is changed or made, video is not touched. ADR 0002 is amended (approved 2026-10-03) |
| What a Channel is | A station in the source's guide, keyed by its station id, with the name the guide gives it. It is no longer keyed by network |
| What decides a game | The airing whose title names both teams and that begins near kickoff. Network names only break ties |
| Where a channel's address comes from | The **Join live** endpoint of the station's airing on now. No pick |
| Streaming-only broadcasts | Not carried without asking, from ESPN's broadcast type, when no airing matches |
| Keeping the guide open | Never: the reader opens the guide, takes its first guide response, and closes it, because the guide plays a preview |
| How fresh | Re-read every 15 minutes while the shell runs, and at once when a tile waits on an airing that should now be live |
| Manual pick and **wrong channel** | Kept as overrides that beat the matcher, and as the whole answer while no guide has been read |
| If the guide response changes shape | `GuideUnreadable`; the Hub keeps the last guide it read and the picking tile is the fallback. A listings service stays the named fallback (approved 2026-10-03), not designed here |

## Design

### 1. Domain (`packages/domain`)

**`Game.ts`**

- `Broadcast` — `{ network: Network, medium: "tv" | "streaming" }`, the fact that a network is airing a
  game (existing glossary row). `GameSnapshot.broadcasts` becomes `Array<Broadcast>`.
- `Side` keeps the team's `location` and `shortName` as ESPN reports them, which the matcher compares.

**`Source.ts`**

- `ChannelId` — a branded string, the source's own id for a channel (YouTube TV's station id).
- `Channel` — `{ id: ChannelId, name: string, source: SourceName }`. Its address is not on it: a
  channel's live address is known only while the guide shows an airing on now.
- `Airing` — `{ channel: ChannelId, title: string, begin: DateTime.Utc, end: DateTime.Utc,
  live: Option<StreamLocator> }`: one programme on a channel. `live` is the channel's address when the
  airing is on now.
- `Guide` — `{ source, readAt, covers: { from, to }, channels, airings }`: one reading of a source's
  guide.
  - `availabilityOf(game, overrides: ChannelLineup): ChannelAvailability`, in this order:
    1. An override in the lineup for one of the game's networks (a manual pick or not-carried press).
    2. Airings that match the game. One wins: the one whose channel name contains one of the game's
       network names (normalized), then the first in guide order. If it is on now: `Carried { channel,
       locator }`. If it is not on yet: `Upcoming { channel, begin }`.
    3. No airing matches, and the guide covers the kickoff: `NotCarried`, with reason `StreamingOnly`
       when every broadcast is streaming, else `NotInGuide`.
    4. The guide does not cover the kickoff: `Upcoming` with no channel yet.
    5. No guide read yet: the lineup's own answer, which is today's behaviour (`Unlearned` opens the
       picking tile).
  - **An airing matches a game** when it begins within 45 minutes of kickoff, or is on now while the
    game is live, and its title names both teams. A team is named by its location, short name, or
    display name, compared as whole words, case-folded, with punctuation removed and "&" read as "and".
- `ChannelAvailability` gains `Upcoming { channel: Option<Channel>, begin: Option<DateTime.Utc> }`;
  `Carried` carries `{ channel, locator }`; `NotCarried` gains `reason: "NotInGuide" | "StreamingOnly"
  | "Recorded"` (`Recorded` is a manual not-carried press).
- `ChannelLineup` keeps the overrides people record by hand. Its `availabilityOf` remains only for
  step 5.

**`Stage.ts`**

- A stream tile keeps its `Channel` and locator. An `Upcoming` game is a data tile that names where and
  when it will play ("On NFL ST - CBS at 1:00 PM"); `stage.refresh` turns it into a stream tile when a
  later guide shows the airing on now.

### 2. Desktop shell (`apps/desktop`)

- **`GuideReader`** — opens a hidden, muted view on the provider session at the live guide, attaches the
  debugger to that view only, enables network events, and waits for the first response to
  `/youtubei/v1/browse` whose request names `FEunplugged_epg`. It publishes that body unchanged, then
  closes the view. A read that sees no guide response in 30 seconds closes the view and logs it.
- It sends no debugger command other than enabling network events and reading that one response's
  body, never reads another view, and never touches stream tiles. The shell does not decode or judge
  the payload.
- It reads on start, every 15 minutes, and when the web UI asks.
- **Bridge:** `ShellBridge.onGuideRead(listener: (payload: string) => void): () => void` and
  `ShellBridge.readGuide(): void`. The web UI forwards payloads to the Hub, as it does with channel
  picks; the shell never calls the Hub.

### 3. Hub (`apps/hub`)

- **`source/YouTubeTv.ts`** decodes a guide payload into a `Guide`, test-first against recorded
  payloads, as the ESPN adapter decodes the scoreboard. Rows without a label, airings with negative
  times (seen in the spike), and continuation pages are tolerated.
- **`Source`** port gains `guide: Effect<Option<Guide>>` and `readGuide(payload): Effect<void,
  GuideUnreadable>`; `changes` also emits when a new guide is read. The last guide is kept in memory;
  the channel store keeps the overrides as it keeps carriages today.
- **`StageSessions`** builds `availabilityOf` from the guide and the lineup. `stage.refresh` already
  re-resolves every tile on a change, so an upcoming tile starts playing when the guide read after
  kickoff shows its airing live.
- **API:** `POST /api/guide` with the raw payload; `GuideUnreadable` (422) when it does not decode,
  logged with the payload's size only.
- **Live message:** the Hub tells clients when a tile waits on an upcoming airing whose begin has
  passed, so the web UI asks the shell to read the guide again.
- **ESPN adapter:** decodes `geoBroadcasts` into `Broadcast` (`TV` → `tv`, `Streaming` → `streaming`,
  radio dropped) and keeps each team's `location` and `shortDisplayName`.

### 4. Web UI (`apps/web`)

- Forwards `onGuideRead` payloads to `POST /api/guide`; calls `readGuide` when the Hub says a tile is
  waiting.
- A data tile says why: "Streaming only (ESPN+)", "Not in your YouTube TV guide", "On NFL ST - CBS at
  1:00 PM".
- The picking tile is unchanged and appears only when no guide has been read.

### 5. Language (`CONTEXT.md`)

New rows: **Guide** (one reading of a source's listing of the channels this account gets and what
each airs), **Airing** (one programme on a channel, with its begin and end, and its live address while
it is on), **Guide unreadable**, **Guide reader** (the shell component that reads the guide page's
own response). **Channel** becomes "a station in a source's guide, as that source names it".
**Broadcast** gains its medium. **Channel availability** gains upcoming. **Channel lineup** narrows to
"the carriages people have recorded by hand, which override the guide".

### 6. ADR 0002 amendment

"Provider pages are loaded unmodified" stands. Added: the shell may open a hidden guide view and
observe it through the debugger protocol, to read the guide page's own `FEunplugged_epg` response; it
injects nothing, changes and issues no requests, and closes the view after the read because the
guide plays a preview.

## Manual steps that remain

| Step | When |
| --- | --- |
| Sign in to YouTube TV | Once |
| Pick a channel | Only while no guide has been read (guide unreadable) |
| Press **wrong channel** | Only after a wrong match; it becomes an override |

## Testing

- **Fixtures:** two recorded guide payloads (Saturday FBS window, Sunday NFL window), reduced to the
  rows and airings the tests use. See the open question on account data.
- **Domain, test-first:** `Guide#availabilityOf` for each step: override wins; one match, on now and
  upcoming; a simulcast tie broken by network name ("ABC 13" for ABC); a tie with no network hint
  takes guide order; streaming only; not in guide; kickoff past what the guide covers; no guide.
  Team naming: "&" in "Texas A&M", "vs." titles, a team named only by location.
- **Match rate, against recordings:** the 2026-10-03 FBS and 2026-10-04 NFL slates against guides
  recorded in the same windows. Each game's expected availability is asserted. The spike's figures
  above are the floor.
- **Guide decoding:** the recorded payloads decode; a payload without guide rows is `GuideUnreadable`.
- **`GuideReader`:** with Electron mocks: publishes only the `FEunplugged_epg` response, closes the
  view after it, closes it after the timeout with nothing published.
- **By hand (game-day checklist):** on a fresh data directory, signed in, click one game per network in
  a Saturday window: each plays or shows a reasoned data tile, and no guide ever shows in a tile. On an
  NFL Sunday, click two CBS games: each plays its own game. Watch the stream count while the reader
  runs.

## Open questions

- **Account data in fixtures.** The guide names this account's local stations and so its home market.
  Commit reduced fixtures as they are, or rename the local stations in them?
- **Stream budget.** A guide read plays a preview for a few seconds. Whether that counts against the
  concurrent-stream limit is unknown; if it does, a read while three tiles play may fail or stop one.
- **A station's live address over time.** News 3's address matched the one recorded hours earlier.
  Whether an "NFL ST" station keeps one address across games is seen on the first Sunday.

## Out of scope

- The listings-service fallback beyond naming it.
- Sources other than YouTube TV, and choosing between sources for one game.
- Using the guide for the Director (auto-fill from what is airing).
