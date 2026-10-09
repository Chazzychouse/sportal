# ESPN's state has one writer, one rule, and only what it needs

2026-10-09. Follows the hub simplify (2026-10-09, ADR 0014). Comes before recording and replay
(`2026-10-09-recording-and-replay-design.md`), which does not depend on it.

Revised the same day after the `/simplify` review of `apps/hub`: sections 4–10 take in its findings. Sections 1–3 are
the first draft's, with polling now per league (section 2).

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
  through `take` (`polledOf`, `Polled`, `unlisted`). It guesses "did the scoreboard decode?" from whether a `Listing`
  came out.

The review found more of the same kind:

- **Two copies of "which snapshot wins".** `EspnState` keeps its own listing by `Game#listed` (`keptOver`, through a
  throwaway `Game.of(pushed)`), and the Slate applies `Game#listed` / `Game#snapshotTaken` again. On a push behind its
  listed game they disagree: the state takes it, the Slate drops it.
- **Placeholder names.** A FastCast event is decoded into a whole `GameSnapshot`, with `displayName` standing in for the
  short name and location it does not carry, and is correct only because `EspnState` always `advancedTo`s the listed
  game. A comment in `EspnEvent.ts` holds that invariant.
- **Wasted work and growth.** Each checkpoint is decoded twice; checkpoints load one at a time and hold up every other
  topic; each plays push decodes every play of the game; every league polls every 10 s while one game is live;
  FastCast documents are never dropped; the live stream rebuilds the whole published slate for each connection before
  its debounce; `sportal_game_state` keeps a series for every game ever seen.

The loop itself (what FastCast follows depends on what the state knows) is inherent. The rest is not.

## 1. One fold, one writer

`EspnProvider`'s `deliveries` becomes one fold over one merged stream of frames:

```ts
// inside EspnProvider.layer, per run of `deliveries`
const view = yield* SubscriptionRef.make(EspnState.empty)          // what the fold last took; read only
const pollAt = yield* SubscriptionRef.make(HashMap.empty<LeagueId, DateTime.Utc>()) // written only by the fold

const polls = Stream.mergeAll(leagues.map((league) => pollsOf(league, pollAt)), { concurrency: "unbounded" })
const pushes = fastCast.follow(wanted(view))

Stream.merge(polls, pushes).pipe(
  Stream.mapAccumEffect(() => EspnState.empty, takeFrame)          // the one writer
)
```

- **The fold is the only writer.** `takeFrame` takes the frame (`EspnState#take`), sets `view`, and, for a league's poll
  frame (`Polled` or `PollFailed`), sets that league's `pollAt` to now plus `interval(state, league, now)`. It emits the
  frame's deliveries, one array per frame, as now.
- **Order is the fold's order.** With one consumer there is no queue, no lock and no drained merge. `deliveries` ends
  when `polls` and `pushes` both end, which is never in a live run.
- **A league's next poll can't start before the fold took its last.** `pollsOf(league)` is
  `SubscriptionRef.changes(pollAt)` narrowed to that league's time (`Stream.changes`), `switchMap`ped to a sleep until
  then and one poll. Only the fold moves it, after taking the poll. A league with no time yet polls at once.
- **Poll IO stays outside the fold.** Each poll runs in its own stream, so pushes are not held up behind a slow
  scoreboard, and the two leagues poll side by side. The fold only decodes.
- **`wanted` reads `view`** as it read the state before: on each change and once a minute.

`Polled` (the interface), `polledOf`, `unlisted`, `pollEveryLeague` and the `Queue` go.

## 2. Each league polls by its own games; a failed poll is a frame

```ts
// Frame.ts
/** A poll that brought nothing: it did not connect, or was refused. */
PollFailed: { readonly league: LeagueId }
```

