# Guide-Matched Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A game clicked on the slate plays the right game with no manual step after the one-time sign-in. The Hub finds each game's channel by matching it to an airing in YouTube TV's own guide, read by the shell from the guide page's response, instead of asking the user to pick a channel per network.

**Architecture:** ESPN's broadcasts gain their medium (TV or streaming) and its teams their location and short name. A new domain `Guide` (one reading of a source's guide: channels with their live address, and airings) resolves each game's `ChannelAvailability` by title and time. The availability now also says when a game is still to come, and why a game has no stream. The Hub's YouTube TV source decodes guide responses (`POST /api/guide`) and answers availability from its latest guide, falling back to the hand-learned lineup until one is read. A new shell component, `GuideReader`, opens the guide in a hidden view, reads the page's own guide response through the debugger protocol, and closes the view. The web UI relays each read to the Hub and asks for a fresh read when a waiting game should have started.

**Tech Stack:** TypeScript 6, Effect 4.0.0 (`effect`, `effect/http-api`, `effect/testing`), React 19, Electron 44 (castlabs Widevine build), Vitest 5, Biome 2.5, dependency-cruiser 18, knip 6.

**Spec:** `docs/specs/2026-10-03-guide-matched-channels-design.md` (draft; this plan's review settles it).

**Status of the code in this plan:** proposed, not yet built. Every code block is written against `main` at `cccb29b` and has not been compiled or run. The numbers asserted in Task 4's match test were computed from the recorded payloads with a throwaway script that applies the same rules; if the TypeScript gives different numbers, stop and reconcile rather than edit the expectations. The guide reader can only be proven against real YouTube TV, which Task 8's game-day rows do.

## Global Constraints

- Read `AGENTS.md` before every task. Its rules on file layout and in-file order are requirements, not style.
- Effect is pinned to exactly `4.0.0`. Do not write Effect code from memory; consult `node_modules/effect/ai-docs/src/` and the sources under `node_modules/.pnpm/effect@4.0.0/node_modules/effect/src/`.
- Node 24 via `mise` (`mise exec -- <command>` if your shell has not activated mise).
- `pnpm check` must pass before every commit.
- Every exported type name is a term in `CONTEXT.md`. A new term gets its row in the same commit.
- An operation on a domain type is a method or static of its class. No exported loose functions over a domain type.
- In the Hub, only `main.ts` and tests name concrete adapters.
- Provider web players are loaded unmodified. The one addition (ADR 0002, amended in Task 8): the shell may open a hidden guide view and read, through the debugger protocol, the body of the guide page's own `FEunplugged_epg` response. It never injects, never changes or makes a request, never reads any other view, and closes the guide view after each read because the guide plays a preview.
- A channel's live address is `https://tv.youtube.com/watch/<id>?vp=0gEEEgIwAQ%3D%3D`.
- Matching rules, from the spike: an airing matches a game when it begins within 45 minutes of kickoff, or is on at the reading while the game is live, and its title names both teams (location, short name, or full name; whole words; case-folded; punctuation dropped; "&" read as "and"). A guide reading is complete for 3 hours past `readAt`. A matched airing on a channel with a live address that begins no later than 30 minutes past `readAt` is carried; otherwise it is upcoming.
- The guide reader reads when the web UI asks, then every 15 minutes; reads are at least 2 minutes apart; a read that sees no guide response in 30 seconds gives up.

## Where this plan differs from the spec

For review with the plan.

- **The live address is on the guide's row, not its airings.** Rows carry `navigationEndpoint.watchEndpoint.videoId`, the station's live channel id, whenever the station is on air (39 of 54 rows in the spike; absent for the off-air "NFL ST" and "NBCSN Extra" rows). So `Guide` channels carry `live`, and `Airing` has no address (Task 3). The spike's per-airing **Join live** popups are not read.
- **A carried game plays from up to 30 minutes before its airing.** A matched airing on a live channel that begins within 30 minutes of the reading is carried at once, so a clicked game shows its pregame instead of a waiting tile (Task 3).
- **When the guide decides, the hand-learned lineup does not.** The spec put manual overrides first. Here the lineup answers only while no guide has been read, and **wrong channel** appears only on tiles whose channel was picked by hand. A per-game correction for a wrong guide match is left until a wrong match is seen; the match test (Task 4) guards against one. Mixing per-network overrides into guide matching would send every Sunday Ticket CBS game to one station (Tasks 3, 7).
- **A Channel no longer names a network.** `Channel` becomes `{ name, source, locator }` ("News 3", not "CBS"), a carriage names its network beside its channel, and a stream tile records `learnedFor` when its channel was picked by hand (Task 2).
- **Why a game has no stream travels on the data tile** as `why`: `NoStream`, `StreamingOnly`, `NotInGuide`, or `NotYet { channel?, begin? }`. No new tile kind (Task 3).
- **The Hub does not announce waiting tiles.** The web UI already holds the Stage, so it times the re-read itself from the earliest `NotYet` begin (Task 7). No new live message.
- **The first guide read waits for the web UI to ask**, so the page is listening before the first read arrives (Tasks 6, 7).
- **`Source.lineup` is replaced by `Source.availability`**, a function from a game to its availability, so callers no longer care whether a guide or the lineup answered (Task 4).
- **YouTube TV gets a folder.** `source/youtube-tv/` holds `YouTubeTv.ts`, its payload schema `YouTubeTvPayload.ts`, and `fixtures/`, as `provider/espn/` does. The import-boundary rules follow (Task 4).
- **Times print through one helper.** The slate's kickoff time and a waiting tile's time share `localTime` in a new `apps/web/src/LocalTime.ts` (Task 7).

## Decide before Task 4

The guide fixture names this account's local stations ("News 3", "WAVY 10", "FOX 43", "WHRO"), which reveal its home market. This plan commits it as recorded. If the stations should be renamed, rename them in the reduced fixture in Task 4 Step 1 and change the names Task 4's tests expect.

## Out of scope

- A per-game correction for a wrong guide match.
- The listings-service fallback.
- Sources other than YouTube TV.
- The stream budget, beyond the game-day row that watches it while the reader runs.
- Reading guide pages past the first (later kickoffs wait for a later read).

## File map

```
sportal/
├── CONTEXT.md, .dependency-cruiser.cjs                                  Tasks 1–4
├── docs/adr/0002-…, docs/game-day-checklist.md, docs/technical-spec.md,
│   docs/specs/2026-10-03-guide-matched-channels-design.md                Task 8
├── packages/
│   ├── domain/src/
│   │   ├── Game.ts (+ test)        Broadcast { network, medium }                       Task 1
│   │   ├── Team.ts                 location, shortName                                 Task 1
│   │   ├── TestGame.ts             team names, broadcast()                             Task 1
│   │   ├── Source.ts (+ test)      Channel { name, … }, carriage names network         Task 2
│   │   │                           ChannelId, Airing, Guide, Upcoming, why, GuideUnreadable  Task 3
│   │   └── Stage.ts (+ test)       StreamTile.learnedFor                               Task 2
│   │                               DataTile.why                                        Task 3
│   └── api/src/
│       ├── SportalApi.ts           guide group                                         Task 5
│       └── ShellBridge.ts          onGuideRead, readGuide                              Task 6
└── apps/
    ├── hub/src/
    │   ├── provider/espn/EspnPayload.ts, EspnProvider.ts (+ test)   geoBroadcasts, names   Task 1
    │   ├── provider/espn/fixtures/fbs-scoreboard-2026-10-03T2024Z.json (new)          Task 4
    │   ├── source/SqlChannelStore.ts (+ test)                       carriage shape     Task 2
    │   ├── source/Source.ts                                         availability, readGuide  Task 4
    │   ├── source/youtube-tv/YouTubeTv.ts (+ test)   moved; reads guides               Tasks 2, 4
    │   ├── source/youtube-tv/YouTubeTvPayload.ts (new)                                 Task 4
    │   ├── source/youtube-tv/fixtures/guide-2026-10-03T2024Z.json (new)               Task 4
    │   ├── stage/StageSessions.ts (+ test)                          source.availability Task 5
    │   ├── http/HubServer.ts (+ test)                               guide handler      Task 5
    │   └── main.ts                                                  import path        Task 4
    ├── desktop/src/
    │   ├── main/GuideReader.ts (+ test) (new)                                          Task 6
    │   ├── main/main.ts                                             wiring             Task 6
    │   └── preload/ShellBridge.ts                                   bridge             Task 6
    └── web/src/
        ├── LocalTime.ts (new)                                                          Task 7
        ├── slate/SlateView.tsx                                      localTime          Task 7
        ├── hub/HubClient.ts                                         sendGuide          Task 7
        └── stage/StageView.tsx                                      relay, timer, why  Tasks 2, 7
```

---

### Task 1: Broadcasts carry their medium; teams carry location and short name

No behaviour changes for the user. ESPN's `geoBroadcasts` replaces `broadcasts` as the source of a game's networks, so each broadcast says whether it is on TV or streaming only (radio is dropped), and each team keeps the names a guide title uses.

**Files:**
- Modify: `packages/domain/src/Game.ts`, `packages/domain/src/Team.ts`, `packages/domain/src/TestGame.ts`
- Modify: `packages/domain/src/Source.ts` (`ChannelLineup#availabilityOf` reads `broadcast.network`)
- Test: `packages/domain/src/Source.test.ts`, `apps/hub/src/stage/StageSessions.test.ts`, `apps/hub/src/http/HubServer.test.ts`, `apps/hub/src/source/YouTubeTv.test.ts` (broadcast literals)
- Modify: `apps/hub/src/provider/espn/EspnPayload.ts`, `apps/hub/src/provider/espn/EspnProvider.ts`
- Test: `apps/hub/src/provider/espn/EspnProvider.test.ts`
- Modify: `CONTEXT.md` (Broadcast row)

**Interfaces:**
- Produces:
  - `Broadcast` (in `Game.ts`) — `{ network: Network; medium: "tv" | "streaming" }`.
  - `GameSnapshot.broadcasts: ReadonlyArray<Broadcast>`.
  - `Team` gains `location: string` and `shortName: string`.
  - `TestGame.team(abbreviation, league?, names?: { name?; location?; shortName? })` and `TestGame.broadcast(network: string, medium?: "tv" | "streaming"): Broadcast`.

- [ ] **Step 1: Write the failing provider tests**

In `apps/hub/src/provider/espn/EspnProvider.test.ts`, replace the broadcasts assertion in "decodes a live FBS scoreboard into snapshots":

```ts
      assert.deepStrictEqual(game?.broadcasts, [{ network: Network.make("ESPN+"), medium: "streaming" }])
```

and add two tests to the `describe`:

```ts
  it.effect("keeps television and streaming broadcasts and drops radio", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      const game = (yield* provider.slate("fbs")).find((g) => g.id === "401856710")

      assert.deepStrictEqual(game?.broadcasts, [{ network: Network.make("ESPN"), medium: "tv" }])
    }).pipe(Effect.provide(TestLayer))
  )

  it.effect("keeps each team's location and short name", () =>
    Effect.gen(function* () {
      const provider = yield* Provider
      const game = (yield* provider.slate("fbs")).find((g) => g.id === "401862787")

      assert.strictEqual(game?.away.team.location, "Charlotte")
      assert.strictEqual(game?.away.team.shortName, "Charlotte")
      assert.strictEqual(game?.away.team.name, "Charlotte 49ers")
    }).pipe(Effect.provide(TestLayer))
  )
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/hub/src/provider/espn/EspnProvider.test.ts`
Expected: FAIL. `broadcasts` is `[Network]`, and `location` is undefined.

- [ ] **Step 3: Domain types**

In `packages/domain/src/Game.ts`, add `Broadcast` below `Network` (above the class, which reads it as a field type) and use it:

```ts
/** The fact that a network is airing a game, on television or streaming only. */
export const Broadcast = Schema.Struct({ network: Network, medium: Schema.Literals(["tv", "streaming"]) })
export type Broadcast = typeof Broadcast.Type
```

```diff
-  broadcasts: Schema.Array(Network),
+  broadcasts: Schema.Array(Broadcast),
```

In `packages/domain/src/Team.ts`:

```ts
export class Team extends Schema.Class<Team>("sportal/Team")({
  id: TeamId,
  abbreviation: Schema.String,
  name: Schema.String,
  /** Where the team is from, as its league names it ("Ohio State", "New England"). */
  location: Schema.String,
  /** The team's short name ("Patriots", or for some colleges the place: "Charlotte"). */
  shortName: Schema.String,
  logo: Schema.optional(Schema.String)
}) {}
```

In `packages/domain/src/TestGame.ts`, replace `team` and add `broadcast`:

```ts
/** A team for a test, named by its abbreviation unless `names` says otherwise. */
export function team(
  abbreviation: string,
  league: LeagueId = "fbs",
  names: { name?: string; location?: string; shortName?: string } = {}
): Team {
  return new Team({
    id: TeamId.make(`${league}:${abbreviation}`),
    abbreviation,
    name: names.name ?? abbreviation,
    location: names.location ?? abbreviation,
    shortName: names.shortName ?? abbreviation
  })
}

/** A broadcast of `network`, on television unless said otherwise. */
export function broadcast(network: string, medium: Broadcast["medium"] = "tv"): Broadcast {
  return { network: Network.make(network), medium }
}
```

with the imports `import { type Broadcast, GameId, GameSnapshot, Network } from "./Game.ts"`.

In `packages/domain/src/Source.ts`, `ChannelLineup#availabilityOf` walks broadcasts:

```ts
  availabilityOf(game: GameSnapshot): ChannelAvailability {
    for (const { network } of game.broadcasts) {
      const carriage = this.carriageOf(network)
      if (carriage?._tag === "Carried") return ChannelAvailability.Carried({ channel: carriage.channel })
    }
    const unlearned = game.broadcasts.find(({ network }) => this.carriageOf(network) === undefined)
    return unlearned === undefined
      ? ChannelAvailability.NotCarried()
      : ChannelAvailability.Unlearned({ network: unlearned.network, source: this.source, guide: this.guide })
  }
```

- [ ] **Step 4: Decode them from ESPN**

In `apps/hub/src/provider/espn/EspnPayload.ts`, the team gains its names and the competition reads `geoBroadcasts` instead of `broadcasts`:

```diff
   team: Schema.Struct({
     id: Schema.String,
     abbreviation: Schema.String,
     displayName: Schema.String,
+    location: Schema.optional(Schema.String),
+    shortDisplayName: Schema.optional(Schema.String),
     logo: Schema.optional(Schema.String)
   })
```

```diff
-      broadcasts: Schema.optional(Schema.Array(Schema.Struct({ names: Schema.Array(Schema.String) }))),
+      geoBroadcasts: Schema.optional(
+        Schema.Array(
+          Schema.Struct({
+            type: Schema.Struct({ shortName: Schema.String }),
+            media: Schema.Struct({ shortName: Schema.String })
+          })
+        )
+      ),
```

In `apps/hub/src/provider/espn/EspnProvider.ts`, inside `side`:

```diff
       name: competitor.team.displayName,
+      location: competitor.team.location ?? competitor.team.displayName,
+      shortName: competitor.team.shortDisplayName ?? competitor.team.displayName,
```

and the snapshot's broadcasts:

```diff
-      broadcasts: (competition.broadcasts ?? []).flatMap((b) => b.names.map((name) => Network.make(name))),
+      broadcasts: (competition.geoBroadcasts ?? []).flatMap(toBroadcast),
```

with this helper below `toSnapshot`:

```ts
/** A TV or streaming broadcast; ESPN also lists radio, which no source plays. */
function toBroadcast(broadcast: {
  readonly type: { readonly shortName: string }
  readonly media: { readonly shortName: string }
}): Array<Broadcast> {
  const medium =
    broadcast.type.shortName === "TV" ? "tv" : broadcast.type.shortName === "Streaming" ? "streaming" : undefined
  return medium === undefined ? [] : [{ network: Network.make(broadcast.media.shortName), medium }]
}
```

The import becomes `import { type Broadcast, GameId, GameSnapshot, type GameStatus, Network } from "@sportal/domain/Game"`.

- [ ] **Step 5: Update the broadcast literals in the other tests**

Each test that builds a snapshot with `broadcasts: [x, y]` of `Network`s now builds `Broadcast`s with `TestGame.broadcast`:

- `packages/domain/src/Source.test.ts`, in `on`: `return snapshot({ broadcasts: networks.map((network) => broadcast(network)) })`, importing `broadcast` from `./TestGame.ts`.
- `apps/hub/src/stage/StageSessions.test.ts`, in `game`: `snapshot({ …, broadcasts: broadcasts.map((network) => broadcast(network)) })`.
- `apps/hub/src/http/HubServer.test.ts`: `broadcasts: [broadcast(espn)]`.
- `apps/hub/src/source/YouTubeTv.test.ts`: `snapshot({ broadcasts: [broadcast(espn)] })` and `snapshot({ broadcasts: [broadcast(disney), broadcast(espn)] })`.

`broadcast` takes a `string`, and a `Network` is one.

- [ ] **Step 6: Run everything**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 7: Glossary**

In `CONTEXT.md`, the **Broadcast** row reads:

```
| **Broadcast** | The fact that a network is airing a game, on television or streaming only. | channel, stream |
```

- [ ] **Step 8: Commit**

```bash
git add -A packages/domain apps/hub/src CONTEXT.md
git commit -m "feat(domain): broadcasts carry their medium, teams their location and short name"
```

---

### Task 2: A Channel is named by its source; a carriage names its network

No behaviour changes. A guide channel is "News 3", not "CBS", so `Channel` stops naming a network. A carriage names its network beside its channel, and a stream tile remembers the network a hand-picked channel was learned for, which **wrong channel** forgets.

**Files:**
- Modify: `packages/domain/src/Source.ts`, `packages/domain/src/Stage.ts`
- Modify: `apps/hub/src/source/SqlChannelStore.ts`, `apps/hub/src/source/YouTubeTv.ts`
- Modify: `apps/web/src/stage/StageView.tsx`
- Test: `packages/domain/src/Source.test.ts`, `packages/domain/src/Stage.test.ts`, `apps/hub/src/source/SqlChannelStore.test.ts`, `apps/hub/src/source/YouTubeTv.test.ts`, `apps/hub/src/stage/StageSessions.test.ts`, `apps/hub/src/http/HubServer.test.ts`
- Modify: `CONTEXT.md` (Channel row)

**Interfaces:**
- Produces:
  - `Channel` — `{ name: string; source: SourceName; locator: StreamLocator }`.
  - `ChannelCarriage` — `Carried { network: Network; channel: Channel }` | `NotCarried { network: Network; source: SourceName }`.
  - `ChannelAvailability.Carried` — `{ channel: Channel; learnedFor: Option<Network> }`.
  - `Tile` `StreamTile` — `{ game: GameId; channel: Channel; learnedFor?: Network }`.

- [ ] **Step 1: Update the domain tests to the new shapes**

In `packages/domain/src/Source.test.ts`:

```ts
const espnChannel = {
  name: "ESPN",
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/espn" }
}
const carried = { _tag: "Carried" as const, network: espn, channel: espnChannel }
```

and its first test expects `ChannelAvailability.Carried({ channel: espnChannel, learnedFor: Option.some(espn) })` (import `Option` from `effect`).

In `packages/domain/src/Stage.test.ts`:

```ts
const foxChannel = {
  name: "FOX",
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/fox" }
}
const onFox = () => ChannelAvailability.Carried({ channel: foxChannel, learnedFor: Option.some(fox) })
```

and every expected stream tile `{ _tag: "StreamTile", game: X, channel: foxChannel }` becomes `{ _tag: "StreamTile", game: X, channel: foxChannel, learnedFor: fox }` (four places: the first `apply` test and three in `refresh`).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run packages/domain`
Expected: FAIL on the carried and stream-tile assertions.

- [ ] **Step 3: Change the domain**

In `packages/domain/src/Source.ts`:

```ts
/** A channel as a source names it ("News 3", "ESPN2"), and the address that plays it live. */
export const Channel = Schema.Struct({ name: Schema.String, source: SourceName, locator: StreamLocator })
export type Channel = typeof Channel.Type

/** Whether a source carries a network: on a channel, or not at all. */
export const ChannelCarriage = Schema.Union([
  Schema.TaggedStruct("Carried", { network: Network, channel: Channel }),
  Schema.TaggedStruct("NotCarried", { network: Network, source: SourceName })
])
```

In `ChannelLineup#availabilityOf`, the carried case:

```ts
      if (carriage?._tag === "Carried")
        return ChannelAvailability.Carried({ channel: carriage.channel, learnedFor: Option.some(network) })
```

Every carriage now has `network`, so `networkOf` goes: `record` uses `this.forget(carriage.network)`, `forget` filters `carriage.network !== network`, and `carriageOf` finds `carriage.network === network`. Delete the `networkOf` function.

The enum's carried member:

```ts
  Carried: { readonly channel: Channel; readonly learnedFor: Option.Option<Network> }
```

Import `Option` alongside `Data` and `Schema`.

In `packages/domain/src/Stage.ts`:

```ts
  /** `learnedFor` is the network a hand-picked channel was learned for; **wrong channel** forgets it. */
  Schema.TaggedStruct("StreamTile", { game: GameId, channel: Channel, learnedFor: Schema.optional(Network) }),
```

and in `tileFor`:

```ts
    case "Carried":
      return {
        _tag: "StreamTile",
        game,
        channel: availability.channel,
        ...(Option.isSome(availability.learnedFor) ? { learnedFor: availability.learnedFor.value } : {})
      }
```

- [ ] **Step 4: Run the domain tests**

Run: `pnpm vitest run packages/domain`
Expected: PASS.

- [ ] **Step 5: The channel store and the source**

In `apps/hub/src/source/SqlChannelStore.ts`, reading a row:

```ts
            carried === 1 && url !== null
              ? {
                  _tag: "Carried",
                  network,
                  // A hand-learned channel has no name of its own; it is known by the network it was picked for.
                  channel: { name: network, source, locator: { _tag: "WebView", url } }
                }
              : { _tag: "NotCarried", network, source }
```

and writing one:

```ts
        carriage._tag === "Carried"
          ? {
              network: carriage.network,
              source: carriage.channel.source,
              carried: 1,
              url: carriage.channel.locator.url
            }
```

Rows already in a database read back unchanged: the table has no name column, and the name is derived.

In `apps/hub/src/source/YouTubeTv.ts`, `learn` records:

```ts
            record({
              _tag: "Carried",
              network,
              channel: { name: network, source: "YouTube TV", locator: { _tag: "WebView", url: live } }
            })
```

- [ ] **Step 6: Update the Hub tests**

- `SqlChannelStore.test.ts`: `carried(url)` returns `{ _tag: "Carried" as const, network: espn, channel: { name: espn, source: "YouTube TV" as const, locator: { _tag: "WebView" as const, url } } }`.
- `YouTubeTv.test.ts`: the learned channel expected is `ChannelAvailability.Carried({ channel: { name: espn, source: "YouTube TV", locator: { _tag: "WebView", url: foxLive } }, learnedFor: Option.some(espn) })`. In `storeKnowingEspn`, the record call takes `{ _tag: "Carried", network: espn, channel: { name: espn, source: "YouTube TV", locator: { _tag: "WebView", url: cbsLive } } }`.
- `StageSessions.test.ts`: `espnChannel` becomes `{ name: espn, source: "YouTube TV" as const, locator: … }`. Expected stream tiles add `learnedFor: espn`. In the refresh test the assertion on the network reads `tile?._tag === "StreamTile" ? tile.learnedFor : tile` and expects `fox`. The helper `sourceKnowingEspn` records ESPN with `network: espn` beside its channel.
- `HubServer.test.ts`: `streaming` becomes `{ _tag: "StreamTile", game: game.id, channel: { name: espn, source: "YouTube TV", locator: { _tag: "WebView", url: espnLive } }, learnedFor: espn }`.

- [ ] **Step 7: The web UI's wrong-channel action**

In `apps/web/src/stage/StageView.tsx`, the **wrong channel** button shows only on a tile whose channel was picked by hand, and forgets that network:

```tsx
              {tile._tag === "StreamTile" && tile.learnedFor !== undefined ? (
                <button
                  type="button"
                  className="text-neutral-500"
                  onClick={() => {
                    const network = tile.learnedFor
                    if (network !== undefined)
                      void forgetChannel(network).then((failure) => setNotices(noticed(index, failure)))
                  }}
                >
                  wrong channel
                </button>
              ) : null}
```

- [ ] **Step 8: Glossary**

In `CONTEXT.md`, the **Channel** row reads:

```
| **Channel** | A station as a source names it ("News 3", "ESPN2"), with the address that plays it live. | network |
```

- [ ] **Step 9: Run everything, then commit**

Run: `pnpm check`
Expected: PASS.

```bash
git add -A packages/domain apps/hub/src apps/web/src CONTEXT.md
git commit -m "refactor(domain): a channel is named by its source, and a carriage names its network"
```

---

### Task 3: The guide resolves a game's availability

Test-first, pure domain. A `Guide` is one reading of a source's guide. It answers availability by matching airings to games. Availability gains `Upcoming`, and not carried says why. The data tile carries that reason as `why`.

**Files:**
- Modify: `packages/domain/src/Source.ts` (`ChannelId`, `Airing`, `Guide`, `ChannelAvailability`, `GuideUnreadable`)
- Test: `packages/domain/src/Source.test.ts`
- Modify: `packages/domain/src/Stage.ts` (`DataTile.why`)
- Test: `packages/domain/src/Stage.test.ts`
- Modify: `apps/hub/src/stage/StageSessions.ts` (a game off the slate is `NotCarried({ why: "NoStream" })`)
- Test: `apps/hub/src/stage/StageSessions.test.ts`, `apps/hub/src/http/HubServer.test.ts` (data tiles carry `why`)
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: `Broadcast`, `Team.location`, `Team.shortName` (Task 1); `Channel { name, source, locator }` (Task 2).
- Produces:
  - `ChannelId` — branded string, a source's own id for a channel.
  - `Airing` — `{ channel: ChannelId; title: string; begin: DateTime.Utc; end: DateTime.Utc }`.
  - `class Guide` — `{ source: SourceName; readAt: DateTime.Utc; channels: ReadonlyArray<{ id: ChannelId; name: string; live?: StreamLocator }>; airings: ReadonlyArray<Airing> }`, with `static reach: Duration` (3 hours) and `availabilityOf(game: GameSnapshot): ChannelAvailability`.
  - `ChannelAvailability` — `Carried { channel, learnedFor }` | `Upcoming { channel: Option<string>; begin: Option<DateTime.Utc> }` | `Unlearned { network, source, guide }` | `NotCarried { why: "NoStream" | "StreamingOnly" | "NotInGuide" }`.
  - `class GuideUnreadable` — tagged error, HTTP 422.
  - `Tile` `DataTile` — `{ game: GameId; why: NoStream {} | StreamingOnly {} | NotInGuide {} | NotYet { channel?: string; begin?: DateTime.Utc } }`.

- [ ] **Step 1: Write the failing guide tests**

Append to `packages/domain/src/Source.test.ts`:

```ts
describe("Guide#availabilityOf", () => {
  const readAt = DateTime.makeUnsafe("2026-10-03T20:25:00Z")
  const news3 = ChannelId.make("UCPc5PkgTSfcJCi3-dJyg3Tg")
  const nflStCbs = ChannelId.make("UCquxTSBuMAzHJT_n09tNU6Q")
  const abc13 = ChannelId.make("UCTmlvooJJXQtAMVKowcFrVw")
  const accNetwork = ChannelId.make("UCdj7clRJstl32igUku_7Jaw")
  const news3Live = { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/y6zFA17zDsw?vp=0gEEEgIwAQ%3D%3D" }
  const guide = new Guide({
    source: "YouTube TV",
    readAt,
    channels: [
      { id: news3, name: "News 3", live: news3Live },
      { id: nflStCbs, name: "NFL ST - CBS" },
      // ACC Network comes first, so a tie with no network to go on takes it.
      { id: accNetwork, name: "ACC Network", live: { _tag: "WebView", url: "https://tv.youtube.com/watch/acc" } },
      { id: abc13, name: "ABC 13", live: { _tag: "WebView", url: "https://tv.youtube.com/watch/abc" } }
    ],
    airings: [
      airing(news3, "Ohio State at Iowa", "2026-10-03T19:35:00Z", "2026-10-03T23:00:00Z"),
      airing(news3, "Ohio State at Iowa", "2026-10-04T09:00:00Z", "2026-10-04T12:00:00Z"),
      airing(nflStCbs, "New England Patriots at Buffalo Bills", "2026-10-04T17:00:00Z", "2026-10-04T20:00:00Z"),
      airing(accNetwork, "Miami at Clemson", "2026-10-03T23:30:00Z", "2026-10-04T03:00:00Z"),
      airing(abc13, "Miami at Clemson", "2026-10-03T23:30:00Z", "2026-10-04T03:00:00Z"),
      airing(abc13, "Arkansas at Texas A&M", "2026-10-03T20:45:00Z", "2026-10-03T23:30:00Z")
    ]
  })
  const ohioStateAtIowa = snapshot({
    status: "live",
    kickoff: DateTime.makeUnsafe("2026-10-03T19:30:00Z"),
    away: { team: team("OSU", "fbs", { name: "Ohio State Buckeyes", location: "Ohio State", shortName: "Ohio State" }), score: 0 },
    home: { team: team("IOWA", "fbs", { name: "Iowa Hawkeyes", location: "Iowa", shortName: "Iowa" }), score: 0 },
    broadcasts: [broadcast("CBS")]
  })
  const miamiAtClemson = (broadcasts: Array<Broadcast>) =>
    snapshot({
      kickoff: DateTime.makeUnsafe("2026-10-03T23:30:00Z"),
      away: { team: team("MIA", "fbs", { name: "Miami Hurricanes", location: "Miami" }), score: 0 },
      home: { team: team("CLEM", "fbs", { name: "Clemson Tigers", location: "Clemson" }), score: 0 },
      broadcasts
    })

  it("is carried on the channel airing the game, at the channel's live address", () => {
    assert.deepStrictEqual(
      guide.availabilityOf(ohioStateAtIowa),
      ChannelAvailability.Carried({
        channel: { name: "News 3", source: "YouTube TV", locator: news3Live },
        learnedFor: Option.none()
      })
    )
  })

  it("is carried on a live channel when the airing begins within 30 minutes of the reading", () => {
    const arkansasAtTexasAM = snapshot({
      kickoff: DateTime.makeUnsafe("2026-10-03T20:45:00Z"),
      away: { team: team("ARK", "fbs", { name: "Arkansas Razorbacks", location: "Arkansas" }), score: 0 },
      home: { team: team("TA&M", "fbs", { name: "Texas A&M Aggies", location: "Texas A&M" }), score: 0 },
      broadcasts: [broadcast("ESPN2")]
    })
    assert.strictEqual(guide.availabilityOf(arkansasAtTexasAM)._tag, "Carried")
  })

  it("is upcoming, naming the channel, when the channel is off the air", () => {
    const patriotsAtBills = snapshot({
      league: "nfl",
      kickoff: DateTime.makeUnsafe("2026-10-04T17:00:00Z"),
      away: { team: team("NE", "nfl", { name: "New England Patriots", location: "New England", shortName: "Patriots" }), score: 0 },
      home: { team: team("BUF", "nfl", { name: "Buffalo Bills", location: "Buffalo", shortName: "Bills" }), score: 0 },
      broadcasts: [broadcast("CBS")]
    })
    assert.deepStrictEqual(
      guide.availabilityOf(patriotsAtBills),
      ChannelAvailability.Upcoming({
        channel: Option.some("NFL ST - CBS"),
        begin: Option.some(DateTime.makeUnsafe("2026-10-04T17:00:00Z"))
      })
    )
  })

  it("is upcoming on a live channel when the airing is more than 30 minutes away", () => {
    assert.deepStrictEqual(
      guide.availabilityOf(miamiAtClemson([broadcast("ABC")])),
      ChannelAvailability.Upcoming({
        channel: Option.some("ABC 13"),
        begin: Option.some(DateTime.makeUnsafe("2026-10-03T23:30:00Z"))
      })
    )
  })

  it("takes the first matching airing in the guide when no channel is named for the game's networks", () => {
    const upcoming = guide.availabilityOf(miamiAtClemson([]))
    assert.deepStrictEqual(upcoming._tag === "Upcoming" ? upcoming.channel : upcoming, Option.some("ACC Network"))
  })

  it("matches an airing on now for a game under way, however late it began", () => {
    const delayed = snapshot({ ...ohioStateAtIowa, kickoff: DateTime.makeUnsafe("2026-10-03T17:00:00Z") })
    assert.strictEqual(guide.availabilityOf(delayed)._tag, "Carried")
  })

  it("does not match a replay hours from kickoff", () => {
    const scheduled = snapshot({ ...ohioStateAtIowa, status: "scheduled", kickoff: DateTime.makeUnsafe("2026-10-04T14:00:00Z") })
    assert.deepStrictEqual(guide.availabilityOf(scheduled), ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() }))
  })

  it("does not match a title naming only one of the teams", () => {
    const iowaAtKansas = snapshot({
      kickoff: DateTime.makeUnsafe("2026-10-03T19:30:00Z"),
      away: ohioStateAtIowa.home,
      home: { team: team("KU", "fbs", { name: "Kansas Jayhawks", location: "Kansas" }), score: 0 },
      broadcasts: [broadcast("CBS")]
    })
    assert.deepStrictEqual(guide.availabilityOf(iowaAtKansas), ChannelAvailability.NotCarried({ why: "NotInGuide" }))
  })

  it("is not carried, streaming only, when every broadcast streams and no airing matches", () => {
    const onEspnPlus = snapshot({ kickoff: readAt, broadcasts: [broadcast("ESPN+", "streaming")] })
    assert.deepStrictEqual(guide.availabilityOf(onEspnPlus), ChannelAvailability.NotCarried({ why: "StreamingOnly" }))
  })

  it("is not carried, not in the guide, for a television game within reach that no airing matches", () => {
    const onCw = snapshot({ kickoff: readAt, broadcasts: [broadcast("CW")] })
    assert.deepStrictEqual(guide.availabilityOf(onCw), ChannelAvailability.NotCarried({ why: "NotInGuide" }))
  })

  it("is upcoming with nothing known for a kickoff past the guide's reach", () => {
    const tonight = snapshot({ kickoff: DateTime.makeUnsafe("2026-10-04T00:00:00Z"), broadcasts: [broadcast("BTN")] })
    assert.deepStrictEqual(
      guide.availabilityOf(tonight),
      ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() })
    )
  })
})

function airing(channel: ChannelId, title: string, begin: string, end: string): Airing {
  return { channel, title, begin: DateTime.makeUnsafe(begin), end: DateTime.makeUnsafe(end) }
}
```

Imports for the file become:

```ts
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Option } from "effect"
import { type Broadcast, Network } from "./Game.ts"
import { type Airing, ChannelAvailability, type ChannelCarriage, ChannelId, ChannelLineup, Guide } from "./Source.ts"
import { broadcast, snapshot, team } from "./TestGame.ts"
```

The lineup tests' not-carried expectations change too, in the same step: "is not carried when every network is not carried" expects `ChannelAvailability.NotCarried({ why: "NoStream" })`, and so does "is not carried when the game lists no networks".

- [ ] **Step 2: Write the failing stage tests**

In `packages/domain/src/Stage.test.ts`, `nowhere` becomes `() => ChannelAvailability.NotCarried({ why: "NoStream" })`. Every expected `{ _tag: "DataTile", game: X }` becomes `{ _tag: "DataTile", game: X, why: { _tag: "NoStream" } }`. Add to `describe("Stage#apply")`:

```ts
  it("assigns a game still to come as a data tile saying where and when", () => {
    const begin = DateTime.makeUnsafe("2026-10-04T17:00:00Z")
    const stage = assign(Stage.initial, 0, bama, () =>
      ChannelAvailability.Upcoming({ channel: Option.some("NFL ST - CBS"), begin: Option.some(begin) })
    )
    assert.deepStrictEqual(stage.tiles[0], {
      _tag: "DataTile",
      game: bama,
      why: { _tag: "NotYet", channel: "NFL ST - CBS", begin }
    })
  })

  it("assigns a game whose time and channel are unknown as a data tile with neither", () => {
    const stage = assign(Stage.initial, 0, bama, () =>
      ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() })
    )
    assert.deepStrictEqual(stage.tiles[0], { _tag: "DataTile", game: bama, why: { _tag: "NotYet" } })
  })

  it("says why a game is not carried", () => {
    const stage = assign(Stage.initial, 0, bama, () => ChannelAvailability.NotCarried({ why: "StreamingOnly" }))
    assert.deepStrictEqual(stage.tiles[0], { _tag: "DataTile", game: bama, why: { _tag: "StreamingOnly" } })
  })
```

with `DateTime` added to the `effect` import.

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm vitest run packages/domain`
Expected: FAIL. `Guide`, `ChannelId`, and `Upcoming` do not exist.

- [ ] **Step 4: Write the guide**

In `packages/domain/src/Source.ts`, update the imports:

```ts
import { Data, DateTime, Duration, Option, Schema } from "effect"
import { type GameSnapshot, Network } from "./Game.ts"
import { StreamLocator } from "./Stream.ts"
import type { Team } from "./Team.ts"
```

Add after `ChannelLineup` (the schemas `Guide` reads as field types go above it):

```ts
/** A source's own id for one of its channels (YouTube TV's station id). */
export const ChannelId = Schema.String.pipe(Schema.brand("ChannelId"))
export type ChannelId = typeof ChannelId.Type

/** One programme on a channel, with its begin and end. */
export const Airing = Schema.Struct({
  channel: ChannelId,
  title: Schema.String,
  begin: Schema.DateTimeUtc,
  end: Schema.DateTimeUtc
})
export type Airing = typeof Airing.Type

/**
 * One reading of a source's guide: the channels this account gets, each with its live address while it is
 * on the air, and what each airs.
 */
export class Guide extends Schema.Class<Guide>("sportal/Guide")({
  source: SourceName,
  readAt: Schema.DateTimeUtc,
  channels: Schema.Array(Schema.Struct({ id: ChannelId, name: Schema.String, live: Schema.optional(StreamLocator) })),
  airings: Schema.Array(Airing)
}) {
  /**
   * How far past its reading a guide is complete. The first page of YouTube TV's guide reached 3h46m past
   * the half hour before the read (spike, 2026-10-03); a later kickoff may not be listed yet.
   */
  static readonly reach = Duration.hours(3)

  /**
   * Where this source shows a game, from the airing that names both its teams and begins near kickoff, or is
   * on now while the game is under way. Of several, the one on a channel named for one of the game's
   * networks wins, then the first in the guide. It is carried once its channel is on the air and the airing
   * is at most half an hour off; until then it is upcoming. With no match, a kickoff past the guide's reach
   * is upcoming, and any other game is not carried.
   */
  availabilityOf(game: GameSnapshot): ChannelAvailability {
    const matches = this.airings.filter((airing) => this.airs(airing, game))
    const [first] = matches
    if (first === undefined) {
      if (DateTime.isGreaterThan(game.kickoff, DateTime.addDuration(this.readAt, Guide.reach)))
        return ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() })
      const streamingOnly =
        game.broadcasts.length > 0 && game.broadcasts.every(({ medium }) => medium === "streaming")
      return ChannelAvailability.NotCarried({ why: streamingOnly ? "StreamingOnly" : "NotInGuide" })
    }

    const airing =
      matches.find((candidate) =>
        game.broadcasts.some(({ network }) => namesNetwork(this.channelOf(candidate).name, network))
      ) ?? first
    const channel = this.channelOf(airing)
    const soon = DateTime.isLessThanOrEqualTo(airing.begin, DateTime.addDuration(this.readAt, startingSoon))
    return channel.live !== undefined && soon
      ? ChannelAvailability.Carried({
          channel: { name: channel.name, source: this.source, locator: channel.live },
          learnedFor: Option.none()
        })
      : ChannelAvailability.Upcoming({ channel: Option.some(channel.name), begin: Option.some(airing.begin) })
  }

  private airs(airing: Airing, game: GameSnapshot): boolean {
    const nearKickoff =
      Math.abs(DateTime.toEpochMillis(airing.begin) - DateTime.toEpochMillis(game.kickoff)) <=
      Duration.toMillis(kickoffTolerance)
    const onNow = game.isLive() && DateTime.between(this.readAt, { minimum: airing.begin, maximum: airing.end })
    return (nearKickoff || onNow) && namesTeam(airing.title, game.home.team) && namesTeam(airing.title, game.away.team)
  }

  private channelOf(airing: Airing): { readonly name: string; readonly live?: StreamLocator } {
    return this.channels.find(({ id }) => id === airing.channel) ?? { name: airing.channel }
  }
}
```

Replace the enum and add the error:

```ts
/**
 * Whether and where a source can show one game: carried, upcoming (its airing is still to come, or past what
 * the guide lists), unlearned (its network still to be picked), or not carried, with why.
 */
