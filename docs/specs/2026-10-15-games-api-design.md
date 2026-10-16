# Games API and a sport-neutral model

## Why

The client gets one message, `SlateChanged` on `/api/live`: the whole slate with each game's last ten plays, every
game's availability and classification, re-sent on any change and every 30 s. Nothing is filtered, nothing can be asked
for by game or by day, and the client sorts for itself (`StripCard.of`, `CommandPalette`). The bottom bar is being
removed and the UI reworked around four views: a game browser (filter and sort), light tiles (one game each), a game
detail (full play history), and a day view (other dates). The backend is reshaped to serve them.

Football is also in the core types, not just the adapter: quarter arithmetic in `GameSnapshot`, down-and-distance as
`Situation`, `Play` as the 17-case `FootballPlay`, `LeagueId` as `nfl | fbs`. Baseball and basketball must arrive as a
table row and a small decode each, not a second copy of football's model.

## Decisions

- Classification goes entirely: `Classifier`, `Classification`, `Moment`, and the football play analysis. Automation
  is rebuilt later on the new model.
- Every read is a query. Each has a plain `GET` and a `/live` SSE twin with the same parameters, which sends the
  current answer, then what changes.
- The server filters and orders. The client never sorts a list.
- Plays are a common core plus a per-sport `detail`, a tagged union by sport. A sport's detail can later become a union
  of play cases without touching the core or any other sport.
- This pass ships football on the new seam. MLB and NBA are follow-ups, each a league-table row plus its situation and
  detail decode, tested against payloads recorded when their games are on.
- The bottom bar (`SlateView`, `StripCard`, `PlaceBadge`, the strip's pick, drop and bench inputs) is deleted. The
  command palette remains the way to put a game on a tile until the new UI lands.

## 1. Domain model (`packages/domain`)

**League.** `LeagueId` is `nfl | fbs | mlb | nba`. `League.ts` holds one table giving each league its sport
(`football | baseball | basketball`) and display name.

**`GameSnapshot`**, one shape for every sport:

| Field | Meaning |
|---|---|
| `id`, `league` | As today |
| `startsAt` | Renamed from `kickoff` |
| `status` | `scheduled \| live \| break \| delayed \| final \| postponed \| canceled`; `halftime` becomes `break` (any stop between periods) |
| `period` | `Int`; for baseball, the inning |
| `clock` | `Option` of seconds left in the period; none for baseball |
| `statusText` | The provider's short status ("Top 7th", "Q3 4:12", "Halftime"), shown as is |
| `home`, `away` | Team, score, ranking, record, as today |
| `broadcasts`, `odds` | As today |
| `situation` | `Option<Situation>` |

**`Situation`**, a `Schema.TaggedUnion` by sport:

- `Football`: possession, down, distance, yardLine, homeTimeouts, awayTimeouts; keeps `inRedZone`, `goalToGo`, and
  gains the ball's spot (today's `GameSnapshot#ball`, `spotOf`, `BallSpot`).
- `Baseball`: half (`top | bottom`), outs, balls, strikes, runners on first, second, third.

Basketball gets a case once its adapter has something to send.

**`Play`**, one class for every sport: `id`, `sequence`, `period`, `clock`, `text`, `type: { id, text }` as the
provider spells it, `scoring`, `homeScore`, `awayScore`, optional `team`, and `detail`:

- `Football`: start and end spot (down, distance, yardsToEndzone, team) and yards; what the field drawing reads,
  including today's `offense` and `lostYards`.
- `Baseball`: outs, balls, strikes after the play.
- `Basketball`: no fields yet.

`Play.order` stays (by `sequence`).

**Ordering snapshots.** `isBehind` compares progress, then period, then less clock left, then the situation's own
tiebreak (baseball: half, then outs), then points, as today. Football's quarter arithmetic goes.

**`inPlay`** stays: live, and the clock, when there is one, has time left. A college overtime's clock arrives as none,
so its `fbs` special case goes with `timed`.

**`Game#playsChange(earlier)`** returns `Appended { plays }` when this game's plays are `earlier`'s with plays added at
the end, else `Reset`.

**Deleted:** `FootballPlay` and its 17 cases, `PlayOutcome`, `BigPlayKind`, `StopInText`, `bigPlay`,
`changesPossession`, `stopInText`, `gainsYards`; `GameSnapshot#timePlayed`, `inCrunchTime`, `inOvertime`, `timed`,
`margin`; `Classifier.ts`, `Classification.ts`, `Moment.ts`.

