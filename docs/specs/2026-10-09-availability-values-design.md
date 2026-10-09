# Availability as values, carried from kickoff

2026-10-09. Follows the Director holding only the slate (branch `director-slate-only`).

## The problem

The Director now offers one stream, the slate as it is and then each change. Two more Hub ports still hold "read the
current value" beside "a signal that it may have changed", and one internal stream does the same join by hand:

| Where | Today | Why |
|---|---|---|
| `Source` | `availability: Effect<(game) => …>` beside `changes: Stream<void>` | the answer depends on `now` |
| `GuideReader` | `latest: Effect<Option<Guide>>` beside `changes: Stream<void>` | `Source` reads `latest` again on each signal |
| `EspnProvider`'s `wanted` | merges state changes with a minute tick, `mapAccum` to carry the last state | a kickoff coming into its window |

The signal exists only because `Guide#availabilityOf(game, now)` reads the clock. It does so for two jobs:

1. **The flip to carried.** A matched channel is `Carried` once its airing (or, with no airing, the game's kickoff)
   begins at most 30 minutes from `now` (`startingSoon`); before that it is `Upcoming { channel, begin }`. Twitch's
   lineup has no airings, so this flip is all that ever changes Twitch's answer, and why Twitch says it changed once a
   minute.
2. **Choosing the airing.** An airing that has ended is not a match, and a live game matches the airing on now when it
   has run past the one near kickoff.

Each source re-evaluating availability on its own tick puts a clock in every source, and the Director had to merge
every source's signal with the slate.

## Decisions

### 1. A game is carried from kickoff, as the slate says

A matched channel on the air is `Carried` once the game's progress is no longer upcoming, and `Upcoming { channel,
begin }` until then. `startingSoon` goes. The slate changes when ESPN says the game has started, so the flip needs no
clock; a game delayed past its kickoff stays upcoming until it does start. The wire (`ChannelAvailability`) and the
Screen do not change; a Display streams a game from kickoff instead of 30 minutes before.

### 2. A source's availability is a stream of values that take the time

```ts
class Source extends Context.Service<Source, {
  /** Each source's availability as it is, then again each time it changes; given a game and the time. */
  readonly availability: Stream<(game: GameSnapshot, now: DateTime.Utc) => ReadonlyArray<ChannelAvailability>>
}>()("sportal/hub/source/Source") {}
```

- `changes` goes. A value changes only when what the source knows changes: a guide read, or a guide gone stale.
- **YouTube TV**: `reader.guide` mapped to `(game, now) => [guide ? guide.availabilityOf(game, now) : NoGuide]`.
- **Twitch**: `Stream.make((game, now) => [lineup.availabilityOf(game, now)])`, one value. Its minute tick goes.
  (`zipLatest` keeps going after a one-value side ends; checked.)
- **`layerAll`**: `Stream.zipLatestAll` over every source's stream, each game's availability from every source in the
  order given, as now.
- **`layerTest(availabilityOf, availability?)`**: one value by default; a test that needs repeats passes the stream.

### 3. The guide reader offers the guide as a stream

```ts
readonly guide: Stream<Option<Guide>>   // SubscriptionRef.changes: the latest guide while fresh, then each change
```

`latest` and `changes` go. The retire timer stays as it is: staleness is already an event.

### 4. The live route reads the time; nothing ticks

`published` in `HubServer.ts` zips the slate with the source's availability, reads `DateTime.now` for each pair,
builds `slate.published((game) => availabilityOf(game, now))`, drops a message the same as the last, and settles it as
today. `Slate#published` keeps its signature.

The time is left only for choosing the airing. A live game running into the next airing is re-evaluated by its own
slate changes, which come every few seconds. An airing that ends after its game is over keeps the game carried until
the next slate or guide change (the shell reads the guide every 15 minutes); a finished game's tile is not worth a
clock.

### 5. `wanted` uses `zipLatest`

`Stream.zipLatest(SubscriptionRef.changes(state), Stream.tick("1 minute"))` replaces the merge and `mapAccum`; the
`DateTime.now` read, `wanted(leagues, now)` and the dedupe stay. The `polling` schedule's `SubscriptionRef.get` stays:
a schedule step needs the state at that moment.

## Not changing

`ChannelAvailability` and the wire, the web Screen, `Slate#published`, `Guide#availabilityOf(game, now)`, the guide's
45-minute staleness, the 250 ms settle, the desktop shell.

## Tests

- `Source.test.ts`: read the first value of `availability` and apply it with a `now`; `layerAll` gives every source's
  availability in order, and a new value when any source's changes.
- `GuideReader.test.ts`: the change counts read `guide` (dropping its first value), as `changes` did.
- `Guide.test.ts` (domain): the six cases at the 30-minute edge become: upcoming while the game is upcoming, whatever
  the time; carried once it is live.
- `HubServer.test.ts`: the source-change dedupe test uses a source repeating one value; a new test: an upcoming game
  on a carrying channel turns carried when a snapshot says it has kicked off.
- `EspnProvider.test.ts`: "should want a game's topic once its kickoff is 30 minutes away, with no frame" stays and
  must pass unchanged.

## Docs

- CONTEXT: **Channel availability** says carried from kickoff; **Source** and **Guide reader** say what
  each offers as a stream where they name members.
- `docs/technical-spec.md`: the `Source` block and the YouTube TV/Twitch paragraph.