export type ChannelAvailability = Data.TaggedEnum<{
  Carried: { readonly channel: Channel; readonly learnedFor: Option.Option<Network> }
  Upcoming: { readonly channel: Option.Option<string>; readonly begin: Option.Option<DateTime.Utc> }
  Unlearned: { readonly network: Network; readonly source: SourceName; readonly guide: StreamLocator }
  NotCarried: { readonly why: "NoStream" | "StreamingOnly" | "NotInGuide" }
}>
export const ChannelAvailability = Data.taggedEnum<ChannelAvailability>()
```

```ts
/** A guide response the source could not read: not the guide, or a shape it no longer knows. */
export class GuideUnreadable extends Schema.TaggedError<GuideUnreadable>()(
  "GuideUnreadable",
  {},
  { httpApiStatus: 422 }
) {}
```

In `ChannelLineup#availabilityOf`, the not-carried case becomes `ChannelAvailability.NotCarried({ why: "NoStream" })`.

At the bottom of the file, below the existing code, the private helpers and constants, in the order first used:

```ts
/** How long before an airing begins its channel is shown for it: the pregame, not another programme. */
const startingSoon = Duration.minutes(30)

/** How far an airing may begin from kickoff and still be the game: listings round, and kickoffs slip. */
const kickoffTolerance = Duration.minutes(45)

/** Whether a channel's name carries a network's as whole words: "ABC 13" for ABC. */
function namesNetwork(channel: string, network: Network): boolean {
  return ` ${normalized(channel)} `.includes(` ${normalized(network)} `)
}

/** Whether a title names a team by its location, short name, or full name, as whole words. */
function namesTeam(title: string, team: Team): boolean {
  const words = ` ${normalized(title)} `
  return [team.location, team.shortName, team.name].some((name) => words.includes(` ${normalized(name)} `))
}

/** Lower case, "&" read as "and", every run of punctuation and space a single space. */
function normalized(text: string): string {
  return text
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}
```

