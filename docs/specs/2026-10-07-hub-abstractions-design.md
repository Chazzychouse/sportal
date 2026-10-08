# Hub abstractions — design

Status: approved section by section in brainstorming on 2026-10-07. The next step is the plan.

## Goal

Each piece of state in the Hub has exactly one holder, and the domain holds none. Data flows one way, from the
provider to the screen, with no loop back.

What the user named:

- The domain holds state.
- The Hub holds state over those same entities.
- The Provider interface has no cohesion: it mixes polling with syncing, Ingest has to wire its parts together, the
  Provider/Decoder split is awkward, FastCast's errors and resyncs leak out of it, and it depends on the slate.

After this work:

```
Provider.frames ─Ingest─▶ FeedLog ─▶ Board (decode ▶ fold, timer; tells BoardTelemetry) ─▶ HubServer, Switcher
```

## Decisions

- **Behaviour is preserved,** with one exception, listed under "Behaviour change". The proof:
  - `pnpm check`;
  - the rewritten tests, each keeping every assertion it had;
  - the corpus events comparison, which must show no difference;
  - `pnpm dev:golden`, eye-checked by the user.
- **Effect idiom wins, and changes can be liberal.** Every file this work touches is brought to Effect 4's idiom as it
  is touched, and the last phase sweeps what is left (see "Effect idiom sweep"). Code that only looks like Effect
  (flags, `_tag ===`, hand-rolled loops, casts) is replaced, not preserved.
- **Metric ids and the API's wire shape do not change.**
- **The planned Director becomes the Producer** when that work starts. It is not part of this unit. It is recorded here
  so that the new names fit it: "the Producer switches the Slate of games on the Board".

## The domain keeps only what a game is

After this work, `packages/domain` holds `Game`, `GameEvent`, `Play`, `Team`, `League`, `Situation`, `Channel`, `Guide`,
`Stage`, `Stream`, `RecentPlays` and `GameDay`.

- `Slate`, `LiveGame`, `Delivery` and `SlateObservation` leave the domain. Only the Hub imports them.
- `Slate.dayStart` moves to `GameDay.dayStart`, since `GameDay` imports `Slate` for it alone.
- `LiveGame` and `LiveGameState` are deleted. `Acknowledgement` replaces them (see below).

## The Hub's tree

```
apps/hub/src/
  Frame.ts               Frame, LoggedFrame
  Ingest.ts              provider.frames → feedLog.append
  slate/
    Slate.ts             the fold: listed, finished, reached, and per game a snapshot, plays, an acknowledgement
    Acknowledgement.ts   the Hub's acknowledgement of a game's latest word
    Delivery.ts          moved from domain, with DeliverySource
    SlateObservation.ts  moved from domain
    Board.ts             the one holder of the slate
    BoardTelemetry.ts    a service the board tells of every take (was LiveSlateTelemetry.ts)
  Switcher.ts            was LiveStage.ts
  provider/
    Provider.ts          one port: frames and decode; Decoded and DecodeObservation beside it
    Archiver.ts
    espn/                owns its cadence, topics, reconnect, resync, ProviderUnavailable
  feed-log/              gains follow(from)
```

Deleted: `Following.ts`, `provider/Decoder.ts`, `LiveSlate.ts`, `LiveStage.ts`, `LiveFeedDemand`, `Polling`,
`Decoded.resyncs`, `LiveSlate.through`, `LiveSlate.resyncs`, and the `publication` ref.

`slate/` is a folder because the concept has several files private to it.

## Frame

```ts
/** One thing a provider delivered, as received, before the log numbers it. */
class Frame extends Schema.Class<Frame>("sportal/hub/Frame")({
  receivedAt: Schema.DateTimeUtcFromMillis,
  sentAt: Schema.optional(Schema.DateTimeUtcFromMillis),
  /** Which feed delivered it. */
  source: DeliverySource,
  /** A league for a poll; a topic for the push. */
  channel: Schema.String,
  /** `whole` stands alone (a poll response, a checkpoint); `change` changes its channel's last whole. */
  kind: Schema.Literals(["whole", "change"]),
  /** The provider's own number for the message (ESPN's `mid`). */
  number: Schema.optional(Schema.Int),
  body: Schema.String
}) {}

/** A frame as the feed log numbered it. */
class LoggedFrame extends Frame.extend<LoggedFrame>("sportal/hub/LoggedFrame")({ seq: Schema.Int }) {}
```

How today's values map:

| Today | After |
|---|---|
| `feed: "poll"` | `source: "poll"` |
| `feed: "fastcast"` | `source: "push"` |
| `feed: "snapshot"` (tests) | `push`, or `poll` for its listings |
| `kind: "response"`, `"checkpoint"` | `kind: "whole"` |
| `kind: "message"` | `kind: "change"` |
| `sourceId` | `number` |
| `Frame.isPollResponse` | gone: a poll frame is always whole |

- **Feed log migration `3_frame_source`** rewrites `feed_frame` to the new values. `unchanged` and `gap` stay as
  row-level kinds.
- **Feed log queries:** "the last checkpoint per channel" becomes "the last `whole` per channel", and the poll
  de-duplication keys on `source = 'poll'`.
- **Recordings are rewritten once** to the new fields: `fixtures/scenarios/*.frames.jsonl.gz`, the game-day recordings,
  and any adapter fixture that stores frames. The rewrite script is not kept.

## The Provider port

```ts
/**
 * A provider of game data. It runs itself: it decides when to poll, what to follow on its push, when to reconnect, and
 * when to read a channel again. Nothing tells it what to do, and what its frames say is its own `decode`'s.
 */
class Provider extends Context.Service<Provider, {
  /** Every frame it delivers, as received, for as long as it runs. Never fails. */
  readonly frames: Stream.Stream<Frame>
  /**
   * What each logged frame said: exactly one `Decoded` per frame, in order, never waiting on a later frame. It never
   * fails, logs or counts.
   */
  decode(frames: Stream.Stream<LoggedFrame>): Stream.Stream<Decoded>
}>()("sportal/hub/provider/Provider") {}
```

- **`Decoded`** is `{ seq, at, deliveries, observations }`; `resyncs` is gone. `DecodeObservation.Reset` stays, as
  telemetry only.
- **ESPN takes over:**

  | Before | After |
  |---|---|
  | `polling`, a Schedule that Ingest fed with the slate's games | `EspnProvider` sets each next delay from the scoreboard it just fetched, by the existing `interval` |
  | `LiveFeedDemand.Games`, built from the slate | FastCast follows a game topic while its own scoreboard topic shows the game live or within 30 minutes of kickoff, and drops it at final |
  | `LiveFeedDemand.Resync`, sent from decode through the slate | FastCast runs `FastCastDocument.advance` over the frames it receives, and re-checkpoints a topic on `Gap` or `Unapplicable` itself |
  | `reconnect`, run by Ingest | FastCast retries its own socket on the same jittered exponential backoff |
  | `ProviderUnavailable`, Ingest's warnings, `sportal_provider_errors`, `sportal_live_feed_errors` | in `espn/`, logged and counted where they happen, with the same metric ids |

- **`ScenarioProvider`'s** `frames` play every recorded frame, polls included, at its offset on scenario time. Its
  `pollingAt`, its per-league "current poll" lookup and `noEvents` go.
- **`TestSnapshotFeed`'s** `frames` are a stream it is given.
- **`Espn.layer`, `layerScenario` and `layerArchival`** each provide `Provider`, and `layerArchival` also provides
  `Archiver`. The corpus never runs `frames`, but it provides a socket constructor so the layer builds.
- **`Ingest.layer`** forks `provider.frames` into `feedLog.append`. If the stream ever stops other than by the Hub
  stopping, it logs that.

## The slate

### `Acknowledgement`

The Hub's acknowledgement of a game's latest word: which feed gave the snapshot the slate shows, when, and a poll held
back while the push covers the game. Hub-only, never on the wire.

```ts
class Acknowledgement extends Data.Class<{
  readonly from: DeliverySource
  readonly heardAt: DateTime.Utc
  /** A poll snapshot ahead of a covered game, held until `until`, when it applies unless the push has caught up. */
  readonly held: Option.Option<{ readonly snapshot: GameSnapshot; readonly until: DateTime.Utc }>
}> {}
```

`LiveGameState` is replaced by questions asked of a snapshot, its acknowledgement and `now`:

| Today | Derived from |
|---|---|
| `Upcoming` / `Live` / `Over` | `snapshot.progress()` |
| `Stale` | live, and `heardAt` + 90 s ≤ now |
| current while stale | `heardAt` + 30 min > now |
| covered | live, and `from` is push |
| `Holding` | `held` is set |
| falls back | `held.until` ≤ now: the held snapshot becomes the game's, `from` becomes poll, and `held` is cleared |
| `dueAfter(now)` | the earliest deadline after `now`: kickoff − 30 min while upcoming; `heardAt` + 90 s and `heardAt` + 30 min while live; `held.until` |

The constants keep their names and values: `staleAfter`, `currentBefore`, `staleCurrentFor` and `fallbackAfter`.