`EspnState` gains `unlisted: HashSet<LeagueId>`: a `Polled` that lists removes its league, and a `Polled` that does not
decode or a `PollFailed` adds it. `interval(games, anyUnlisted, now)` becomes `interval(state, league, now)`, reading
only that league's listed games and whether that league is unlisted. Its rules do not change: 10 s while one of them
is live, a minute within 30 minutes of a kickoff, 15 minutes otherwise, capped at 30 s while the league is unlisted.

**This changes behaviour:** on an NFL Sunday the FBS scoreboard (300 events) is polled every 15 minutes, not every
10 seconds, and the reverse on a Saturday.

The failed poll is still logged and counted (`sportal_provider_errors`) where it fails, in `pollsOf`.
`sportal_poll_duration` times one league's poll and gains a `league` attribute (its id does not change); the
dashboard's "Polls / 15 min" counts one per league poll.

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

## 4. One rule for which snapshot wins, in the domain

The Slate's rule (`Game#listed`, `Game#snapshotTaken`) is the only one. `EspnState`'s listing stops applying it: a
poll replaces its league's listing with the games it shows, and a push advances the listed game to it, as pushes do
now. `keptOver` goes.

The listing is what ESPN last said, used for the poll's cadence, what FastCast follows, and the names a push keeps
(section 5). It need not be the slate. A poll lagging a push can make it look one step behind for one poll: at worst a
league polls at a minute instead of 10 s once, at kickoff. The Slate, which the screen reads, still never goes back.

A push behind its listed game is still logged and counted (`sportal_push_behind_listing`): the dashboard panel stays.

## 5. A FastCast event is only what it carries

The FastCast branch of `EspnEvent` stops building a `GameSnapshot`. It decodes to what a FastCast event reliably says,
an inline shape private to the adapter:

```ts
{ id: GameId, status: GameStatus, period: number, clock: string,
  homeScore: number, awayScore: number, situation?: Situation }
```

