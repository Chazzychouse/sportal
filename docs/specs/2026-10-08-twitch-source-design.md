# Twitch as a source

Thursday Night Football streams free on Twitch, on Prime Video's channel (`twitch.tv/primevideo`). ESPN already
reports those games as network `Prime Video`, medium `streaming`, so today YouTube TV answers them "streaming only".
This change adds Twitch as a second source and makes the Hub play from any number of sources through one
abstraction.

## Decisions

- **Order does not matter.** Sources are a set, not a ranking. Sources rarely overlap (TNF has been Prime Video and
  Twitch only), so the answers combine by what they say: a source that carries a game beats one that does not, with no
  preferred source.
- **Twitch carries a Prime Video game from 30 minutes before kickoff**, the same "starting soon" rule YouTube TV's
  guide uses. Before that, the tile reads "On Prime Video at 8:15 PM". Twitch's channel is live around the clock; we
  don't show whatever it airs at 3 PM.
- **Same abstraction for both sources.** `Source` is `{ availability, changes }` and nothing else. Reading a pushed
  guide is YouTube TV's alone, so it moves off the port.
- **Source variants live on the port:** `Source.layerYouTubeTv`, `Source.layerTwitch`, `Source.layerAll([...])`, and
  `GuideReader.layerYouTubeTv`.
- **Imports point one way:** the port modules (`Source.ts`, `GuideReader.ts`) → adapter folders → domain. No adapter
  imports a port, not even its type.

## Domain (`packages/domain`)

### A guide's channel can name the network it carries

A guide today maps games to channels through **airings**: listings whose title names both teams. Twitch has no
listings; its channel *is* a network's stream. No new concept is needed for that: a guide's channel gets one optional
field, the network whose every broadcast it carries.

```ts
class Guide extends Schema.Class<Guide>("sportal/Guide")({
  source: SourceName,
  readAt: Schema.DateTimeUtc,
  channels: Schema.Array(
    Schema.Struct({
      id: ChannelId,
      name: Schema.String,
      live: Schema.optional(StreamLocator),
      network: Schema.optional(Network)   // new: Twitch's primevideo carries Prime Video; YouTube TV's set none
    })
  ),
  airings: Schema.Array(Airing)           // unchanged
}) {
  availabilityOf(game: GameSnapshot, now: DateTime.Utc): ChannelAvailability
}
```

`availabilityOf` keeps today's airing rules unchanged. When no airing matches, a channel whose `network` is one of the
game's networks answers:
- **Carried** from `kickoff − 30 min` while the game is not over;
- **Upcoming** before that, with the channel's name and the kickoff as its begin;
- otherwise today's no-match answers (streaming only, not in the guide). The "past the guide's reach" answer applies
  only to a guide that lists airings: reach is how far a guide's listings go, and a lineup with none has nothing still
  to list.

`availabilityOf` takes `now`, and every rule that reads `readAt` as "now" today (an airing not yet ended, on now,
starting soon) reads `now` instead. That is what a guide that is never read (Twitch's lineup) needs. It is also more
accurate for YouTube TV: a 40-minute-old guide no longer matches an airing that ended 20 minutes ago. `readAt` keeps
one job, the guide's reach. Existing `Guide.test.ts` cases pass `now` equal to `readAt`, so every assertion holds.

### `SourceName`

Becomes `Schema.Literals(["YouTube TV", "Twitch"])`.

### `Screen.refresh` returns the same Screen when no tile changed

So a source can say "something may have changed" every minute and the Displays hear only real changes. The Director's
`refresh` skips the `set` when `refresh` returns the Screen it was given, the way `take` already does for the slate.

### Data tiles name a source only when waiting for its guide

With no preferred source, a "not carried" answer could come from either source, so naming one would be arbitrary.
Only "no guide" is about one source. The `NoGuide` data tile carries its `SourceName`, and its copy reads "Waiting for
the YouTube TV guide" from that field. The other copy speaks of "your sources": "Streaming only: not on your sources",
"Not on your sources' channels".

## Hub (`apps/hub/src/source/`)

```
source/
├── Source.ts            The port, its variants, and the rule that combines several sources
├── GuideReader.ts       Reads the guide the shell fetches and keeps it while fresh; /guide feeds it
├── youtube-tv/
│   ├── YouTubeTvGuide.ts      Namespace module: a guide response → channels and airings (today's decode)
│   ├── YouTubeTvPayload.ts    Unchanged
│   ├── TestYouTubeTv.ts       Unchanged
│   └── fixtures/
└── twitch/
    └── Twitch.ts              Namespace module: Twitch's lineup, a constant Guide
```

### `Source.ts`

```ts
export class Source extends Context.Service<Source, {
  readonly availability: Effect.Effect<(game: GameSnapshot) => ChannelAvailability>
  readonly changes: Stream.Stream<void>
}>()("sportal/hub/source/Source") {
  /** YouTube TV: from the latest guide its reader keeps while it is fresh; otherwise no guide. */
  static readonly layerYouTubeTv: Layer.Layer<Source, never, GuideReader>
  /** Twitch: its fixed lineup, which never goes stale; says it may have changed once a minute. */
  static readonly layerTwitch: Layer.Layer<Source>
  /** Every source given, as one. */
  static layerAll<R>(sources: ReadonlyArray<Layer.Layer<Source, never, R>>): Layer.Layer<Source, never, R>
}
```

The adapter modules know nothing about `Source`. `YouTubeTvGuide` decodes a response into channels and airings, and
`Twitch.lineup` is a `Guide`. Answering from a guide is `Guide.availabilityOf`, shared by both.

| Variant | Where its guide comes from | Stale after | `changes` |
|---|---|---|---|
| `layerYouTubeTv` | `GuideReader`'s latest, decoded by `YouTubeTvGuide` | 45 minutes (the reader's) | the reader's: each read, and when the guide goes stale |
| `layerTwitch` | `Twitch.lineup`, constant | never | a one-minute tick |

