# ESPN's state has one writer; FastCast's follows are one map

2026-10-09. Follows the hub simplify (2026-10-09, ADR 0014). Comes before recording and replay
(`2026-10-09-recording-and-replay-design.md`), which does not depend on it.

## The problem

The ESPN provider is the one part of the Hub that is hard to hold in your head. `EspnState` has two writers and three
readers, joined by a queue, a lock and two drained merges:

```
 polls ──┐                      ┌──► wanted ──► FastCast.follow ──► pushes ─┐
         ├─► take (modifyEffect ┤                                          │
 pushes ─┘   lock + Queue.offer)├──► polling schedule (reads state) ◄──────┘
                                └──► said queue ──► deliveries
```

- Polls and pushes each call `take` on the one `SubscriptionRef`, and offer what it said into a queue **under the ref's
  lock**, only so deliveries leave in the order the state took their frames.
- `deliveries` is `Stream.fromQueue` merged with two `Stream.drain`ed streams; two `haltStrategy` flags say when it ends.
- The polling schedule needs each league's `Polled` result, which exists only after `take`, so the poll is threaded
  through `take` (`polledOf`, `Polled`, `unlisted`).

The loop itself (what FastCast follows depends on what the state knows) is inherent. The rest is not.

`FastCast.connect` has the same kind of problem at a smaller scale: one per-topic state machine, kept in three places.
`pending` (a `Ref` of `Deferred`s) says a follow waits for its `H`, `gaveUp` (a `Ref` of a `HashSet`) says a topic is
left to polling, and `follows` (a `FiberMap`) holds the fibers. Reading the socket's state means reading all three.

## 1. One fold, one writer

`EspnProvider`'s `deliveries` becomes one fold over one merged stream of events:

```ts
// inside EspnProvider.layer, per run of `deliveries`
const view = yield* SubscriptionRef.make(EspnState.empty)  // what the fold last took; read only
const pollAt = yield* SubscriptionRef.make(now)            // when the next poll round is due; written only by the fold

const rounds = SubscriptionRef.changes(pollAt).pipe(
  Stream.switchMap((at) => Stream.fromEffect(sleepUntil(at).pipe(Effect.andThen(pollEveryLeague))))
)                                                          // one element per round: every league's frame
const pushes = fastCast.follow(wanted(view))               // one element per frame

Stream.merge(rounds.pipe(Stream.map(Round)), pushes.pipe(Stream.map(Push))).pipe(
  Stream.mapAccumEffect(() => EspnState.empty, takeEvent)  // the one writer
)
```

- **The fold is the only writer.** `takeEvent` takes a `Push`'s frame, or each frame of a `Round` in order, then sets
  `view` to the new state. A `Round` also sets `pollAt` to now plus `interval(state, now)`. It emits each frame's
  deliveries, one array per frame, as now.
- **Order is the fold's order.** With one consumer there is no queue, no lock and no drained merge. `deliveries` ends
  when `rounds` and `pushes` both end, which is never in a live run.
- **A round can't start before the fold took the last one.** `switchMap` starts the next sleep only when `pollAt`
  changes, and only the fold changes it, after taking the round. The first round is due at once.
- **Poll IO stays outside the fold.** A round polls every league outside the fold, so pushes are not held up behind a
  slow scoreboard. The fold only decodes.
- **`wanted` reads `view`** as it read the state before: on each change and once a minute.

`EspnState` and its `take(frame)` keep their meaning. `Polled`, `polledOf` and `unlisted` go.

## 2. A failed poll is a frame; the state knows which leagues are unlisted

So the wait can be read from the state alone:

```ts
// Frame.ts
/** A poll that brought nothing: it did not connect, or was refused. */
PollFailed: { readonly league: LeagueId }
```

`EspnState` gains `unlisted: HashSet<LeagueId>`: a `Polled` that lists removes its league, and a `Polled` that does not
decode or a `PollFailed` adds it. `interval(games, anyUnlisted, now)` becomes `interval(state, now)`; its rules do not
change (10 s while live, a minute within 30 minutes of a kickoff, 15 minutes otherwise, capped at 30 s while any league
is unlisted).

The failed poll is still logged and counted (`sportal_provider_errors`) where it fails, in the round.

## 3. FastCast's follows are one map of one union

The per-topic state on a socket becomes one value:

```ts
// FastCast.ts, private
type TopicFollow = Data.TaggedEnum<{
  /** A follow sent its `S` and waits for the `H` that answers it. */
  Awaiting: { readonly answered: Deferred.Deferred<void, CheckpointUnread> }
  /** Its checkpoint kept failing: nothing follows it until the socket reconnects. */
  LeftToPolling: {}
}>
```

`connect` keeps one `Ref<HashMap<Topic, TopicFollow>>` in place of `pending` and `gaveUp`. A topic absent from the map
is synced, or not followed. `attempt` sets `Awaiting`, `answer` removes it and completes its `Deferred`, a follow that
gives up sets `LeftToPolling`, and `follow` returns at once for a topic `LeftToPolling`. The `FiberMap` stays: it holds
fibers, not state.

`connect` stays one function. It does not need its own module for one map.

## Out of scope

- `Provider.layerTest`'s handshake (a queue, a `Deferred` per frame, a `Ref`): it is a test's, and it is clear.
- The shell's `GuideReader` (a `PubSub`, a sliding queue and a `Deferred`) and `main.ts`'s sliding queue.
- Recording and replay.

## Testing

The behaviour does not change, so the existing `EspnProvider.test.ts`, `EspnState.test.ts` and `FastCast.test.ts` are
the guard. They pass unchanged, except where a test reached into the queue or `Polled`. New tests:

- `EspnState`: a `PollFailed` should add its league to `unlisted`; a `Polled` that lists should remove it; a `Polled`
  that does not decode should add it.
- `EspnProvider`: the next round should not start before the fold took the last; the first round should start at once.
- `EspnProvider`: a push arriving during a slow round should be delivered before the round's frames.
- `FastCast`: a topic `LeftToPolling` should not be followed again until the socket reconnects (this exists; it moves to
  the new map).

## Done when

- `EspnProvider.ts` has no `Queue`, no `modifyEffect` and no `haltStrategy`.
- `FastCast.connect` has one `Ref` for per-topic state.
- `pnpm check` is green, and a live game-day run (checklist) shows the same cadence on the Hub dashboard's poll panel.