`startingSoon` and `kickoffTolerance` are read only when a method runs, after the module has loaded, so declaring them below the class is safe.

- [ ] **Step 5: The data tile says why**

In `packages/domain/src/Stage.ts`, the data tile:

```ts
  /** No stream, and why: none on any source, streaming only, not in the guide, or not on yet. */
  Schema.TaggedStruct("DataTile", {
    game: GameId,
    why: Schema.Union([
      Schema.TaggedStruct("NoStream", {}),
      Schema.TaggedStruct("StreamingOnly", {}),
      Schema.TaggedStruct("NotInGuide", {}),
      Schema.TaggedStruct("NotYet", {
        channel: Schema.optional(Schema.String),
        begin: Schema.optional(Schema.DateTimeUtcFromString)
      })
    ])
  })
```

and in `tileFor`:

```ts
    case "Upcoming":
      return {
        _tag: "DataTile",
        game,
        why: {
          _tag: "NotYet",
          ...(Option.isSome(availability.channel) ? { channel: availability.channel.value } : {}),
          ...(Option.isSome(availability.begin) ? { begin: availability.begin.value } : {})
        }
      }
    case "NotCarried":
      return { _tag: "DataTile", game, why: { _tag: availability.why } }
```

- [ ] **Step 6: Run the domain tests**