**The combining rule** (`layerAll`), one place, pure and tested on its own:
- **`availability`:** the most useful answer any source gives: carried, then upcoming on a known channel, then
  upcoming with nothing known, then no guide (it may yet be carried once the guide arrives), then not carried
  (streaming only before not in the guide). The order of the list
  given to `layerAll` never decides between two sources: when two answer alike (two carry the same game), the answer
  is the same kind and either one is right.
- **`changes`:** the merge of every source's changes.

`layerAll` builds each layer and provides the combined `Source`. YouTube TV's `GuideReader` is a requirement of
`layerYouTubeTv` provided below it in `main.ts`, so HubServer and the source share one reader.

### `GuideReader.ts`

```ts
/** Reads the guide responses the shell fetches from a source's guide page, and keeps the latest while fresh. */
export class GuideReader extends Context.Service<GuideReader, {
  readonly latest: Effect.Effect<Option.Option<Guide>>
  readonly changes: Stream.Stream<void>
  readGuide(guide: string): Effect.Effect<void, GuideUnreadable>
}>()("sportal/hub/source/GuideReader") {
  /** YouTube TV's guide: decoded by YouTubeTvGuide, fresh for 45 minutes after its reading. */
  static readonly layerYouTubeTv: Layer.Layer<GuideReader>
}
```

HubServer's `/guide` handler yields `GuideReader` instead of `Source`. The API contract and the shell are unchanged.

### `main.ts`

```ts
Layer.provide(Director.layer),
Layer.provide(Source.layerAll([Source.layerYouTubeTv, Source.layerTwitch])),
Layer.provide(GuideReader.layerYouTubeTv),
```

### Twitch's lineup

```ts
/** Twitch's channels this Hub plays, each with the network whose every broadcast it carries. */
export const lineup = new Guide({
  source: "Twitch",
  readAt: DateTime.makeUnsafe(0),
  channels: [
    {
      id: ChannelId.make("primevideo"),
      name: "Prime Video",
      live: { _tag: "WebView", url: "…" },
      network: Network.make("Prime Video")
    }
  ],
  airings: []
})
```

The `Prime Video → twitch.tv/primevideo` mapping is this one channel. Another Twitch channel later is another entry.

## Desktop shell

- `apps/desktop/src/main/Twitch.ts` (new) lists Twitch's hosts beside today's `YouTubeTv.ts`. `ProviderSession.allows`
  permits either list.
- Twitch needs no sign-in. "Sign in" stays YouTube TV's.
- **Spike, before the plan fixes the address:** in a provider view, does `https://www.twitch.tv/primevideo` or
  `https://player.twitch.tv/?channel=primevideo&parent=…` load and play full-bleed, and which hosts does it navigate
  through? The plan sets the lineup's address and the host list from what this shows. Players stay unmodified (AGENTS
  "Limits that are deliberate").

## Rules and docs that change with it

- **AGENTS.md / technical-spec rule 9:** "only `main.ts` names concrete sources" becomes "only `main.ts` and
  the source ports' layer variants (`Source.ts`, `GuideReader.ts`) name concrete sources, and only they import a
  source's folder".
- **`.dependency-cruiser.cjs`:** the adapter-folder rule allows `source/Source.ts` and `source/GuideReader.ts` to
  import `source/<name>/`, and `source/twitch/` joins `source/youtube-tv/` in it.
- **CONTEXT.md:** Source's example gains Twitch. **Channel** gains "and, on a source with no listings, the network
  whose every broadcast it carries". **Guide reader** today names only the shell component that fetches the guide; it
  widens to both halves: the shell's fetches a source's guide with the source's own request, the Hub's reads what the
  shell fetched for that source. One term, one job (reading a source's guide), split across the two apps as now. The Director's row says "when a
  source changes".
- **technical-spec:** the `source/` tree and the Source section.

## Testing

- `Guide.test.ts`: the network-channel cases: carried in the window, upcoming before it, not after the game is over,
  an airing still wins over a network channel, a network no channel carries falls through. Every existing assertion kept.
- `Source.test.ts`: the combining rule (carried beats upcoming, no guide and not carried from any source; upcoming
  beats no guide; no guide beats not carried; streaming only beats not in guide; the kind of answer is the same whichever
  order the sources are given), and changes merge.
- YouTube TV's existing tests move to `GuideReader.test.ts` (reading, staleness) and `Source.test.ts` (no guide,
  slate matching), every assertion kept.
- `Screen.test.ts`: `refresh` returns the same Screen when nothing changed.
- `Director.test.ts`: a refresh that changes nothing publishes no Screen change.

## Out of scope

- A per-source stream budget (still planned).
- Sign-in to Twitch, and Twitch chat or co-streams.
- Choosing which sources run from `HubConfig`. `main.ts` lists them.
