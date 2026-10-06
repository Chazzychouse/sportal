# Guide-only channels — design

Status: approved in brainstorming, 2026-10-06.

A source answers "where does this game air?" in two ways today. The **guide** (`Guide.availabilityOf`) matches
the game against the source's own listing. The **channel lineup** (`ChannelLineup.availabilityOf`) replays
channels the user picked by hand, kept in the channel store. The lineup came first; since guide-matched channels
(2026-10-03) it answers only when no guide has been read or the last one is over 45 minutes old. It is one
fallback behind the `Source` port, yet it reaches every app: two domain types, a tile kind, a field on stream
tiles, a store with its table, three API endpoints, a shell IPC channel, a second kind of tile view, and three
buttons. This spec removes it. The guide becomes the only answer.

## Decisions

- **No hand-picked escape hatch.** When the guide does not match a game (a listing the team matcher misses, or
  a guide response the decoder no longer reads), the game is a data tile. Nothing replaces picking a channel,
  not even an unstored one-off pick.
- **No fresh guide is its own answer.** Before the first read, and once the latest read is stale (45 minutes,
  unchanged), a source answers **no guide** for every game. It is not "not carried": the source has not said.
- **Playing tiles keep playing.** A stream tile changes only when the guide says the game is carried on
  another channel. No guide, upcoming, or not carried leaves it playing. This is today's rule for guide-matched
  tiles, now the only rule.
- **The `channel_carriage` table is left in place.** Its owner, the channel store, is deleted, and no store is
  left to own a migration that drops it. It is one small table in the user's own `sportal.sqlite`; nothing reads
  it. (`channel_migrations` stays with it.)
- **Scope:** domain, api, Hub, shell, web, tests, docs. One branch, `guide-only`, in `../sportal-guide-only`.

## Target shape

### Domain — `packages/domain/src/Channel.ts`

Keeps `SourceName`, `Channel`, `ChannelAvailability`. Loses `ChannelCarriage`, `ChannelLineup`,
`ChannelUrlRefused`.

```ts
export type ChannelAvailability = Data.TaggedEnum<{
  Carried: { readonly channel: Channel }                       // learnedFor removed
  Upcoming: { readonly channel: Option.Option<string>; readonly begin: Option.Option<DateTime.Utc> }
  NotCarried: { readonly why: "NoStream" | "StreamingOnly" | "NotInGuide" }
  NoGuide: { readonly source: SourceName }                      // replaces Unlearned
}>
```

`Guide.availabilityOf` is unchanged except that `Carried` has no `learnedFor`.

### Domain — `packages/domain/src/Stage.ts`

- `Tile` loses `PickingChannel`. `StreamTile` loses `learnedFor`.
- `DataTile.why` gains `NoGuide: {}`.
- `Stage.refresh(availabilityOf)`: a `StreamTile` is replaced only by `Carried` on a channel whose locator differs
  from its own; every other tile follows the answer as `apply` would place it.
- `tileFor` maps `NoGuide` to `DataTile { why: NoGuide }`.

### Hub

- `Source` (`source/Source.ts`) becomes `availability`, `changes`, `readGuide`. `learn`, `markNotCarried`,
  `forget` go, and with them its dependency on `ChannelStoreError`.
- `YouTubeTv.layer` no longer needs `ChannelStore`. Its state is the latest fresh guide or none
  (`SubscriptionRef<Option<Guide>>`); availability with none is `NoGuide { source }`. The expiry fiber stays, so
  a stale guide still emits a change. `LiveChannelUrl` stays for the guide's live addresses; `decodeLiveChannelUrl`
  (used only by `learn`) goes.
- `ScenarioSource` drops the three stubs.
- `ChannelStore.ts` and its test are deleted; `HubMode` stops providing it.
- `HubServer` drops the `channels` group.

### API — `packages/api`

- `SportalApi` drops the `channels` group.
- `ShellChannel` drops `channelPicked`; `ShellBridge` drops `ChannelPick` and `onChannelPicked`.
- `TilePlacement.role` goes: every placement is a stream.

### Shell — `apps/desktop`

- `TileViews` drops `channelPicks`, the `Guide` role and its address reporting, and the guide view's
  every-key forwarding. A view has one role, so `Role` goes.
- `main.ts` stops forwarding `channelPicked`. `GuideReader` is untouched.

### Web — `apps/web`

- `HubClient` drops `learnChannel`, `markNotCarried`, `forgetChannel`.
- `StageView` drops the channel-pick subscription and the **Not on YouTube TV** and **wrong channel** buttons.
- `TileBody` drops the picking tile and says "Waiting for the YouTube TV guide" for `NoGuide`.
- `TileRects` places only stream tiles.

## Behavior changes

| Situation | Before | After |
|---|---|---|
| No guide read yet, or stale; network picked before | Plays the hand-picked channel | Data tile: waiting for the guide |
| No guide read yet, or stale; network never picked | Picking tile showing the guide | Data tile: waiting for the guide |
| Guide fresh, game not matched | Data tile: not in guide | Unchanged |
| Playing tile, guide goes stale | Hand-picked tile follows the lineup; guide-matched keeps playing | Keeps playing |
| Plain browser, no guide | Picking tile with "Open the guide" | Data tile: waiting for the guide |

## Tests

- **Deleted:** `ChannelStore.test.ts`; the lineup cases in `Channel.test.ts` (the file goes if nothing is left);
  learn, not-carried and forget cases in `YouTubeTv.test.ts` and `HubServer.test.ts`; picking cases in
  `Stage.test.ts`, `TileRects.test.ts`, `TileActions.test.ts`, `TileViews.test.ts`.
- **New or changed:**
  - `YouTubeTv`: before any read, availability is `NoGuide`; 45 minutes after the last read it is `NoGuide`
    again, and `changes` emits then.
  - `Stage.apply`: assigning a game the source answers `NoGuide` for gives `DataTile { why: NoGuide }`.
  - `Stage.refresh`: a stream tile stays on `NoGuide`, `Upcoming`, `NotCarried`, and on `Carried` with its own
    channel; it moves on `Carried` with another channel. A `NoGuide` data tile becomes a stream tile on `Carried`.

## Docs

- `CONTEXT.md`: remove **Channel carriage**, **Channel lineup**, **Channel URL refused**, **Channel store**,
  **Channel store error**, **Channel pick**, **Picking tile**; rewrite **Channel availability**, **Tile**,
  **Tile views**, **Tile placement**; add **No guide**.
- `docs/technical-spec.md`: the tree entries for `Channel.ts`, `ChannelStore.ts`, `YouTubeTv.ts`; the Stage's
  tile kinds.
- `docs/game-day-checklist.md`: rows 4, 9, 10, 13, 22, 30 rewritten or removed.
- `docs/history.md`: a row when the branch merges.

## Ordering with other branches

`di-cleanup` touches `HubMode.ts` and `HubServer.test.ts`, each in a few lines unrelated to this change.
`mlb-postseason` has only a spec. Either can merge first; the second rebases.