## 2. API (`packages/api`)

`/api/live`, `LiveMessage` and `SlateChanged` go. The `guide`, `host` and `displays` groups are unchanged. A `games`
group:

| Endpoint | Answer |
|---|---|
| `GET /api/games?date&league&progress&carried` | `{ date, games: ListedGame[] }` |
| `GET /api/games/live?…` | The same answer, then the whole answer again each time it changes, debounced |
| `GET /api/games/:id` | `ListedGame` |
| `GET /api/games/:id/live` | The same, then again each time that game or its availability changes |
| `GET /api/games/:id/plays?before&limit` | `{ plays, more }`, newest first; `before` is a `sequence`, `limit` defaults to 50 |
| `GET /api/games/:id/plays/live` | The latest page, then `Appended { plays }` or `Reset { plays }` (the latest page) |

- `ListedGame` is `{ snapshot: GameSnapshot, availability: ChannelAvailability[] }`, a new `CONTEXT.md` term. Lists
  never carry plays.
- `date` is a calendar day, defaulting to today in the Hub's time zone (a new `HubConfig` field). `league` and
  `progress` (`upcoming | live | over`) take several values and default to all. `carried=true` keeps games with a
  `Carried` or `Upcoming` availability from any source.
- Order is `GameSnapshot.watchOrder`: live, then upcoming by start, then over. No `sort` parameter until a view needs
  one.
- A day other than today never changes: its live twin sends once, then keep-alives.
- Availability is rechecked every 30 s, as today; a change re-sends the answers it is in.
- Errors: `GameNotFound` (404) for an id no listed day names; `ScheduleUnavailable` (503) when the provider cannot be
  reached for a day the Hub does not hold.

## 3. Hub

**Director.** The classifier, its expiry loop and moment logging go. It folds deliveries into the slate (today's
listed games, each with all its plays) and offers `slate: Stream<Slate>`. Play logging stays.

**Schedule** (`Schedule.ts`, new service) answers games for a day and finds a game by id:

- Today reads the Director's slate.
- Another day is `Provider.listing(league, date)`, a new port method, fetched on demand per league and held in
  memory: past days until restart, future days for 10 minutes.
- It records each listed game's league, so `GET /api/games/:id` for a game off today's slate fetches it with
  `Provider.game(league, id)` (snapshot and plays). An id no held day names is `GameNotFound`.

**Live twins** are each a stream for its one connection, derived from `Director.slate` (and `Source.availability`
every 30 s): the list maps, filters, orders, drops repeats and debounces; the game picks one game and drops repeats;
the plays stream applies `Game#playsChange` to each game version against the one before. `Broadcast.ts` goes.

**ESPN adapter.** Leagues become a table: league to ESPN sport/league path (`football/nfl`,
`football/college-football`, later `baseball/mlb`, `basketball/nba`) and FastCast topic prefix, with the situation
and play-detail decode for its sport. The scoreboard decode is shared. Polling and FastCast follow each league in the
table under today's cadence rules. `listing` and `game` read the same scoreboard and summary endpoints the poll loops
already read, with a date or an event id.

## 4. Web

The `live` atom goes. Three atom families, each opening its SSE only while read:

- `games(query)`: `CommandPalette`, `RemoteState`, `RemoteView`, `ScreenMap`; none of them sorts.
- `game(id)`: `TileBody`, `TileChrome`.
- `plays(id)`: `Field`, reading the football situation and play detail.

`GameStatus` shows `statusText`. Deleted: `SlateView`, `StripCard`, `PlaceBadge`, `MomentBadge`, and the strip's
pick, drop and bench inputs in `DisplayState`.

## Testing

- Domain, test-first: snapshot ordering per sport (football by clock; baseball by half, then outs);
  `Game#playsChange` appended and reset; query filtering and order.
- ESPN adapter: the recorded football payloads in `fixtures/`, decoded to the new shape.
- Hub: each endpoint and live twin through `HubServer` with `Provider.layerTest`: first answer, a change, a repeat
  dropped, `GameNotFound`.
- Rewritten tests: each commit body maps old test names to the new ones or to the behaviour removed.

## Phases

Each passes `pnpm check` and is committed on its own.

1. **Cut classification.** Remove the classifier and everything only it used; the strip orders by `watchOrder`.
2. **Sport-neutral model and ESPN adapter.** Domain types, league table, per-sport decode; football only. The wire
   still carries the one slate message.