Run: `pnpm vitest run packages/domain`
Expected: PASS.

- [ ] **Step 7: A game off the slate, and the Hub tests' data tiles**

In `apps/hub/src/stage/StageSessions.ts`:

```diff
-              Option.getOrElse(availabilityOf(id), () => ChannelAvailability.NotCarried())
+              Option.getOrElse(availabilityOf(id), () => ChannelAvailability.NotCarried({ why: "NoStream" }))
```

In `StageSessions.test.ts` and `HubServer.test.ts`, every expected `{ _tag: "DataTile", game: X }` becomes `{ _tag: "DataTile", game: X, why: { _tag: "NoStream" } }`.

- [ ] **Step 8: Glossary**

In `CONTEXT.md`, under **Data and video**, add rows after **Channel availability**, and replace that row:

```
| **Channel availability** | Whether and where a source can show a game: carried, upcoming, unlearned (its network still to be picked), or not carried, with why. | availability |
| **Guide** | One reading of a source's listing of the channels this account gets, with their live addresses, and what each airs. | schedule, EPG |
| **Airing** | One programme on a channel, with its begin and end. | listing, show |
| **Guide unreadable** | A guide response the source could not read. | |
```

- [ ] **Step 9: Run everything, then commit**

Run: `pnpm check`
Expected: PASS. knip may report `Guide`, `Airing`, `ChannelId`, and `GuideUnreadable` as unused exports until Task 4; if it fails on them, keep going and run `pnpm check` again at the end of Task 4 before committing both together.

```bash
git add -A packages/domain apps/hub/src CONTEXT.md
git commit -m "feat(domain): a guide matches games to airings, and a data tile says why"
```

---

### Task 4: The YouTube TV source reads its guide

The source decodes a guide response into a `Guide`. Availability now comes from the latest guide, or from the lineup until one is read. A recorded guide and ESPN's scoreboard from the same minute prove the match rate.

**Files:**
- Move: `apps/hub/src/source/YouTubeTv.ts` → `apps/hub/src/source/youtube-tv/YouTubeTv.ts`, and its test
- Create: `apps/hub/src/source/youtube-tv/YouTubeTvPayload.ts`
- Create: `apps/hub/src/source/youtube-tv/fixtures/guide-2026-10-03T2024Z.json`
- Create: `apps/hub/src/provider/espn/fixtures/fbs-scoreboard-2026-10-03T2024Z.json`
- Modify: `apps/hub/src/source/Source.ts`
- Modify: `apps/hub/src/main.ts`, `apps/hub/src/stage/StageSessions.test.ts`, `apps/hub/src/http/HubServer.test.ts` (import path)
- Modify: `.dependency-cruiser.cjs`
- Modify: `apps/hub/src/stage/StageSessions.ts` (reads `source.availability`)

**Interfaces:**
- Consumes: `Guide`, `Airing`, `ChannelId`, `GuideUnreadable`, `ChannelAvailability` (Task 3).
- Produces, on the `Source` port:
  - `availability: Effect<(game: GameSnapshot) => ChannelAvailability>` — from the latest guide, else the lineup. Replaces `lineup`.
  - `readGuide(guide: string): Effect<void, GuideUnreadable>` — decodes a guide response; the next availability comes from it.
  - `changes` also emits after each guide read.

- [ ] **Step 1: Record the fixtures**

From the repository root. The spike capture is in the git-ignored `spikes/guide-capture/out/2026-10-03T202445288Z/` on the development machine. This reduction keeps only what the decoder reads: each row's station id and name, its live watch id, and each airing's times and title.