`GameSnapshot#advancedTo` takes that shape (written inline in its signature) instead of a whole snapshot, and moves
only those fields. `EspnEvent` keeps one branch, the site scoreboard's, and becomes `EspnEvent` (site) plus a
`FastCastEvent` decode in the same file. The `displayName` fallbacks and their comment go, and `FastCastEvent` in
`EspnPayload.ts` drops the fields nothing reads (names, logos, colours, broadcasts, kickoff), keeping `homeAway`, `id`
and `score` on each competitor (the situation needs the home team's id to orient its yard line).

`Delivery.Snapshot` does not change: `EspnState` still delivers the listed game advanced to the push.

## 6. A checkpoint is decoded once

`Frame.Checkpoint` carries the decoded document instead of the text:

```ts
Checkpoint: { readonly topic: Topic; readonly mid: number; readonly document: Schema.Json }
```

`FastCast.checkpoint` decodes the body (it must, to answer the follow) and builds the document there: a scoreboard's
events by uid, or a game's plays under `/entities/plays`. That moves `FastCastDocuments`' `checkpoint` into
`FastCastMessage.ts` beside the checkpoint schemas, as `Checkpoint(topic)` decoding straight to the document.
`FastCastDocuments.synced` no longer decodes or fails: a checkpoint frame is a document.

## 7. Checkpoints load side by side

`connect`'s `Stream.mapEffect(framed)` takes `{ concurrency: 4 }`. Output order is kept, so a topic's checkpoint frame
still comes after its `H` and before the patches that follow it, but the fetches overlap: a reconnect that wants a
dozen checkpoints waits for the slowest, not their sum.

## 8. A plays push decodes only the plays it touched

`DocumentChange.Game` carries the ids its patches touched, as `DocumentChange.Scoreboard` carries uids (every play, on a
checkpoint), and the plays its patches removed. `EspnState` keeps each followed game's decoded plays,
`HashMap<GameId, HashMap<PlayId, Play>>`, decodes only the touched entities, and drops the removed. `Delivery.Plays`
still carries the whole list; `playsOf`'s sort goes, since `Game#playsTaken` sorts.

## 9. Nothing is kept for a topic that is not followed

When a poll frame is taken, `EspnState` keeps documents and decoded plays only for the topics in `wanted(leagues,
now)`; the rest are dropped. `EspnState#take` takes `now` for it. A topic followed again starts from its checkpoint,
as it does after a reset.

## 10. The live stream is built once

- **One published stream for every connection.** `HubServer` builds `published` once in its layer and shares it
  (`Stream.share` with `replay: 1`), so a connection gets the current slate at once and each change after. Encoding to
  an SSE line moves inside the shared stream: one encode per change, not per connection.
- **Debounce first.** `settled` runs on `zipLatest(director.slate, source.availability)`, before `published` maps it,
  so a burst of slate changes builds the published slate once.
- **Availability builds each game's window once.** `Guide.availabilityOf` computes `kickoff ± tolerance` once per game
  instead of once per airing.

## 11. A delisted game's series goes

On `Delisted`, the Director removes the game's `sportal_game_state` series from `Metric.MetricRegistry` (a `Map`; the
entries whose `id` is the gauge's and whose `game` attribute is the game) instead of setting it to 0. Prometheus marks
it stale; the "Games" panel and the `matchup` variable show only listed games. The gauge's id and attributes do not
change.

## Already done

The `/simplify` pass (uncommitted on `main`): `Slate#game` removed, `relisted` and `movedForward` look up once,
`EspnState#listing`, `FastCastDocuments.advance` narrowed to push and checkpoint frames, checkpoint schemas built once,
`Progress` exported from the domain.

## Out of scope

- `Provider.layerTest`'s handshake (a queue, a `Deferred` per frame, a `Ref`): it is a test's, and it is clear.
- The shell's `GuideReader` (a `PubSub`, a sliding queue and a `Deferred`) and `main.ts`'s sliding queue.
- The guide's double warning (`GuideReader` and `HubServer` both log an unreadable guide), Twitch's lineup as a
  `Guide` read at the epoch, and the test-helper duplication the review found: next design pass.
- Recording and replay.

## Testing

`EspnProvider.test.ts`, `EspnState.test.ts`, `FastCast.test.ts`, `FastCastDocuments` (through `EspnState.test.ts`),
`HubServer.test.ts` and `Director.test.ts` are the guard. Tests that reached into the queue, `Polled`, a checkpoint's
text, or `keptOver` change with them. New or changed tests:

- `EspnState`: a `PollFailed` should add its league to `unlisted`; a `Polled` that lists should remove it; a `Polled`
  that does not decode should add it.
- `EspnState`: a poll should replace its league's listing even where a push was ahead of it.
- `EspnState`: a plays push should deliver the game's whole list after decoding only the touched plays; a removed play
  should leave the list.
- `EspnState`: a poll frame should drop the documents and plays of topics no longer wanted.
- `EspnProvider`: a league's next poll should not start before the fold took its last; the first should start at once.
- `EspnProvider`: a league with no live game should poll every 15 minutes while the other league's game is live.
- `EspnProvider`: a push arriving during a slow poll should be delivered before the poll's frame.
- `FastCast`: a checkpoint frame should carry the decoded document; two checkpoints should load at once, their frames in
  order.
- `FastCast`: a topic `LeftToPolling` should not be followed again until the socket reconnects (exists; moves to the
  new map).
- `EspnEvent`: a FastCast event should decode to its status, period, clock, scores and situation.
- `HubServer`: two connections should get the same messages; a burst of slate changes should publish once.
- `Director`: a delisted game should have no `sportal_game_state` series.

## Done when

- `EspnProvider.ts` has no `Queue`, no `modifyEffect` and no `haltStrategy`.
- `EspnState` has no `keptOver`, and `EspnEvent.ts` no `displayName` fallback.
- `FastCast.connect` has one `Ref` for per-topic state, and a checkpoint body is decoded once.
- `pnpm check` is green, and a live game-day run (checklist) shows on the Hub dashboard each league polling at its own
  cadence, documents not growing past the followed topics, and the Games panel listing only listed games.
