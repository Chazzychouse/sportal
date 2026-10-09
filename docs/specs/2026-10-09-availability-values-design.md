# Availability as values, one clock in the live route

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

### 1. A game is carried from a few minutes before its airing begins

`startingSoon` goes from 30 minutes to 5. The rule is otherwise as it is: carried once the channel is on the air and
the airing (or kickoff) begins at most 5 minutes from `now`; upcoming before. The wire (`ChannelAvailability`) and
the Screen do not change; a Display streams a game from 5 minutes before it starts instead of 30.

Streaming exactly at kickoff, from the game's own progress, would need no clock at all; the few minutes of lead are
what the live route's minute tick below pays for.

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

### 4. The live route is the one clock

`published` in `HubServer.ts` zips the slate, the source's availability and `Stream.tick("1 minute")` (which emits at
once), reads `DateTime.now` for each, builds `slate.published((game) => availabilityOf(game, now))`, drops a message
the same as the last, and settles it as today. `Slate#published` keeps its signature.

The tick re-evaluates both of the clock's jobs: the 5-minute flip, and an airing ending or a live game running into
the next one. A live game's slate also changes every few seconds, which re-evaluates it sooner.

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
- `Guide.test.ts` (domain): the six cases at the 30-minute edge move to 5 minutes.
- `HubServer.test.ts`: the source-change dedupe test uses a source repeating one value; a new test: an upcoming game
  turns carried once the minute tick passes 5 minutes before its airing, with nothing else changing.
- `EspnProvider.test.ts`: "should want a game's topic once its kickoff is 30 minutes away, with no frame" stays and
  must pass unchanged.

## Docs

- CONTEXT: **Channel availability** says carried from 5 minutes before; **Source** and **Guide reader** say what
  each offers as a stream where they name members.
- `docs/technical-spec.md`: the `Source` block and the YouTube TV/Twitch paragraph.
