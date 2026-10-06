# The fold follows the feed log — design

Status: approved in grilling, 2026-10-06. Plannotator annotation of this spec and its plan is skipped by the user's
call; `plannotator review` runs on the code.

Three modules each decide whether a frame is replayed or live. Ingest keeps a `replayedUpTo` Ref, a queue it ends in
mid-stream, and a `route` that sends a replayed delivery to `LiveGames.replay`, a live one to `LiveGames.take`, and
drops a replayed notice. The Hub's `LiveGames` has two write members and a `replaying` semaphore. `LiveGamesTelemetry`
has two parallel tables, `reported` and `quiet`. The replay test cannot go through Ingest, so it rebuilds Ingest's
private pipeline.

The fold's `seq` moves only on a delivery. A poll whose frame decodes only to a notice therefore never reaches the
watermark Ingest waits on, and the poll loop stalls for the full 5 s `takenWithin`, in scenario time as well as live.

Ingest also holds three things that are not its own: which games are current (the fold's), which live feed channels
to resync (decode's), and the push's reconnect backoff (the provider's).

And two copies of one adapter, a provider whose frames are our own snapshots as JSON, live in `ScenarioProvider.ofSlates`
and `TestProvider`. They have already diverged: the scenario copy drops an undecodable frame silently, against the
Decoder's contract.

This spec moves each decision to its owner.

## Scope

- **In:** the Hub's `LiveGames`, `LiveGamesTelemetry`, `DecodeTelemetry`, Ingest, the Provider and Decoder ports,
  `EspnDecode`, `EspnProvider`, `FastCast`'s push input, `ScenarioProvider`, `HubMode`, `Frame`, the domain's
  `LiveGames` fold and `Delivery`, `TestProvider` and every test that uses it, the glossary rows named below, the
  telemetry dashboard's take-duration panel.
- **Behaviour is preserved**, apart from these, each its own `fix:` or `feat:` commit:
  - An undecodable poll no longer stalls polling (the fix this spec exists for).
  - A written scenario's undecodable frame is noted, as the Decoder contract says.
  - The fold steps once per frame, so `reached` moves on every frame, not only on deliveries.
- **Out:** the ESPN league table and event precedence (review candidates 03 and 04, MLB's first refactors); the shell
  bridge (07); GameHistory, `LiveGames.events` and the unread Play fields (built ahead of the Director); the web UI.

## Delivery

One branch, `fold-follows-log`, in the worktree `../sportal-fold-follows-log`. The plan's phases are commits on it,
each passing `pnpm check`. Then `plannotator review` on the branch, and one merge to main. MLB's plan starts from the
merged result; `web-one-command-path` shares nothing with it and may run at any time.

## 1. Decoded is what one frame said

`Decoded` stops being a union of things said, each carrying a `seq`. It is one value per frame.

```
Decoded: Data.Class {
  seq: number
  at: DateTime.Utc                       // the frame's receivedAt
  deliveries: ReadonlyArray<Delivery>    // in the order the frame said them
  resyncs: ReadonlyArray<string>         // live feed channels whose document was dropped
  notices: ReadonlyArray<Notice>
}

Decoder.decode(frames: Stream<Frame>): Stream<Decoded>   // exactly one Decoded per frame, in order
```

- The contract gains *exactly one per frame*: a frame that said nothing is a `Decoded` with three empty arrays. "Folded
  through frame N" becomes exact for every frame, pushed or polled.
- `EspnDecode` already builds one `Said` array per frame inside `Stream.mapAccumEffect`; it builds a `Decoded` instead,
  and the `Said` alias, `delivered` and `noted` helpers go.
- `Notice.FrameUndecoded.feed` is typed as `FeedFrame`'s `feed`, so it widens with §5.
- Glossary, **Decoded**: *What one frame said, one per frame: its deliveries, the live feed channels to resync, and
  its notices, with the frame's `seq` and receive time.*

## 2. The domain fold: `take` and `tick`

`step(Option<Delivery>, at, Option<seq>)` had two callers it told apart with its `Option`s. It becomes two methods,
named as `LiveGame`'s are:

```
LiveGames.take(frame: { deliveries: ReadonlyArray<Delivery>; at: DateTime.Utc; seq: number })
  : Effect<{ next: LiveGames; reports: ReadonlyArray<FoldReport> }>
  // ticks every game due after `reached` and at or before `at`, applies each delivery in order, sets `seq`

LiveGames.tick(now: DateTime.Utc)
  : Effect<{ next: LiveGames; reports: ReadonlyArray<FoldReport> }>
  // the timer's: ticks to `now`; `seq` unchanged
```

- The domain cannot see the Hub's `Decoded`, so `take` reads the three fields it needs structurally. The Hub passes a
  `Decoded` as it is.
- A frame with no deliveries still ticks and sets `seq`.
- `publishesSameAs` ignores `seq` as it ignores `reached`: a step that moves only the watermark is not a change the
  Slate or GameHistory should see. The Hub's `through` (§3) reads the watermark from the state itself.
- Tests: `take` of a frame with no deliveries ticks due games and sets `seq`; `take` of several deliveries applies them
  in order (a `Listing` then a pushed `Snapshot` of a listed game reports `Took … taken`); `tick` never moves `seq`;
  two deliveries in one frame give the same live games as the same two in two frames at the same instant.

## 3. The Hub's LiveGames follows the feed log

The Hub's `LiveGames` stops being written to. It reads the log.

```
LiveGames: Context.Service<{
  readonly latest: Effect<Fold.LiveGames>
  readonly changes: Stream<Fold.LiveGames>      // the latest first, then each change; seq or reached alone is none
  readonly events: Stream<Happened>
  through(seq: number): Effect<Fold.LiveGames>  // the fold once it has taken frame `seq`
  readonly demand: Stream<LiveFeedDemand>       // §4
}>

LiveGames.layer: Layer<LiveGames, never, FeedLog | Decoder | DateTime.CurrentTimeZone>
```

### Following

```
           build                                  catch-up ends                 decode dies
 ──────▶ Replaying ───────────────────────────────▶ Live ─────────────────────────▶ Stopped
          (layer build waits here)          (layer build returns,            (logged at Error;
                                             timer starts)                     fold frozen)
```

- The layer computes the day start (04:00 in the current zone, or the day before's: today's `dayStart`, which moves
  here from Ingest), subscribes to the log, then decodes one stream: the replay from the day start, then every
  appended frame after the replay's last `seq`. One decode, so each FastCast topic's document carries from replay to
  live, as today.
- **Replaying** ends at the replay's last frame. Each `Decoded` is taken quietly (§6). At the boundary the layer
  sets every held game's gauges once and logs the summary line (frames, deliveries, plays, live games, duration), and
  the build returns. Nothing is served from a fold that is still catching up, as today, and no member is needed to
  say so: layer order says it.
- **Live**: each `Decoded` is taken loudly, and its resyncs go to `demand`.
- **Stopped**: a decode defect after the catch-up is logged at Error once ("frames are no longer taken into the fold
  until the Hub restarts"); the fold keeps serving what it has. Polls and pushes still reach the log, so a restart
  replays them. A decode that dies during Replaying fails the layer, as today.
- The timer forks when the build returns, so nothing ticks a replayed game between two recorded frames. The
  `replaying` semaphore goes. The timer and the follower write through the state's lock, as today; a frame received
  just before a timer tick cannot move `reached` back, as today.
- `through(seq)` returns the first state whose `seq` is at or past `seq`, or the latest once the fold is Stopped,
  so a dead fold never stalls Ingest's polling. It waits on the state itself, not on `changes`.
- One span per frame, `LiveGames.take`, annotated with the frame's `seq` and its delivery count;
  `sportal_take_duration` becomes *How long the fold takes to apply one frame*, and its dashboard panel's title says
  frame.
- Glossary, **Live games**: the Hub's service *follows the feed log from the game day's start, replaying it quietly
  and then taking each new frame as it is appended, with a timer and telemetry*.

## 4. The live feed's demand, and reconnect on the port

```
LiveFeedDemand = Data.TaggedEnum<{
  Games:  { games: ReadonlyArray<GameSnapshot> }  // the current games, whenever which games they are changes
  Resync: { channel: string }                      // a followed channel whose document decode dropped
}>

LiveFeed = (demand: Stream<LiveFeedDemand>) => Stream<FeedFrame, ProviderError>

Provider: Context.Service<{
  poll(league): Effect<FeedFrame, ProviderError>
  readonly push: LiveFeed
  readonly polling: Polling
  readonly reconnect: Schedule<unknown, ProviderError>   // how the push is subscribed to again after it fails
}>
```

- `LiveFeedDemand` is declared and exported beside `LiveFeed` in `Provider.ts`, per the port rule.
- `LiveGames.demand` is a fresh subscription per run: its first element is the current games (today's `wanted`:
  games that `LiveGame.isCurrent` at the clock's now, deduped by id), then each change of which games are current,
  merged with each live resync. A push that reconnects runs `demand` again and so follows every current game again,
  as today. Resyncs before a reconnect are not replayed; the new socket starts each topic from a fresh checkpoint.
- The push no longer takes `leagues`: `FastCast.layer` yields `HubConfig` for them. `FastCast.push(demand)` splits the
  demand into its game subscriptions and its `followAgain`s internally.
- ESPN's `reconnect` is today's backoff, moved unchanged from Ingest: exponential from 1 s, jittered, each delay
  capped at a minute. A recorded scenario's push never fails, and a snapshot provider's is the test's own, so both
  declare `Schedule.spaced("1 second")` unless given one.
- Glossary: new row **Live feed demand** — *What the live feed should follow: the current games whenever which games
  they are changes, and each channel whose document must be read again from a checkpoint; `LiveFeedDemand` in code.*
  **Provider** gains *and how its push is reconnected*. **Live feed** loses nothing.

## 5. The snapshot feed

One production adapter for a provider whose frames are our own deliveries. Written scenarios play through it and
tests drive it; the two copies go.

```
provider/snapshot/
  SnapshotPayload.ts   // the frame body: one Delivery, or a Resync of the frame's channel (wire schema, exempt)
  SnapshotProvider.ts  // layer(options): Layer<Provider> — poll from a games function, optional push, polling, reconnect
  SnapshotDecode.ts    // layer: Layer<Decoder>
```

- A frame's body is one encoded `Delivery` (`Listing`, `Snapshot`, or `Plays`) or a `Resync`. So `Delivery` becomes a
  Schema tagged union in `packages/domain/src/Delivery.ts`, keeping its constructors and `$match` (the Effect 4 Schema
  union API the plan names from `effect/ai-docs`). The domain schema is the wire format.
- `FeedFrame.feed` gains `"snapshot"`, so these frames stop calling themselves `fastcast`. A snapshot poll is kind
  `response` on its league's channel; a push is kind `message`. The log's poll-repeat rule (`Frame.isPollResponse`)
  stays ESPN's: it reads `feed === "poll"`.
- `SnapshotDecode` reads each frame as its delivery or its resync, and a body that does not decode as
  `FrameUndecoded`, honouring the contract the scenario copy broke.
- `SnapshotProvider.layer` takes, as data: the games a poll of a league answers (an Effect that may fail with
  `ProviderError`), an optional push of frames, its `polling`, and its `reconnect`. A poll's frame is a `Listing`.
- **Written scenarios** become `SnapshotProvider` driven by `Scenario.slateAt` on scenario time, polled at each written
  frame's time and at least every 10 s (today's `pollingAt`).
- **`TestProvider.ts` is deleted.** What tests need beyond the adapter goes in `TestFeed.ts` (a `Test*` file, so knip
  keeps it out of production), and none of it decodes: `delivered(delivery)` appends a snapshot frame to the feed
  log and returns the fold `through` it; `pushed(...)` builds a snapshot push frame; `listedBy(league)` polls and
  decodes with the provided pair. A scripted-responses provider is a few lines in `Ingest.test.ts`, its only user.
- Glossary: new row **Snapshot feed** — *A provider whose frames are our own deliveries, one per frame: what written
  scenarios play and tests drive.* **Scenario** says a written one plays as the snapshot feed.

## 6. One telling, told the phase

```
Phase = Data.TaggedEnum<{ Replaying: {}; Live: {} }>

LiveGamesTelemetry.told(phase, decoded, reports): Effect<void>
```

- One entry point for everything a step tells, reports and notices both. Replaying: counts plays for the summary and
  logs a `Raised` defect, as `quiet` does; tells no notice (each was told when its frame first arrived). Live: what
  `reported` does today, and each notice through `DecodeTelemetry`'s table.
- `reported` and `quiet` merge into the one `$match`, whose `Replaying` arm is today's `quiet` arm. Notice gating
  leaves Ingest.
- `DecodeTelemetry.ts` moves from `ingest/` to `apps/hub/src/` beside `LiveGamesTelemetry.ts`, which calls it. Its
  doc comment says LiveGames tells notices only from frames after the replay.

## 7. Ingest

```
Ingest.layer: Layer<never, never, HubConfig | Provider | FeedLog | LiveGames>
```

- Polls each league on `provider.polling`, appends each frame, and gives the Schedule
  `(yield* liveGames.through(lastSeq)).slate(leagues)` and the failed leagues. `taken` and `takenWithin` are deleted.
- Runs `provider.push(liveGames.demand)`, counts and logs each failure by reason, retries on `provider.reconnect`,
  and appends each frame. `wanted`, the resync `PubSub` and `reconnect` leave it.
- It no longer yields `Decoder` or replays anything. The layer no longer waits on the catch-up; `LiveGames` does.
- `ingest/` keeps one file, so it goes: `Ingest.ts` and `Ingest.test.ts` move to `apps/hub/src/`.
- Glossary, **Ingesting**: *The Hub's loop that polls the provider on its polling and runs its push, retried on its
  reconnect, appending every frame to the feed log; the live games fold what it appends.*

## 8. Provider and Decoder are separate layers, paired by HubMode

No layer provides `Provider | Decoder`. Each adapter exports one layer per port.

| Adapter | Provider layer | Decoder layer |
|---|---|---|
| ESPN | `EspnProvider.layer: Layer<Provider, never, FastCast \| HttpClient>` | `EspnDecode.layer` |
| Snapshot feed | `SnapshotProvider.layer(options)` | `SnapshotDecode.layer` |
| Written scenario | `ScenarioProvider.written: Layer<Provider, ScenarioUnknown, HubConfig>` | `SnapshotDecode.layer` |
| Recorded scenario | `ScenarioProvider.recorded: Layer<Provider, ScenarioUnknown \| ScenarioUnreadable, HubConfig \| RecordedScenarios>` | the recording provider's: `EspnDecode.layer` |

- `HubMode` is still the only module naming providers. It gives `Provider` to Ingest and `Decoder` to `LiveGames`, and
  one `FeedLog` to both (`Layer.provideMerge`). For a scenario it picks the written or the recorded pair by whether
  `SPORTAL_SCENARIO` names a written scenario. The recorded scenario stops needing and providing `Decoder`.
- `HubMode`'s compile-time check that a scenario provides what the live day does stays.
- Tests of the fold (`LiveGames`, `Slate`, `GameHistory`, `HubServer`) provide an in-memory `FeedLog` and
  `SnapshotDecode.layer`, and no Provider. Ingest's tests provide a `SnapshotProvider` and the real `LiveGames`.
- Glossary, **Decoder**: *provided by its adapter as a layer of its own; `HubMode` pairs it with its provider.*

## 9. Tests

Replace, don't layer: each test moves to the interface it now has, and the helpers that existed to reach past it go.

- **`LiveGames.test.ts`, `LiveGames.replay.test.ts`:** append frames to an in-memory feed log, build the layer, and
  read `latest`, `changes`, `events`, `through`. `deliveriesOf` and the hand-built replay pipeline go. New: the build
  returns only after the log's last frame at subscription is taken; a frame appended during the build is taken live,
  after the boundary, and told loudly; replaying a recorded day gives the same live games as taking it live;
  `through(n)` answers for a frame that decodes only to a notice; `through` answers once Stopped; no notice is told
  from a replayed frame; `demand` starts with the current games, follows a change of which games are current, and
  carries a resync of a live frame but not of a replayed one.
- **`Ingest.test.ts`:** a poll whose frame is undecodable does not delay the next poll (fails today: the regression
  test for the stall); the Schedule gets the slate of the polled listing; a failing push is counted, logged and
  retried on the provider's `reconnect`; Ingest never yields a `Decoder`.
- **`SnapshotDecode.test.ts`, `SnapshotProvider.test.ts`:** each delivery kind and a resync round-trip through a
  frame; an undecodable body is `FrameUndecoded`; a frame gives exactly one `Decoded`.
- **`EspnDecode.test.ts`:** exactly one `Decoded` per frame, including a FastCast message that changes nothing;
  existing expectations re-read through the new shape.
- **`ScenarioProvider.test.ts`:** a written scenario through `SnapshotDecode`; a recorded one through `EspnDecode`;
  the recorded slices still pass with expectations unchanged.
- **`Slate.test.ts`, `GameHistory.test.ts`, `HubServer.test.ts`, `YouTubeTv.test.ts`, `EspnProvider.test.ts`:** move
  from `TestProvider` to `TestFeed` and the snapshot feed; expectations unchanged.
- **Domain `LiveGames.test.ts`:** §2's cases.

## Verification

- `pnpm check` passes at every commit.
- The recorded scenarios through the real Ingest and fold pass with expectations unchanged.
- `rg 'Provider \| Decoder' apps` finds nothing; `rg 'takenWithin|replayedUpTo|replaying' apps` finds nothing.
- Only `LiveGames` yields `Decoder` in production code.
- The user runs `SPORTAL_SCENARIO=<recorded> SPORTAL_SCENARIO_SPEED=10 pnpm dev` and a written scenario the same way,
  and the desktop shell (the agent shell misreports Electron on this machine), and sees both play as before.