```bash
mkdir -p apps/hub/src/source/youtube-tv/fixtures
jq '{contents: {epgRenderer: {paginationRenderer: {epgPaginationRenderer: {contents: [
  .contents.epgRenderer.paginationRenderer.epgPaginationRenderer.contents[] | {epgRowRenderer: (.epgRowRenderer | {
    station: {epgStationRenderer: (.station.epgStationRenderer | {stationId, icon: {accessibility: .icon.accessibility}})},
    navigationEndpoint: (if .navigationEndpoint.watchEndpoint then {watchEndpoint: {videoId: .navigationEndpoint.watchEndpoint.videoId}} else {} end),
    airings: [.airings[]? | select(.epgAiringRenderer != null) | {epgAiringRenderer: (.epgAiringRenderer | {beginTimeMs, endTimeMs, title})}]
  })}]}}}}}' spikes/guide-capture/out/2026-10-03T202445288Z/003-_youtubei_v1_browse.body \
  > apps/hub/src/source/youtube-tv/fixtures/guide-2026-10-03T2024Z.json
zcat fixtures/espn-recordings/2026-10-03/college-football/scoreboard/20261003T202438Z.json.gz \
  > apps/hub/src/provider/espn/fixtures/fbs-scoreboard-2026-10-03T2024Z.json
pnpm biome format --write apps/hub/src/source/youtube-tv/fixtures apps/hub/src/provider/espn/fixtures
```

Expected: a guide fixture of about 35 KB with 55 rows. If the stations are to be renamed (see "Decide before Task 4"), do it now with `sed` on the fixture, and use the new names in Step 2.

- [ ] **Step 2: Move the source into its folder and write the failing tests**

```bash
mkdir -p apps/hub/src/source/youtube-tv
git mv apps/hub/src/source/YouTubeTv.ts apps/hub/src/source/youtube-tv/YouTubeTv.ts
git mv apps/hub/src/source/YouTubeTv.test.ts apps/hub/src/source/youtube-tv/YouTubeTv.test.ts
```

In both moved files, the relative imports gain a level: `../ChannelStore.ts`, `../Source.ts`, `../SqlChannelStore.ts`, `../../database/Database.ts`. In `main.ts`, `StageSessions.test.ts`, and `HubServer.test.ts`, import `./source/youtube-tv/YouTubeTv.ts` (or `../source/youtube-tv/YouTubeTv.ts`).

In `YouTubeTv.test.ts`, every `(yield* source.lineup).availabilityOf(x)` becomes `(yield* source.availability)(x)`, and `(yield* (yield* Source).lineup).availabilityOf(onEspn)` becomes `(yield* (yield* Source).availability)(onEspn)`. Then append:

```ts
// The first page of YouTube TV's live guide, read 2026-10-03T20:24:45Z, reduced to what the source reads.
const recordedGuide = readFileSync(new URL("./fixtures/guide-2026-10-03T2024Z.json", import.meta.url), "utf8")
const readAt = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T20:24:45Z"))

describe("YouTubeTv source reading its guide", () => {
  it.effect("reads the recorded guide's channels, live addresses, and airings", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(readAt)
      const source = yield* Source
      yield* source.readGuide(recordedGuide)
      const ohioStateAtIowa = snapshot({
        status: "live",
        kickoff: DateTime.makeUnsafe("2026-10-03T19:30:00Z"),
        away: { team: team("OSU", "fbs", { name: "Ohio State Buckeyes", location: "Ohio State" }), score: 0 },
        home: { team: team("IOWA", "fbs", { name: "Iowa Hawkeyes", location: "Iowa" }), score: 0 },
        broadcasts: [broadcast("CBS")]
      })
      assert.deepStrictEqual(
        (yield* source.availability)(ohioStateAtIowa),
        ChannelAvailability.Carried({
          channel: { name: "News 3", source: "YouTube TV", locator: { _tag: "WebView", url: cbsLive } },
          learnedFor: Option.none()
        })
      )
    }).pipe(Effect.provide(testSource()))
  )

  it.effect("signals a change after a guide is read", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const signals = yield* source.changes.pipe(Stream.take(1), Stream.runCount, Effect.forkChild)
      yield* Effect.yieldNow
      yield* source.readGuide(recordedGuide)
      assert.strictEqual(yield* Fiber.join(signals), 1)
    }).pipe(Effect.provide(testSource()))
  )

  for (const response of [
    "not json",
    "{}",
    JSON.stringify({ contents: { epgRenderer: { paginationRenderer: { epgPaginationRenderer: { contents: [] } } } } })
  ])
    it.effect(`refuses a response that is not a guide with channels: ${response.slice(0, 40)}`, () =>
      Effect.gen(function* () {
        const source = yield* Source
        const error = yield* source.readGuide(response).pipe(Effect.flip)
        assert.strictEqual(error._tag, "GuideUnreadable")
        // Still answering from the lineup: nothing was read.
        assert.strictEqual((yield* source.availability)(onEspn)._tag, "Unlearned")
      }).pipe(Effect.provide(testSource()))
    )
})

describe("matching the 2026-10-03 slates to the guide read at 20:24:45Z", () => {
  it.effect("places every college game on television that is under way, and the rest as the guide allows", () =>
    Effect.gen(function* () {
      const tally = yield* tallied("fbs")
      assert.deepStrictEqual(tally.carried, {
        "401858473": "News 3", // Ohio State at Iowa: CBS is the local affiliate's name in the guide
        "401856710": "ESPN",
        "401858247": "CBS Sports Network",
        "401858248": "ACC Network",
        "401858253": "ESPN2",
        "401864515": "WVBTDT2", // Wyoming at North Dakota State, on the CW affiliate
        "401869956": "ESPN", // Old Dominion at Georgia State: ESPN says ESPN+, the guide has it on an ESPN channel
        "401869962": "ESPNU",
        "401856708": "ABC 13",
        "401858475": "FS1",
        "401856709": "SEC Network",
        "401858472": "BTN"
      })
      assert.deepStrictEqual(tally.upcomingOn, {
        "401860899": "USA",
        "401856818": "ESPN",
        "401856711": "ESPN2",
        "401858249": "ABC 13", // Miami at Clemson: on ABC 13 and ACC Network; ESPN's "ABC" settles it
        "401856821": "FOX 43",
        "401858478": "WAVY 10",
        "401860898": "CBS Sports Network",
        "401862792": "ESPNU",
        "401856706": "SEC Network"
      })
      assert.strictEqual(tally.upcomingUnknown, 8)
      assert.strictEqual(tally.streamingOnly, 13)
      assert.strictEqual(tally.notInGuide, 17)
    }).pipe(Effect.provide(matchingLayer()))
  )

  it.effect("puts each of Sunday's CBS and FOX games on its own Sunday Ticket station", () =>
    Effect.gen(function* () {
      const tally = yield* tallied("nfl")
      const stations = Object.values(tally.upcomingOn)
      assert.strictEqual(stations.length, 12)
      assert.strictEqual(stations.filter((name) => name === "NFL ST - CBS").length, 7)
      assert.strictEqual(stations.filter((name) => name === "NFL ST - FOX").length, 5)
      assert.strictEqual(tally.upcomingUnknown, 3)
      assert.strictEqual(tally.streamingOnly, 1)
    }).pipe(Effect.provide(matchingLayer()))
  )
})

/** Reads the recorded guide at the moment it was recorded, then sorts a league's slate by availability. */
function tallied(league: LeagueId) {
  return Effect.gen(function* () {
    yield* TestClock.setTime(readAt)
    const source = yield* Source
    yield* source.readGuide(recordedGuide)
    const availabilityOf = yield* source.availability
    const tally = {
      carried: {} as Record<string, string>,
      upcomingOn: {} as Record<string, string>,
      upcomingUnknown: 0,
      streamingOnly: 0,
      notInGuide: 0
    }
    for (const game of yield* (yield* Provider).slate(league)) {
      ChannelAvailability.$match(availabilityOf(game), {
        Carried: ({ channel }) => {
          tally.carried[game.id] = channel.name
        },
        Upcoming: ({ channel }) =>
          Option.match(channel, {
            onNone: () => {
              tally.upcomingUnknown++
            },
            onSome: (name) => {
              tally.upcomingOn[game.id] = name
            }
          }),
        Unlearned: () => assert.fail(`${game.id} was left to the lineup`),
        NotCarried: ({ why }) => {
          if (why === "StreamingOnly") tally.streamingOnly++
          else if (why === "NotInGuide") tally.notInGuide++
          else assert.fail(`${game.id} is not carried for ${why}`)
        }
      })
    }
    return tally
  })
}

/** The source over a fresh database, and ESPN answering from its 2026-10-03 recordings. */
function matchingLayer() {
  const espn = (name: string) =>
    readFileSync(new URL(`../../provider/espn/fixtures/${name}.json`, import.meta.url), "utf8")
  const fbs = espn("fbs-scoreboard-2026-10-03T2024Z")
  const nfl = espn("nfl-scoreboard-pregame")
  const recorded = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(request.url.includes("/nfl/") ? nfl : fbs)))
    )
  )
  return Layer.mergeAll(testSource(), EspnProvider.layer.pipe(Layer.provide(recorded)))
}
```

The test file's imports become:

```ts
import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Network } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { ChannelAvailability } from "@sportal/domain/Source"
import { broadcast, snapshot, team } from "@sportal/domain/TestGame"
import { DateTime, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as Database from "../../database/Database.ts"
import { Provider } from "../../provider/Provider.ts"
import * as EspnProvider from "../../provider/espn/EspnProvider.ts"
import { ChannelStore } from "../ChannelStore.ts"
import { Source } from "../Source.ts"
import * as SqlChannelStore from "../SqlChannelStore.ts"
import * as YouTubeTv from "./YouTubeTv.ts"
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm vitest run apps/hub/src/source`
Expected: FAIL. `availability` and `readGuide` do not exist.

- [ ] **Step 4: The port**

`apps/hub/src/source/Source.ts`:

```ts
import type { GameSnapshot, Network } from "@sportal/domain/Game"
import type { ChannelAvailability, ChannelUrlRefused, GuideUnreadable } from "@sportal/domain/Source"
import { Context, type Effect, type Stream } from "effect"
import type { ChannelStoreError } from "./ChannelStore.ts"

export class Source extends Context.Service<
  Source,
  {
    /** Whether and where this source can show a game: from its latest guide, or, until one is read, its lineup. */
    readonly availability: Effect.Effect<(game: GameSnapshot) => ChannelAvailability>
    /** Emits once after every change to the lineup and every guide read. */
    readonly changes: Stream.Stream<void>
    /** Reads a guide response as the source's guide page received it; availability comes from it next. */
    readGuide(guide: string): Effect.Effect<void, GuideUnreadable>
    /** Remembers the channel at `url` as where this source carries `network`. */
    learn(network: Network, url: string): Effect.Effect<void, ChannelUrlRefused | ChannelStoreError>
    markNotCarried(network: Network): Effect.Effect<void, ChannelStoreError>
    forget(network: Network): Effect.Effect<void, ChannelStoreError>
  }
>()("sportal/hub/Source") {}
```

- [ ] **Step 5: The payload schema**

`apps/hub/src/source/youtube-tv/YouTubeTvPayload.ts`:

```ts
import { Schema } from "effect"

const Text = Schema.Struct({ runs: Schema.NonEmptyArray(Schema.Struct({ text: Schema.String })) })

const Row = Schema.Struct({
  station: Schema.optional(
    Schema.Struct({
      epgStationRenderer: Schema.Struct({
        stationId: Schema.optional(Schema.NullOr(Schema.String)),
        icon: Schema.optional(
          Schema.Struct({
            accessibility: Schema.optional(
              Schema.NullOr(Schema.Struct({ accessibilityData: Schema.Struct({ label: Schema.String }) }))
            )
          })
        )
      })
    })
  ),
  // The station's live channel, present while the station is on the air.
  navigationEndpoint: Schema.optional(
    Schema.Struct({ watchEndpoint: Schema.optional(Schema.Struct({ videoId: Schema.String })) })
  ),
  airings: Schema.optional(
    Schema.Array(
      Schema.Struct({
        epgAiringRenderer: Schema.optional(
          Schema.Struct({
            beginTimeMs: Schema.String,
            endTimeMs: Schema.String,
            title: Schema.optional(Schema.NullOr(Text))
          })
        )
      })
    )
  )
})

/** The first page of YouTube TV's live guide, as the guide page loads it (`browse`, `FEunplugged_epg`). */
export const GuideResponse = Schema.Struct({
  contents: Schema.Struct({
    epgRenderer: Schema.Struct({
      paginationRenderer: Schema.Struct({
        epgPaginationRenderer: Schema.Struct({
          contents: Schema.Array(Schema.Struct({ epgRowRenderer: Schema.optional(Row) }))
        })
      })
    })
  })
})

export const GuideResponseJson = Schema.fromJsonString(GuideResponse)
```