### `Slate`

The fold, unchanged in what it decides. What changes:

- It holds each game as its domain `GameSnapshot`, its `Play`s and its `Acknowledgement`, in place of a `LiveGame`.
- It loses `seq`, because the board's replay boundary takes over that job.
- `TookOutcome` moves to `SlateObservation.ts`, beside `Took`, its only reader outside the fold.
- `take(frame)` and `tick(now)` still return `Taken = { next, events, observations }`.

"Went stale" and "fell back" are found by comparing what is derived before and after a step, which is pure.

### `Board`

```ts
/** The one holder of the day's slate: it keeps it current from the feed log and the clock. */
class Board extends Context.Service<Board, {
  readonly latest: Effect.Effect<Slate>
  /** The latest first, then each change; `reached` alone moving is not a change. */
  readonly changes: Stream.Stream<Slate>
  /** Every take and tick, in order, each marked replayed or not. */
  readonly taken: Stream.Stream<{ readonly taken: Taken; readonly replayed: boolean }>
}>()("sportal/hub/slate/Board") {
  /**
   * Follows the day's feed log through the provider's decode, from `GameDay.dayStart`, and is built once the frames
   * logged before it started are taken. Then it takes each appended frame, and ticks when a game is due. A decode
   * defect during the replay fails the build. One after it stops the taking, logged, and the board keeps serving and
   * ticking.
   */
  static readonly layer: Layer.Layer<Board, never, FeedLog | Provider | DateTime.CurrentTimeZone>
}
```

- **Its only state is one `SubscriptionRef<Slate>`.** `taken` is a `PubSub`, which is a channel rather than state.
- **Whether a frame is replayed** is decided per frame, by its `seq` against the `last` that `follow` returned. No ref
  tracks how far the replay has read.
- **The build waits on one `Deferred`,** completed when a taken frame's `seq` reaches `last`, or at once when `last` is
  none.
- **The timer is as today:** it sleeps until `earliestDue()`, ticks, and backs off for 1 s after a defect. It starts
  once the build is done.
- **`take` and `tick` are not on the interface:** nothing outside feeds the board.

### `FeedLog.follow`

```ts
/**
 * Subscribes, then reads where the log stands. The frames from `from` up to `last` are logged already, and each frame
 * after `last` follows as it is appended. `last` is none when nothing at or after `from` is logged.
 */
follow(from: DateTime.Utc): Effect.Effect<{
  readonly last: Option.Option<number>
  readonly frames: Stream.Stream<LoggedFrame>
}, never, Scope.Scope>
```

`replay` and `subscribe` stay only if the corpus or another reader still needs them. The plan checks this.

### Outside the board

- **`BoardTelemetry`** is a service that `Board.layer` yields and tells of each take and tick: its observations, spans
  and gauges, as `LiveSlateTelemetry` does now. It also tells the replay summary and the state gauges at the boundary.
  It is told rather than subscribed, because the replayed takes happen during the board's build, before anything
  outside could subscribe. The replay counts come from a `Stream.mapAccum`, not a ref.
- **Game events** are `taken`, without the replayed items, flattened to their `events`. They are derived in `HubServer`,
  their only reader.
- **`SlateChanged`** is `changes`, debounced 250 ms and mapped through `slate.games` and `slate.recentPlays`. A `GET`,
  and the `Switcher`, compute it from `latest`, so it is no longer debounced on that path.

## Switcher

`LiveStage` is renamed `Switcher`, in `Switcher.ts`, with the service id `sportal/hub/Switcher`. Its behaviour does not
change: it holds the one `Stage`, applies stage commands one at a time, and refreshes availability when the source
changes. It reads the slate's games from `Board.latest`.

## Behaviour change

FastCast's game topics follow ESPN's view of a game, not the slate's. A game that ESPN still calls in progress stays on
the push until it goes final, even when the push has been silent for 30 minutes; today it drops off. Poll cadence also
follows ESPN's last scoreboard instead of the slate's games. The two differ only when the push leads the scoreboard, at
a kickoff, by at most one 1-minute poll.

The corpus runs the fold, not the providers, so neither change can move the events comparison.

## Effect idiom sweep

Every file touched is brought to `AGENTS.md`'s spellings and Effect 4's idiom as it is touched. The last phase sweeps
the rest of the Hub, the domain and the api. Known violations to start from:

- **`_tag ===` / `_tag !==`:** use `X.match` or `X.guards` for a wire union, and `$match` or `$is` for a
  `Data.taggedEnum`. These are in:
  - `Stage.ts`, 15 sites: `Stage.apply` and `tileFor` become `StageCommand.match` and `Tile.match`;
  - `LiveGame.ts`, which is deleted;
  - `Game.ts`, `Play.ts`, `HubConfig.ts` and `EspnDecoder.ts`.
- **`switch` over a union:** use `match`, as in `Stage.apply` and `stateOf`.
- **Conditional spreads (`...(x === undefined ? {} : {…})`):** make the schema optional, or use `Option`, so the shape
  fits. These are in `Stage.tileFor` and `settle`.
- **Casts (` as X`, 78 hits) and `instanceof` (6):** each is checked. A cast outside decoding goes, and `instanceof` on
  an error becomes a tagged-error guard where Effect offers one.
- **`let` and `throw`:** each is checked and replaced unless it sits at a framework edge.
- **Hand-rolled loops over a stream's state:** use `Stream.mapAccum`, `Stream.scan` or `Stream.changesWith`, as `Board`
  does.

The sweep's findings go to a list in the plan's ledger. Each one is fixed or recorded as kept, with the reason.

## Docs

- **CONTEXT.md removes:** Live slate, Live game, Covered, Took outcome (if it is no longer exported), Following, Live
  feed demand, Polling, Decoder, Live stage.
- **CONTEXT.md adds:** Board, Acknowledgement, Logged frame, Switcher.
- **CONTEXT.md changes:**
  - Frame, Delivery source, Provider, Decoded, Ingesting, FastCast, Slate, Stale;
  - Slate changed, which is no longer "what `LiveSlate.published` holds";
  - Corpus run, which now runs the slate from `slate/`.
- **CONTEXT.md, planned:** Director becomes Producer.
- **`AGENTS.md`** examples that name the old modules (`"sportal/hub/LiveSlate"`) are updated.
- **`docs/technical-spec.md`** is updated where it describes these modules.

## Sequencing

Each phase ends with `pnpm check` passing. Heavy checks run one at a time.

1. **Frame.** `Frame` and `LoggedFrame` with the new fields, migration 3, the recordings rewritten, and the feed log's
   queries updated.
2. **Fold to the Hub.** `Slate`, `LiveGame`, `Delivery` and `SlateObservation` move into `slate/` without changing
   behaviour, and `dayStart` moves to `GameDay`.
3. **Acknowledgement.** Test-first: `LiveGame`'s and `Slate`'s tests are rewritten against the snapshot, plays and
   acknowledgement shape, keeping every assertion. Then `LiveGame` is deleted. The commit body lists old → new test
   names. The corpus events comparison runs here.
4. **Provider.** `{ frames, decode }`, with `Decoder.ts` merged in. ESPN takes over cadence, topics, resync, reconnect
   and errors. `ScenarioProvider` plays at offsets, and Ingest shrinks.
5. **Board.** `FeedLog.follow`, `Board`, `BoardTelemetry`, and the events and `SlateChanged` derived where they are
   used. `LiveSlate` and `Following` are deleted, and `Slate.seq` is dropped. The corpus events comparison runs again.
6. **Switcher and docs.** The rename, CONTEXT.md, AGENTS.md and the technical spec.
7. **Effect idiom sweep** over what is left.

## Tests

- **`Acknowledgement` and `Slate`:** taking a snapshot or plays; a poll behind, held, replaced by one further ahead, or
  refreshed while covered; falling back at `until`; going stale at 90 s and leaving the current window at 30 min;
  finishing, a repeat of the final, a correction ahead of the final, resuming; ticks in wake order; a defect in one
  game keeping its last good state.
- **ESPN cadence:** 10 s with a live game, 1 min within 30 minutes of a kickoff, 15 min otherwise, capped at 30 s after
  a failed league. Each case is checked against recorded scoreboards.
- **FastCast:** it subscribes to a game's topic when its scoreboard shows it live or within 30 minutes of kickoff, and
  unsubscribes at final. A `Gap` or `Unapplicable` reset re-checkpoints the topic, with no outside input. A closed or
  silent socket reconnects on its backoff, and is counted with the same metric attributes.
- **`ScenarioProvider`:** every recorded frame is played at its offset, polls included, on the test clock.
- **`Board`:**
  - an empty log is built at once;
  - the build waits for the replayed frames, and they are marked replayed;
  - a defect during the replay fails the build;
  - a defect after it stops the taking but not the ticking;
  - `changes` ignores a tick that changes nothing.
- **`FeedLog.follow`:** a frame appended between subscribing and reading `last` is delivered once, after `last`.
- **`BoardTelemetry`:** replayed items tell no game events, and the summary is logged once.