3. **Games API, Schedule, live twins, and the web on the query atoms.** `/api/live` and the bottom bar go.

## Follow-ups

- MLB, then NBA: league-table row, situation and detail decode, recorded payloads, FastCast topics checked live.
- Automation rebuilt on the new model.

## The Hub API over one socket

**Why.** Each live query is its own server-sent event stream, so each is its own HTTP/1.1 connection, and Chromium
allows six per host. The Display holds today's list, each occupied tile's game, each live data tile's plays and its
input stream: a full Quad uses all six and MainFive needs more. Past the limit the report `PUT`s, the guide `POST`s
and some tiles wait for a connection that never frees.

**Decision.** The whole Hub API becomes RPCs (`effect/rpc`) over one WebSocket per page, at `/api/socket` on the Hub's
port: the live queries as stream RPCs, every other read and write as a request/response RPC, each keeping its error.
`SportalApi`, `HttpApiBuilder`, `HttpApiClient` and the errors' HTTP statuses go, and so does `effect/http-api`. Only two
things stay plain HTTP: the web UI's static files, since the page must load before it can open a socket and the
desktop shell waits for the Hub by retrying that load; and the socket's own upgrade request. The desktop shell does
not call the API, and no script or CI job does either.

**The group**, `HubApi` in `packages/api`, JSON over the socket (`RpcSerialization.layerJson`). Each stream sends its
current answer first, then each change, for as long as the client reads it.

| RPC | Payload | Answer | Error | Kind |
|---|---|---|---|---|
| `listLive` | `GamesQuery` | `GameList`, then each change | `ScheduleUnavailable` | stream |
| `gameLive` | `{ id }` | `ListedGame`, then each change | `GameNotFound \| ScheduleUnavailable` | stream |
| `playsLive` | `{ id }` | `PlaysChange`s, a `Reset` first | `GameNotFound \| ScheduleUnavailable` | stream |
| `inputs` | `{ display }` | `DisplayMessage`: `Registered`, then `Sent { input }` per Remote input | – | stream |
| `follow` | `{ display }` | `RemoteMessage`s | – | stream |
| `list` | `GamesQuery` | `GameList` | `ScheduleUnavailable` | request |
| `game` | `{ id }` | `ListedGame` | `GameNotFound \| ScheduleUnavailable` | request |
| `plays` | `{ id, before?, limit? }` | `PlaysPage` | `GameNotFound \| ScheduleUnavailable` | request |
| `readGuide` | `{ guide }` | – | `GuideUnreadable` | request |
| `health` | – | `{ version, startedAt }` | – | request |
| `addresses` | – | the LAN addresses | – | request |
| `report` | `{ display, report }` | – | `DisplayOffline` | request |
| `send` | `{ display, input }` | – | `DisplayOffline` | request |

`inputs` registers the Display while it runs, as its SSE stream did. Its first element tells the Display that the Hub
has registered it, a signal the SSE stream's opening used to give.

**The web.** `HubSocket` (`apps/web/src/hub/HubSocket.ts`) is the one socket, in the web runtime. It gives the socket's
`Connection` (connecting, connected, lost since an instant) from the RPC client's connection hooks; `live(query)`,
the query's stream, asked again each time the socket connects; and the typed `client` for requests. `HubClient`
keeps its members and calls through it, with `RpcClientError` in place of `HttpClientError`. `LiveStream.of` takes a
query instead of a URL. `Games.today` stays kept alive, and `Games.game(id)` and `Games.plays(id)` ask the Hub only
while read, ending their RPC on the Hub when nothing reads them. The top bar's pill shows the socket's connection. The
Remote page's today list and its follow share its own one socket the same way.

**Reconnecting.** The RPC client reopens a lost socket after 500 ms, then 1.5 times as long each time, up to 5 s, and
pings every 5 s, failing the socket on a missed pong. A lost socket fails every query on it and every request in
flight with `RpcClientError`. Each query asks again when the socket connects, and the Hub's first answer replaces
what the view held.

**Deleted.** Every `/api` HTTP route, with the SSE keep-alives and the server's `sse` helper; `SportalApi`; the web's
`ServerEvents.ts` and its `ServerEvent`; the JSON-string codecs that only SSE read (`GameListJson`, `ListedGameJson`,
`RemoteMessageJson`, `RemoteInputJson`). Curl checks become a small Node script over the socket.

**Phases.** Two commits. First the socket and the live streams, which fixes the connection limit. Then the requests,
which deletes the HTTP API.