Unknown keys are ignored when decoding (`onExcessProperty` defaults to `"ignore"`), so the full, unreduced response decodes the same way.

- [ ] **Step 6: The source reads guides**

In `apps/hub/src/source/youtube-tv/YouTubeTv.ts`, the layer keeps a second ref for the latest guide and answers availability from it:

```ts
import type { GameSnapshot } from "@sportal/domain/Game"
import {
  type Airing,
  type ChannelCarriage,
  ChannelId,
  ChannelLineup,
  ChannelUrlRefused,
  Guide,
  GuideUnreadable
} from "@sportal/domain/Source"
import { DateTime, Effect, Layer, Option, Schema, SchemaTransformation, Stream, SubscriptionRef } from "effect"
import { ChannelStore } from "../ChannelStore.ts"
import { Source } from "../Source.ts"
import * as YouTubeTvPayload from "./YouTubeTvPayload.ts"

/**
 * YouTube TV as a source. Its guide, read by the shell from the guide page, says where each game airs; until
 * one is read, the channels the user has picked by hand, kept in the channel store, do.
 */
export const layer = Layer.effect(
  Source,
  Effect.gen(function* () {
    const store = yield* ChannelStore
    const lineup = yield* SubscriptionRef.make(
      new ChannelLineup({ source: "YouTube TV", guide, carriages: yield* store.carriages })
    )
    const latest = yield* SubscriptionRef.make(Option.none<Guide>())

    // Store first, then memory, one write at a time: a failed write changes nothing.
    const record = (carriage: ChannelCarriage) =>
      SubscriptionRef.updateEffect(lineup, (current) =>
        store.record(carriage).pipe(Effect.as(current.record(carriage)))
      )

    return Source.of({
      availability: Effect.gen(function* () {
        const learned = yield* SubscriptionRef.get(lineup)
        const read = yield* SubscriptionRef.get(latest)
        return (game: GameSnapshot) =>
          Option.match(read, {
            onNone: () => learned.availabilityOf(game),
            onSome: (current) => current.availabilityOf(game)
          })
      }),
      // A ref's current value comes first on every subscription; only later values are changes.
      changes: Stream.merge(
        SubscriptionRef.changes(lineup).pipe(Stream.drop(1)),
        SubscriptionRef.changes(latest).pipe(Stream.drop(1))
      ).pipe(Stream.as(undefined)),
      readGuide: (response) =>
        Effect.gen(function* () {
          const decoded = yield* decodeGuide(response).pipe(Effect.mapError(() => new GuideUnreadable()))
          const read = toGuide(decoded, yield* DateTime.now)
          if (read.channels.length === 0) return yield* Effect.fail(new GuideUnreadable())
          yield* SubscriptionRef.set(latest, Option.some(read))
        }),
      learn: (network, url) =>
        decodeLiveChannelUrl(url).pipe(
          Effect.mapError(() => new ChannelUrlRefused()),
          Effect.flatMap((live) =>
            record({
              _tag: "Carried",
              network,
              channel: { name: network, source: "YouTube TV", locator: { _tag: "WebView", url: live } }
            })
          )
        ),
      markNotCarried: (network) => record({ _tag: "NotCarried", network, source: "YouTube TV" }),
      forget: (network) =>
        SubscriptionRef.updateEffect(lineup, (current) =>
          store.forget(network, "YouTube TV").pipe(Effect.as(current.forget(network)))
        )
    })
  })
)
```

`LiveChannelUrl`, `decodeLiveChannelUrl`, `live`, and `guide` stay as they are, below the layer. Add below them, in order of first use:

```ts
const decodeGuide = Schema.decodeEffect(YouTubeTvPayload.GuideResponseJson)

/** The channels and airings of one guide response, read at `readAt`. Rows without an id or a name are skipped. */
function toGuide(response: typeof YouTubeTvPayload.GuideResponse.Type, readAt: DateTime.Utc): Guide {
  const channels: Array<Guide["channels"][number]> = []
  const airings: Array<Airing> = []
  for (const { epgRowRenderer: row } of response.contents.epgRenderer.paginationRenderer.epgPaginationRenderer
    .contents) {
    const station = row?.station?.epgStationRenderer
    const id = station?.stationId
    const name = station?.icon?.accessibility?.accessibilityData.label
    if (row === undefined || id === undefined || id === null || name === undefined) continue
    const channel = ChannelId.make(id)
    const videoId = row.navigationEndpoint?.watchEndpoint?.videoId
    channels.push({
      id: channel,
      name,
      ...(videoId === undefined
        ? {}
        : { live: { _tag: "WebView" as const, url: `https://tv.youtube.com/watch/${videoId}?vp=${live}` } })
    })
    for (const { epgAiringRenderer: airing } of row.airings ?? []) {
      const title = airing?.title?.runs[0].text
      const begin = Number(airing?.beginTimeMs)
      const end = Number(airing?.endTimeMs)
      // A row with nothing listed has one untitled airing spanning all of time.
      if (title === undefined || !Number.isFinite(begin) || begin < 0 || !Number.isFinite(end)) continue
      airings.push({ channel, title, begin: DateTime.makeUnsafe(begin), end: DateTime.makeUnsafe(end) })
    }
  }
  return new Guide({ source: "YouTube TV", readAt, channels, airings })
}
```

- [ ] **Step 7: The Stage reads availability from the source**

In `apps/hub/src/stage/StageSessions.ts`, `availabilityOnSlate`:

```ts
/** Where each game on the current slate can be streamed; a game no longer on the slate has no availability. */
function availabilityOnSlate(ingest: typeof Ingest.Service, source: typeof Source.Service) {
  return Effect.gen(function* () {
    const slate = yield* ingest.slate
    const availabilityOf = yield* source.availability
    return (id: GameId): Option.Option<ChannelAvailability> =>
      Option.fromNullishOr(slate.find((candidate) => candidate.id === id)).pipe(Option.map(availabilityOf))
  })
}
```

In `StageSessions.test.ts`, the test "applies a command with the lineup as it is when the command lands" gates `availability` instead of `lineup`: the wrapper reads `const seen = yield* source.availability` and the returned service is `Source.of({ ...source, availability })`. Rename its title to "applies a command with availability as it is when the command lands, not as it was read".

- [ ] **Step 8: Import boundaries**

In `.dependency-cruiser.cjs`, the payload rule covers sources too, and the adapter rule names the new folder:

```diff
     {
       name: "provider-payloads-are-private",
-      comment: "A provider's wire vocabulary stays inside its folder.",
+      comment: "A provider's or source's wire vocabulary stays inside its folder.",
       severity: "error",
-      from: { pathNot: "^apps/hub/src/provider/([^/]+)/" },
-      to: { path: "^apps/hub/src/provider/[^/]+/[^/]*Payload\\.ts$" }
+      from: { pathNot: "^apps/hub/src/(provider|source)/([^/]+)/" },
+      to: { path: "^apps/hub/src/(provider|source)/[^/]+/[^/]*Payload\\.ts$" }
     },
```

```diff
         pathNot:
-          "(^apps/hub/src/main\\.ts$|\\.test\\.ts$|^apps/hub/src/provider/[^/]+/|^apps/hub/src/source/Sql[^/]+\\.ts$)"
+          "(^apps/hub/src/main\\.ts$|\\.test\\.ts$|^apps/hub/src/provider/[^/]+/|^apps/hub/src/source/youtube-tv/|^apps/hub/src/source/Sql[^/]+\\.ts$)"
       },
       to: {
-        path: "^apps/hub/src/(provider/[^/]+/|source/YouTubeTv\\.ts$|source/Sql[^/]+\\.ts$|database/)"
+        path: "^apps/hub/src/(provider/[^/]+/|source/youtube-tv/|source/Sql[^/]+\\.ts$|database/)"
       }
```

- [ ] **Step 9: Run everything**

Run: `pnpm check`
Expected: PASS, including both match tests. If a match test's numbers differ, print the per-game availability, compare with the spec's spike table, and fix the code, not the numbers.

- [ ] **Step 10: Commit**

```bash
git add -A apps/hub .dependency-cruiser.cjs
git commit -m "feat(hub): YouTube TV reads its guide and answers availability from it"
```

---

### Task 5: The guide API, and the Stage follows the guide

**Files:**
- Modify: `packages/api/src/SportalApi.ts` (a `guide` group)
- Modify: `apps/hub/src/http/HubServer.ts` (its handler)
- Test: `apps/hub/src/http/HubServer.test.ts`

**Interfaces:**
- Consumes: `Source.readGuide`, `GuideUnreadable` (Tasks 3, 4).
- Produces: `POST /api/guide` with payload `{ guide: string }`, `204` on success, `GuideUnreadable` (422) on failure; client method `hub.guide.read({ payload: { guide } })`.

- [ ] **Step 1: Write the failing test**

In `apps/hub/src/http/HubServer.test.ts`, `makeClient` adds the group: `HttpApiTest.groups(SportalApi, ["slate", "stage", "channels", "guide"])`. Add, inside `describe("Hub API")`:

```ts
  it.live("reads a guide the size of a real one, and a waiting tile plays once its airing is on", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      const sessions = yield* StageSessions
      yield* firstSlate()
      yield* client.stage.dispatch({ payload: { command: { _tag: "Assign", tile: 0, game: game.id } } })

      // The game's teams and network are on ESPN, on now, in this guide; padding brings it to a real response's size.
      const now = DateTime.toEpochMillis(yield* DateTime.now)
      const guide = JSON.stringify({
        contents: {
          epgRenderer: {
            paginationRenderer: {
              epgPaginationRenderer: {
                contents: [
                  {
                    epgRowRenderer: {
                      station: {
                        epgStationRenderer: {
                          stationId: "UCW7W_WAogi3qWDbO9PqOmZQ",
                          icon: { accessibility: { accessibilityData: { label: "ESPN" } } }
                        }
                      },
                      navigationEndpoint: { watchEndpoint: { videoId: "PFuNFGzJDE4" } },
                      airings: [
                        {
                          epgAiringRenderer: {
                            beginTimeMs: String(now - 3_600_000),
                            endTimeMs: String(now + 3_600_000),
                            title: { runs: [{ text: "ALA at MSST" }] }
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            }
          }
        },
        padding: "x".repeat(700_000)
      })
      yield* client.guide.read({ payload: { guide } })

      const tile = yield* tileOnceItIs(sessions, "StreamTile")
      assert.deepStrictEqual(tile, {
        _tag: "StreamTile",
        game: game.id,
        channel: {
          name: "ESPN",
          source: "YouTube TV",
          locator: { _tag: "WebView", url: "https://tv.youtube.com/watch/PFuNFGzJDE4?vp=0gEEEgIwAQ%3D%3D" }
        }
      })
    }).pipe(Effect.provide(apiUnderTest()))
  )

  it.effect("refuses a guide it cannot read", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      const error = yield* client.guide.read({ payload: { guide: "{}" } }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "GuideUnreadable")
    }).pipe(Effect.provide(apiUnderTest()))
  )
```

`game` in this file is live with teams named `ALA` and `MSST` by `TestGame.team`, so its location is its abbreviation and the title "ALA at MSST" names both. Its kickoff is TestGame's default, `2026-10-03T16:00:00Z`; the airing is on now and the game is live, so it matches however far the clock is from kickoff.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/hub/src/http`
Expected: FAIL. There is no `guide` group.

- [ ] **Step 3: The endpoint and its handler**

In `packages/api/src/SportalApi.ts`, import `GuideUnreadable` beside `ChannelUrlRefused` and add a group after `channels`:

```ts
  .add(
    // A guide the shell read from the source's guide page, passed on unchanged; the Hub decodes it.
    HttpApiGroup.make("guide").add(
      HttpApiEndpoint.post("read", "/guide", {
        payload: Schema.Struct({ guide: Schema.String }),
        success: HttpApiSchema.NoContent,
        error: GuideUnreadable
      })
    )
  )
```

In `apps/hub/src/http/HubServer.ts`, `ApiHandlers` merges `guideHandlers()`:

```ts
export const ApiHandlers = Layer.mergeAll(slateHandlers(), stageHandlers(), channelHandlers(), guideHandlers())
```

with, after `channelHandlers`:

```ts
function guideHandlers() {
  return HttpApiBuilder.group(
    SportalApi,
    "guide",
    Effect.fn(function* (handlers) {
      const source = yield* Source
      return handlers.handleAll({
        read: ({ payload }) =>
          source
            .readGuide(payload.guide)
            .pipe(
              Effect.tapError(() =>
                Effect.logWarning(`HubServer: a guide of ${payload.guide.length} characters could not be read`)
              )
            )
      })
    })
  )
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/hub/src/http`
Expected: PASS. If the padded request is refused for its size, find the request body limit in `node_modules/.pnpm/effect@4.0.0/node_modules/effect/src/http/` (search `maxBodySize`), raise it in `main.ts` and in the test's layer to 4 MB, and say so in the commit message.

- [ ] **Step 5: Run everything, then commit**

Run: `pnpm check`
Expected: PASS.

```bash
git add -A packages/api apps/hub/src
git commit -m "feat(hub): POST /api/guide, and tiles follow the guide"
```

---

### Task 6: The shell reads the guide

**Files:**
- Create: `apps/desktop/src/main/GuideReader.ts`
- Test: `apps/desktop/src/main/GuideReader.test.ts`
- Modify: `packages/api/src/ShellBridge.ts`, `apps/desktop/src/preload/ShellBridge.ts`, `apps/desktop/src/main/main.ts`
- Modify: `CONTEXT.md` (Guide reader row)

**Interfaces:**
- Consumes: `ProviderSession.createView` (existing).
- Produces:
  - `GuideReader` service: `guides: Stream<string>` (each guide response body, unchanged) and `readSoon: Effect<void>`.
  - Bridge: `onGuideRead(listener: (guide: string) => void): () => void` and `readGuide(): void`; IPC channels `sportal:guide-read` (main → page) and `sportal:read-guide` (page → main).

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/main/GuideReader.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"

const created: Array<{ webContents: ReturnType<typeof fakeContents> }> = []

vi.mock("electron", () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn() }) },
  WebContentsView: class {
    readonly setBounds = vi.fn()
    readonly webContents = fakeContents()
    constructor() {
      created.push(this)
    }
  }
}))

