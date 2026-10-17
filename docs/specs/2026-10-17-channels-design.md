# Channels

2026-10-17. From a brainstorm. Today a Display can only watch a game: a source's airings are read only to find a
game's channel, by an airing whose title names both teams and begins near the start. A studio show (College GameDay,
Big Noon Kickoff, NFL pregame, RedZone, SportsCenter) names no game and can never be watched. This adds the
**lineup**: a source's sports channels, each with what airs on it now and next, as a Channels entry in the guide; a
channel goes on a tile of its own.

This is one unit of work, run start to finish by an agent without the user. Every decision is made here. Where this
spec and the code disagree on a name, the code's existing name wins unless this spec renames it.

Phases, each its own commit on branch `channels`, each ending with `pnpm check` green:

1. [Domain: the lineup](#1-domain-the-lineup)
2. [Hub: Source and API](#2-hub-source-and-api)
3. [Web: Channels in the guide](#3-web-channels-in-the-guide)
4. [Web: channel tile](#4-web-channel-tile)
5. [Docs and eye-check](#5-docs-and-eye-check)

Not in this unit: the Remote choosing a channel, following a show across channels, tying a studio show to a league,
channels that are not sports channels, a live stream of the lineup.

## 1. Domain: the lineup

In `packages/domain/src/Guide.ts`, beside `Guide`:

```ts
export const Lineup = Schema.Array(
  Schema.Struct({
    channel: Channel,
    now: Schema.OptionFromOptionalKey(OnAir),
    next: Schema.OptionFromOptionalKey(OnAir)
  })
)
export type Lineup = typeof Lineup.Type
```

where `OnAir` is a non-exported `Schema.Struct({ title: Schema.String, begin: Schema.DateTimeUtcFromString, end:
Schema.DateTimeUtcFromString })`: an airing as a client sees it, without its channel id. It is not exported; a
user that needs its type derives it from `Lineup`.

`Guide#lineup(now: DateTime.Utc): Lineup`:

- Keeps each channel of the guide, in the guide's order, that has a `live` locator and is a **sports channel**: it has
  a `network` (a channel that is one network's stream, as Twitch's Prime Video), or its name names, by
  `namesNetwork`, one of the sports networks: ESPN, ESPN2, ESPNU, ESPNews, SEC Network, ACC Network, Big Ten Network,
  FS1, FS2, NFL Network, NFL RedZone, CBS Sports Network, Golf Channel, NBA TV, MLB Network, NHL Network, Tennis
  Channel, ABC, CBS, NBC, FOX. The list is a private constant beside its one user.
- `now` is the channel's airing with `begin <= now < end`; `next` is its airing with the earliest `begin > now`.
- `channel` is `{ name, source: this.source, locator: live }`.
- **Amended 2026-10-17:** some locals are named for their call sign ("News 3" is CBS, "WAVY 10" is NBC), so
  `lineup(now, alsoNamed)` also keeps a channel whose name, read without case or punctuation, is one of `alsoNamed`:
  `HubConfig.lineupChannels`, from `SPORTAL_LINEUP_CHANNELS` (comma-separated, default none). The sports networks also
  include BTN, NBCSN, TBS, TNT, truTV and USA, as the recorded guide names them.

Tests in `Guide.test.ts`, test-first, one behaviour each:

- should keep a channel that names a sports network
- should drop a channel that names no sports network
- should keep a local channel by its network's name ("ABC 13")
- should keep a channel that is one network's stream
- should drop a channel with no live address
- should give the airing on now
- should give no airing on now once it has ended (`now == end`)
- should give the earliest airing after now as next
- should keep the guide's channel order

## 2. Hub: Source and API

`apps/hub/src/source/Source.ts`: the port gains

```ts
readonly lineup: Effect.Effect<(now: DateTime.Utc) => Lineup>
```

- `layerYouTubeTv`: from the latest guide while it is fresh (`isFresh`), else empty.
- `layerTwitch`: the same fixed `Guide`'s `lineup(now)`; lift the fixed guide to a private constant both members use.
- `layerAll`: each source's lineup, concatenated in source order.
- `layerTest…` variants gain the member (empty unless a test gives one).

`packages/api/src/HubApi.ts`: `Rpc.make("lineup", { success: Lineup })`. The Hub's handler yields `Source` and
`Clock`, and answers `lineup(now)`. It is a request, not a live query: the web asks again on its own clock.

Test: the handler answers the source's lineup at the clock's now (one test, beside the existing handler tests).

## 3. Web: Channels in the guide

- `GuideEntry` gains `"Channels"`. `GuideShelves.entries` is All live, the leagues, **Channels**, Custom; it is listed
  whether or not the lineup is empty. `Display.entryName("Channels")` is "Channels". The ribbon's tabs follow the
  entries as they do now.
- `GuideItem` gains a channel case carrying one lineup member. Channels' shelves: at either level, one shelf of
  channel items, in lineup order; an empty lineup is an empty shelf with the guide's usual empty message.
- The lineup is an atom in `apps/web/src/hub/` beside highlights, following its pattern: asked through `HubClient`
  when the Channels entry first shows, and again every 60 s while the guide is open on it. A failed ask keeps the last
  answer.
- The card (`ChannelCard`, in the guide folder): the channel's name; what is on now with the minutes left; "Next" and
  the next airing's title and begin time. Both themes; Team has no team colors here and uses the theme's neutral.
- Enter on a channel card assigns it to the selected tile (see 4) and closes the guide, as a game card does.

Tests in `GuideShelves.test.ts`: should list Channels after the leagues; should give one channel item per lineup
member, in order.

## 4. Web: channel tile

- `Screen.ts`: `Tile` gains `ChannelTile: { channel: Channel }`; `ScreenCommand` gains `AssignChannel: { tile:
  Schema.Int, channel: Channel }`, which places it as `AssignCustom` places a custom tile.
- `packages/api/src/TileKey.ts` gains `channel(channel)`: `channel:<source>:<live address>`. Amended 2026-10-17: keyed by live address; a source may list several channels with one name (four ESPN feeds).
  `Tile.key` gives it for a channel tile.
- A channel tile follows no game: whatever re-points stream tiles by availability, and the autopilot, leave it as they
  leave a custom tile. It is audible and can take audio focus and solo, as a stream tile can.
- Tile views load its `channel.locator` like a stream tile's.
- The tile's chrome shows the channel's name and, from the lineup atom when it has one for that channel, the title on
  now.

Tests in `Screen.test.ts`: should place a channel tile on AssignChannel; should keep a channel tile when availability
changes.

## 5. Docs and eye-check

- `CONTEXT.md`: **Lineup** under Data and video ("A source's sports channels that play live, in its guide's order,
  each with its airing now and next; `Lineup` in `packages/domain/src/Guide.ts`, given by `Guide#lineup` and the
  `lineup` RPC." Not: channel list, EPG). **Channel tile** under Viewing. **Guide entry** lists Channels.
- `docs/technical-spec.md`: the `lineup` RPC and the channel tile.
- Eye-check rows (user, on a Saturday morning): the guide lists Channels; ESPN's card shows College GameDay with the
  time left and what is next; Enter puts ESPN on a tile and it plays; the tile shows "College GameDay"; the channel
  tile survives a reload; a stale guide gives an empty Channels shelf.