const { ProviderSession } = await import("./ProviderSession.ts")
const { GuideReader } = await import("./GuideReader.ts")

const guideRequest = {
  url: "https://tv.youtube.com/youtubei/v1/browse?prettyPrint=false",
  postData: JSON.stringify({ browseId: "FEunplugged_epg" })
}
const overlaysRequest = {
  url: "https://tv.youtube.com/youtubei/v1/browse?prettyPrint=false",
  postData: JSON.stringify({ browseId: "FEunplugged_overlays" })
}

describe("GuideReader", () => {
  it.effect("opens the guide when asked, publishes the guide response, and closes the view", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      const guides = yield* collect(reader.guides, 1)
      yield* reader.readSoon
      yield* settle
      const contents = created[0]?.webContents
      expect(contents?.loadURL).toHaveBeenCalledWith("https://tv.youtube.com/live")
      expect(contents?.setAudioMuted).toHaveBeenCalledWith(true)

      contents?.inspector.respond("1", "the guide")
      contents?.inspector.respond("2", "the overlays")
      contents?.inspector.emit("Network.requestWillBeSent", { requestId: "2", request: overlaysRequest })
      contents?.inspector.emit("Network.requestWillBeSent", { requestId: "1", request: guideRequest })
      contents?.inspector.emit("Network.loadingFinished", { requestId: "2" })
      contents?.inspector.emit("Network.loadingFinished", { requestId: "1" })

      expect(yield* Fiber.join(guides)).toEqual(["the guide"])
      yield* settle
      expect(contents?.close).toHaveBeenCalled()
    }).pipe(Effect.scoped)
  )

  it.effect("does not open the guide until asked, then reads it every 15 minutes", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      yield* settle
      expect(created).toHaveLength(0)
      yield* reader.readSoon
      yield* settle
      expect(created).toHaveLength(1)
      yield* TestClock.adjust("31 seconds") // the first read gives up
      yield* TestClock.adjust("15 minutes")
      yield* settle
      expect(created).toHaveLength(2)
    }).pipe(Effect.scoped)
  )

  it.effect("gives up after 30 seconds without a guide response, closing the view", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      const guides = yield* collect(reader.guides, 1)
      yield* reader.readSoon
      yield* settle
      yield* TestClock.adjust("30 seconds")
      yield* settle
      expect(created[0]?.webContents.close).toHaveBeenCalled()
      expect(Option.isNone(yield* Fiber.poll(guides))).toBe(true)
    }).pipe(Effect.scoped)
  )

  it.effect("reads at most once in two minutes however often it is asked", () =>
    Effect.gen(function* () {
      const reader = yield* attached()
      yield* reader.readSoon
      yield* settle
      yield* TestClock.adjust("30 seconds")
      yield* reader.readSoon
      yield* reader.readSoon
      yield* settle
      expect(created).toHaveLength(1)
      // The first read ended at 30 seconds; the next may start two minutes after that.
      yield* TestClock.adjust("2 minutes")
      yield* settle
      expect(created).toHaveLength(2)
    }).pipe(Effect.scoped)
  )
})

/** Lets forked fibers and resolved promises run. */
const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve))).pipe(
  Effect.repeat({ times: 5 })
)

function collect<A>(stream: Stream.Stream<A>, count: number) {
  return Effect.gen(function* () {
    const fiber = yield* stream.pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    return fiber
  })
}

function attached() {
  created.length = 0
  return Layer.build(GuideReader.layer.pipe(Layer.provide(ProviderSession.layer))).pipe(
    Effect.map((context) => Context.get(context, GuideReader))
  )
}

/** A debugger that records its listener, so a test can emit protocol events and set response bodies. */
function fakeInspector() {
  const bodies = new Map<string, string>()
  let listener: ((event: unknown, method: string, params: unknown) => void) | undefined
  return {
    attach: vi.fn(),
    detach: vi.fn(),
    isAttached: () => true,
    on: vi.fn((_event: "message", next: typeof listener) => {
      listener = next
    }),
    removeListener: vi.fn(),
    sendCommand: vi.fn((method: string, params?: { requestId?: string }) =>
      Promise.resolve(
        method === "Network.getResponseBody"
          ? { body: bodies.get(params?.requestId ?? "") ?? "", base64Encoded: false }
          : {}
      )
    ),
    respond: (requestId: string, body: string) => bodies.set(requestId, body),
    emit: (method: string, params: unknown) => listener?.({}, method, params)
  }
}

function fakeContents() {
  const inspector = fakeInspector()
  return {
    loadURL: vi.fn(() => Promise.resolve()),
    setAudioMuted: vi.fn(),
    close: vi.fn(),
    isDestroyed: () => false,
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    debugger: inspector,
    inspector
  }
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/desktop/src/main/GuideReader.test.ts`
Expected: FAIL. `./GuideReader.ts` does not exist.

- [ ] **Step 3: Write the reader**

`apps/desktop/src/main/GuideReader.ts`:

```ts
import { Context, Effect, Layer, Option, PubSub, Queue, Schema, Stream } from "effect"
import type { WebContentsView } from "electron"
import { ProviderSession } from "./ProviderSession.ts"

/**
 * Reads YouTube TV's live guide the way its own page loads it. A hidden, muted view on the provider session
 * opens the guide; the debugger, attached to that view alone, reads the body of the page's guide response; the
 * view then closes, because the guide plays a preview while it is open. Nothing is injected, and no request is
 * made or changed.
 */
export class GuideReader extends Context.Service<
  GuideReader,
  {
    /** Each guide response, as the page received it. */
    readonly guides: Stream.Stream<string>
    /** Asks for a read. Asking while a read waits adds nothing; reads are at least two minutes apart. */
    readonly readSoon: Effect.Effect<void>
  }
>()("sportal/desktop/GuideReader") {
  static readonly layer = Layer.effect(
    GuideReader,
    Effect.gen(function* () {
      const providers = yield* ProviderSession
      const guides = yield* PubSub.unbounded<string>()
      const requests = yield* Queue.sliding<void>(1)

      const read = Effect.gen(function* () {
        const view = yield* Effect.acquireRelease(providers.createView, (view) =>
          Effect.sync(() => {
            if (!view.webContents.isDestroyed()) view.webContents.close()
          })
        )
        view.webContents.setAudioMuted(true)
        return yield* guideResponse(view).pipe(Effect.timeoutOption("30 seconds"))
      }).pipe(
        Effect.scoped,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.logWarning("GuideReader: no guide response within 30 seconds"),
            onSome: (guide) => PubSub.publish(guides, guide)
          })
        ),
        Effect.catchTag("GuideNotRead", (failure) =>
          Effect.logWarning("GuideReader: the guide could not be read", failure.cause)
        )
      )

      // The first read waits to be asked, so the web UI is listening before a guide arrives.
      yield* Effect.forkScoped(
        Effect.forever(Queue.take(requests).pipe(Effect.andThen(read), Effect.andThen(Effect.sleep("2 minutes"))))
      )
      yield* Effect.forkScoped(
        Effect.forever(Effect.sleep("15 minutes").pipe(Effect.andThen(Queue.offer(requests, undefined))))
      )

      return GuideReader.of({
        guides: Stream.fromPubSub(guides),
        readSoon: Queue.offer(requests, undefined).pipe(Effect.asVoid)
      })
    })
  )
}

class GuideNotRead extends Schema.TaggedError<GuideNotRead>()("GuideNotRead", { cause: Schema.Defect() }) {}

/** Opens the guide in `view` and resumes with the body of its guide response. */
function guideResponse(view: WebContentsView) {
  return Effect.callback<string, GuideNotRead>((resume) => {
    const inspector = view.webContents.debugger
    const guideRequests = new Set<string>()
    const failed = (cause: unknown) => resume(Effect.fail(new GuideNotRead({ cause })))

    const onMessage = (_event: unknown, method: string, params: unknown) => {
      if (method === "Network.requestWillBeSent") {
        const sent = decodeRequestWillBeSent(params)
        if (Option.isSome(sent) && isGuideRequest(sent.value.request)) guideRequests.add(sent.value.requestId)
      }
      if (method === "Network.loadingFinished") {
        const finished = decodeLoadingFinished(params)
        if (Option.isNone(finished) || !guideRequests.has(finished.value.requestId)) return
        inspector
          .sendCommand("Network.getResponseBody", { requestId: finished.value.requestId })
          .then((raw: unknown) => {
            const body = decodeResponseBody(raw)
            if (Option.isNone(body)) return failed("the response body had an unexpected shape")
            const { body: text, base64Encoded } = body.value
            resume(Effect.succeed(base64Encoded ? Buffer.from(text, "base64").toString("utf8") : text))
          }, failed)
      }
    }

    try {
      inspector.attach("1.3")
    } catch (cause) {
      failed(cause)
      return
    }
    inspector.on("message", onMessage)
    // A load that fails or is cut short shows up as the 30-second timeout; its rejection carries nothing more.
    inspector
      .sendCommand("Network.enable")
      .then(() => view.webContents.loadURL(guideUrl).catch(() => undefined), failed)
    return Effect.sync(() => {
      inspector.removeListener("message", onMessage)
      if (inspector.isAttached()) inspector.detach()
    })
  })
}

const guideUrl = "https://tv.youtube.com/live"

const decodeRequestWillBeSent = Schema.decodeUnknownOption(
  Schema.Struct({
    requestId: Schema.String,
    request: Schema.Struct({ url: Schema.String, postData: Schema.optional(Schema.String) })
  })
)

/** The guide page asks for its guide with `browse`, naming the guide's browse id in the request body. */
function isGuideRequest(request: { readonly url: string; readonly postData?: string | undefined }) {
  return (
    URL.canParse(request.url) &&
    new URL(request.url).pathname === "/youtubei/v1/browse" &&
    request.postData?.includes('"FEunplugged_epg"') === true
  )
}

const decodeLoadingFinished = Schema.decodeUnknownOption(Schema.Struct({ requestId: Schema.String }))

const decodeResponseBody = Schema.decodeUnknownOption(
  Schema.Struct({ body: Schema.String, base64Encoded: Schema.Boolean })
)
```

`ProviderSession.createView` confines the view to the four allowed hosts, which covers `tv.youtube.com`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/desktop/src/main/GuideReader.test.ts`
Expected: PASS.

- [ ] **Step 5: The bridge and the shell's wiring**

In `packages/api/src/ShellBridge.ts`, add to `ShellBridge`:

```ts
  /** Calls `listener` with each guide the shell reads from the source's guide page, unchanged. Returns a function that stops the calls. */
  onGuideRead(listener: (guide: string) => void): () => void
  /** Asks the shell to read the guide soon: at start, and when a game waiting for its airing should be on. */
  readGuide(): void
```

In `apps/desktop/src/preload/ShellBridge.ts`:

```ts
  onGuideRead: (listener) => {
    // The page gets the guide alone, never the IPC event.
    const forward = (_event: IpcRendererEvent, guide: string) => listener(guide)
    ipcRenderer.on("sportal:guide-read", forward)
    return () => {
      ipcRenderer.removeListener("sportal:guide-read", forward)
    }
  },
  readGuide: () => ipcRenderer.send("sportal:read-guide")
```

In `apps/desktop/src/main/main.ts`, provide the reader beside the tile views:

```ts
    return Layer.effectDiscard(serveHub(window, hubUrl)).pipe(
      Layer.provide(Layer.mergeAll(TileViews.layer(window), GuideReader.layer)),
      Layer.provide(ProviderSession.layer)
    )
```

and in `serveHub`, after the channel-picks fork:

```ts
    const reader = yield* GuideReader
    yield* Effect.forkScoped(
      reader.guides.pipe(
        Stream.runForEach((guide) =>
          Effect.sync(() => {
            if (!window.isDestroyed()) window.webContents.send("sportal:guide-read", guide)
          })
        )
      ),
      { startImmediately: true }
    )
    const readGuide = (event: IpcMainEvent) => {
      if (event.sender === window.webContents) run(reader.readSoon)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => ipcMain.on("sportal:read-guide", readGuide)),
      () => Effect.sync(() => ipcMain.removeListener("sportal:read-guide", readGuide))
    )
```

with `import { GuideReader } from "./GuideReader.ts"`.

- [ ] **Step 6: Glossary**

In `CONTEXT.md`, under **Devices**, after **Channel pick**:

```
| **Guide reader** | The shell component that opens a source's guide in a hidden view, reads the guide page's own response, and closes the view. | scraper, EPG fetcher |
```

- [ ] **Step 7: Run everything, then commit**

Run: `pnpm check`
Expected: PASS.

```bash
git add -A apps/desktop packages/api CONTEXT.md
git commit -m "feat(desktop): the guide reader reads YouTube TV's guide from its own page"
```

---

### Task 7: The web UI relays guides and says why a game has no stream

**Files:**
- Create: `apps/web/src/LocalTime.ts`
- Modify: `apps/web/src/slate/SlateView.tsx`, `apps/web/src/hub/HubClient.ts`, `apps/web/src/stage/StageView.tsx`

**Interfaces:**
- Consumes: bridge `onGuideRead`, `readGuide` (Task 6); `hub.guide.read` (Task 5); `DataTile.why` (Task 3).
- Produces: `localTime(at: DateTime.Utc): string`; `sendGuide(guide: string): void`.

- [ ] **Step 1: One way to print a time**

`apps/web/src/LocalTime.ts`:

```ts
import { DateTime } from "effect"

/** A time of day as this browser shows it ("1:00 PM"). */
export function localTime(at: DateTime.Utc): string {
  return DateTime.toDateUtc(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}
```

In `apps/web/src/slate/SlateView.tsx`, line 67 becomes `return localTime(game.kickoff)`, importing `localTime` from `../LocalTime.ts`. Remove `DateTime` from that file's imports if nothing else uses it.

- [ ] **Step 2: Send a guide to the Hub**

In `apps/web/src/hub/HubClient.ts`:

```ts
/** Passes a guide the shell read to the Hub. The tiles it changes arrive on the live stream. */
export function sendGuide(guide: string): void {
  runtime.runFork(HubClient.use((hub) => hub.guide.read({ payload: { guide } })))
}
```

- [ ] **Step 3: Relay guides, re-read when a waiting game should be on, and say why**

In `apps/web/src/stage/StageView.tsx`, after the channel-picks effect:

```tsx
  useEffect(() => {
    // Listening first, then asking: the shell reads the guide when the web UI asks for it.
    const stop = window.sportalShell?.onGuideRead(sendGuide)
    window.sportalShell?.readGuide()
    return stop
  }, [])

  useEffect(() => {
    // A game waiting for its airing plays once a guide read after its begin shows the channel on the air.
    const due = props.stage.tiles.flatMap((tile) =>
      tile._tag === "DataTile" && tile.why._tag === "NotYet" && tile.why.begin !== undefined
        ? [DateTime.toEpochMillis(tile.why.begin)]
        : []
    )
    if (due.length === 0) return
    const timer = setTimeout(() => window.sportalShell?.readGuide(), Math.max(0, Math.min(...due) - Date.now()) + 60_000)
    return () => clearTimeout(timer)
  }, [props.stage])
```

In `TileBody`, the data tile:

```tsx
    case "DataTile":
      return <span>{noStream(props.tile.why)}</span>
```

with, below `TileBody`:

```tsx
function noStream(why: Extract<Tile, { _tag: "DataTile" }>["why"]): string {
  switch (why._tag) {
    case "NoStream":
      return "No stream for this game on your sources"
    case "StreamingOnly":
      return "Streaming only: not on YouTube TV"
    case "NotInGuide":
      return "Not in your YouTube TV guide"
    case "NotYet":
      return why.channel === undefined
        ? "Not in your YouTube TV guide yet"
        : `On ${why.channel}${why.begin === undefined ? "" : ` at ${localTime(why.begin)}`}`
  }
}
```

Imports: `DateTime` from `effect` beside `Option`; `sendGuide` from `../hub/HubClient.ts`; `localTime` from `../LocalTime.ts`.

- [ ] **Step 4: Run everything, then commit**

Run: `pnpm check`
Expected: PASS.

```bash
git add -A apps/web
git commit -m "feat(web): relay guides to the Hub, re-read when a waiting game starts, and say why a game has no stream"
```

---

### Task 8: Docs, and the game-day check

**Files:**
- Modify: `docs/adr/0002-desktop-shell-playback.md`, `docs/game-day-checklist.md`, `docs/technical-spec.md`, `docs/specs/2026-10-03-guide-matched-channels-design.md`

- [ ] **Step 1: Amend ADR 0002**

Append to `docs/adr/0002-desktop-shell-playback.md`:

```markdown
## Amendment: the guide reader (2026-10-03)

Channels are found in YouTube TV's own guide instead of being picked per network
(`docs/specs/2026-10-03-guide-matched-channels-design.md`). "Provider pages are loaded unmodified" stands.
Added: the shell may open a hidden, muted guide view on the provider session and attach the debugger to that
view alone, to read the body of the guide page's own `browse` response for `FEunplugged_epg`. It injects
nothing, changes and makes no requests, never reads another view, and closes the guide view after each read
because the guide plays a preview while open. Reads happen when the web UI asks, then every 15 minutes,
at least two minutes apart.
```

- [ ] **Step 2: Game-day rows**

In `docs/game-day-checklist.md`, rows 3 and 4 (picking a channel for a never-seen network) are replaced, and rows are added at the end. Renumber the rows that follow.

```markdown
| 3 | With a fresh `.sportal/` data directory, open the shell and watch its terminal | No `GuideReader:` warning; within a minute the Hub log shows no `could not be read` |
| 4 | Click a live game on a network never used before | It plays within a few seconds, with no guide shown in the tile |
```

```markdown
| 20 | Click a game kicking off in more than half an hour | The tile reads "On <channel> at <time>"; it plays on its own within two minutes of that time |
| 21 | On an NFL Sunday, click two CBS games at 1:00 PM | Each plays its own game, each on its own "NFL ST - CBS" station |
| 22 | Click an ESPN+ game | "Streaming only: not on YouTube TV", with no picking tile |
| 23 | With three tiles playing, wait for a guide read (or reopen the shell) | All three keep playing through the read; record anything the provider shows about the stream limit |
| 24 | During a read, look for a window or sound | None: the guide view is never shown and is muted |
```

- [ ] **Step 3: Technical spec**

In `docs/technical-spec.md`:
- In the file tree, replace the `YouTubeTv.ts` line with `source/youtube-tv/YouTubeTv.ts  Guide reading, availability, learned channels` and add `YouTubeTvPayload.ts  The guide response's wire shape`, and in the desktop tree `GuideReader.ts  Reads the source's guide from its own page`.
- In the `Source` port block, replace `readonly lineup: Effect<ChannelLineup>` with `readonly availability: Effect<(game: GameSnapshot) => ChannelAvailability>` and add `readGuide(guide: string): Effect<void, GuideUnreadable>`.
- After "A source's channels are learned from the user…", replace that sentence with: "A source's channels are found in its own guide, read by the shell (`docs/specs/2026-10-03-guide-matched-channels-design.md`); channels picked by hand answer only until a guide is read."
- Add **Guide**, **Airing**, and **Guide reader** to the glossary excerpt, matching `CONTEXT.md`.

- [ ] **Step 4: Spec status**

In `docs/specs/2026-10-03-guide-matched-channels-design.md`, the status line reads:

```
Status: Approved 2026-10-03 with its plan (`docs/plans/2026-10-03-guide-matched-channels.md`), which records where it differs
```

- [ ] **Step 5: Check, commit**

Run: `pnpm check`
Expected: PASS.

```bash
git add docs
git commit -m "docs: guide reader ADR amendment, game-day rows, technical spec"
```

- [ ] **Step 6: By hand (the user runs the shell)**

Electron launched from an agent's shell misreports rendering on this machine, so the user runs `pnpm dev` and works through rows 3, 4, and 20–24 on the next game window. Record the date, the build, and any row that failed in the checklist's run log.

---

## Self-review

- **Spec coverage.**
  - Broadcast medium: Task 1.
  - Guide, airing, matching, upcoming, reasons: Task 3.
  - Decoding, availability, the match rate on recordings: Task 4.
  - API and refresh: Task 5.
  - Guide reader and bridge: Task 6.
  - Relay, re-read, data-tile text: Task 7.
  - ADR amendment, checklist, glossary: Tasks 3, 6, 8.
  - Overrides first: changed by this plan, recorded above.
  - Account data in fixtures: "Decide before Task 4".
  - Stream budget: checklist row 23.
- **Type names used across tasks.** `Broadcast`, `Channel { name, source, locator }`, `ChannelCarriage.Carried { network, channel }`, `ChannelAvailability` (`Carried { channel, learnedFor }`, `Upcoming { channel, begin }`, `Unlearned`, `NotCarried { why }`), `Guide`, `Airing`, `ChannelId`, `GuideUnreadable`, `DataTile.why` (`NoStream`, `StreamingOnly`, `NotInGuide`, `NotYet`), `Source.availability`, `Source.readGuide`, `GuideReader.guides`, `GuideReader.readSoon`, bridge `onGuideRead` / `readGuide`, `HubClient.sendGuide`, `localTime`.
