# One ESPN fold, a FastCast that follows, a Slate that says what changed

2026-10-09. Follows ADR 0013 (scenarios go) and the slate of games (2026-10-08).

## The problem

The ESPN side keeps "the games each league shows" four times, each built from the same frames:

| Holder | What it keeps | Why |
|---|---|---|
| `EspnProvider`'s `polling` schedule | `shown: HashMap<LeagueId, GameSnapshot[]>` | to pace the next poll |
| `EspnDecoder.decode` | `listings` and every FastCast document | to decode pushes against the last listing |
| `FastCast.steered` | the same documents again, plus `games` and `followed` | to decide which game topics to follow |
| `Slate` | the result | the truth |

So `FastCastDocument.advance` runs twice for every pushed frame, scoreboard events are decoded twice, and polling
and steering answer "what is live or about to kick off" from separate states that can disagree.

Around it:

- `Frame` is a record of strings. `source: "push" | "poll"`, a `channel` that is a league or a topic, `kind:
  "whole" | "change"` and an optional `number`. Every reader decodes it again: `decodeLeague(frame.channel)`,
  `decodeMid(frame.number)`, `ownerOf(frame.channel)`.
- Following a FastCast topic is wired by hand: a `PubSub` of `Result`s, one filtered subscription per attempt, and a
  `FiberMap` that keeps a topic whose checkpoint gave up parked on `Effect.never`.
- After every take, the Director rebuilds what changed by building `byId` maps of the slates before and after
  (`gaugeChanged`, `loggedNewPlays`).

## 1. Topics and frames are typed once, at the edge

**`Topic`** replaces the topic strings and `Owner` (`FastCastTopic.ts` becomes `Topic.ts`):

```ts
// apps/hub/src/provider/espn/Topic.ts
export type Topic = Data.TaggedEnum<{
  Scoreboard: { readonly league: LeagueId }
  Game: { readonly league: LeagueId; readonly game: GameId }
}>
export const Topic = Data.taggedEnum<Topic>()
// plus: the wire string of a topic (`tc`), and the topic a wire string names, if any
```

FastCast parses an envelope's channel once. Nothing downstream calls `ownerOf`. Topics are compared as values
(`Equal`), and a set of them is a `HashSet<Topic>` or a `HashMap<Topic, …>`.

`FastCastDocument`'s own per-topic state, now also called `Topic`, is renamed **`Document`**:
`AwaitingCheckpoint | Synced { mid, document }`.

**`Frame`** becomes a `Data.taggedEnum`. It was a `Schema.Class` only so that recordings could be written, and the
recordings are gone.

```ts
// apps/hub/src/provider/espn/Frame.ts
export type Frame = Data.TaggedEnum<{
  /** A poll's response: the league's whole scoreboard. */
  Polled: { readonly league: LeagueId; readonly receivedAt: DateTime.Utc; readonly body: string }
  /** A socket text: a change to its topic's document, or any other op; no topic when its channel names none. */
  Pushed: {
    readonly topic: Option.Option<Topic>
    readonly mid: Option.Option<number>
    readonly receivedAt: DateTime.Utc
    readonly body: string
  }
  /** The checkpoint an `H` pointed to: its topic's whole document as of `mid`. */
  Checkpoint: { readonly topic: Topic; readonly mid: number; readonly receivedAt: DateTime.Utc; readonly body: string }
}>
```

`source`, `kind`, `channel`, `number`, `decodeLeague` and `decodeMid` go away. The decoder's log annotations take
the frame's tag and its topic's `tc` instead.

This step changes no behaviour.

## 2. One fold: `EspnState`

```ts
// apps/hub/src/provider/espn/EspnState.ts
export class EspnState extends Data.Class<{
  /** Each topic's document. */
  readonly documents: HashMap<Topic, Document>
  /** Each league's listed games: its last poll, advanced by each pushed scoreboard change since. */
  readonly listings: HashMap<LeagueId, ReadonlyArray<GameSnapshot>>
}> {
  static readonly empty: EspnState

  /** This state after `frame`, and what the frame said; a frame that does not decode says nothing and is logged. */
  take(frame: Frame): Effect.Effect<readonly [EspnState, ReadonlyArray<Delivery>]>

  /** Every listed game, for the poll's pace. */
  games(): ReadonlyArray<GameSnapshot>

  /**
   * The topics to follow at `now`, each with its document: every league's scoreboard topic, and the topic of each
   * listed game that is live or kicks off within `GameSnapshot.kickoffWindow`.
   */
  wanted(leagues: ReadonlyArray<LeagueId>, now: DateTime.Utc): HashMap<Topic, Document>
}
```

- `take` replaces the `mapAccumEffect` in `EspnDecoder.decode` and the document fold in `FastCast.steered`.
- **Behaviour change.** A pushed scoreboard change now also moves the game forward in `listings`. Before, pushes
  only produced a `Snapshot` delivery. Polling and FastCast both read the one state:
  - A push showing a game live makes the next poll wait at most 10 s, without waiting for a poll to see it.
  - FastCast follows only games a poll has listed. A pushed game with no listing is ignored, as the Slate already
    ignores it.
  - Before the first poll, FastCast follows only the scoreboard topics.
- `EspnDecoder` shrinks to `byLeague` (the per-league schema decoders), `gamesOf` and `playsOf`, which
  `EspnState.take` calls. `decode` goes.
- `FastCastDocument.advance` keeps its contract, now keyed by `Topic`. Its `Change.Reset` case goes: a reset is the
  topic's `Document` turning back to `AwaitingCheckpoint`, which `wanted` shows and FastCast acts on (section 3).

**The provider's wiring**

```ts
// EspnProvider.layer, in outline
const state = yield* SubscriptionRef.make(EspnState.empty)

const wanted = Stream.merge(SubscriptionRef.changes(state), minuteTicks).pipe(
  Stream.mapEffect(() => wantedNow),          // reads `state` and `DateTime.now`
  Stream.changesWith(Equal.equals)
)
const polls = Stream.fromEffectSchedule(pollEveryLeague(), polling(state))
const frames = Stream.merge(polls, fastCast.follow(wanted))

const deliveries = frames.pipe(
  Stream.mapEffect((frame) => SubscriptionRef.modifyEffect(state, (current) => swapped(current.take(frame))))
)
```

- The one-minute tick means a game entering the kickoff window is followed even if no frame arrives. Today
  FastCast's ~10 s `B` heartbeat does this job.
- The `polling` schedule's input becomes the leagues that failed in the last poll. Each step reads `games()` from
  `state` instead of carrying its own `shown` map. Its intervals stay the same: 10 s while a game is live, 1 min
  within 30 min of a kickoff, 15 min otherwise, and at most 30 s after a failed or undecodable league.
- `Polled` and `shownAfter` go.
- When the poll fails or its scoreboard does not decode, the league keeps its last good listing. This was the
  schedule's rule and is now `take`'s: a `Polled` frame that does not decode changes nothing.

## 3. FastCast follows a wanted set

FastCast stops decoding and steering. It becomes the socket and its checkpoints, reconciling toward a wanted set:

```ts
export class FastCast extends Context.Service<FastCast, {
  /**
   * Every socket text and checkpoint, as frames, while following `wanted`, for as long as it runs. Never fails.
   */
  follow(wanted: Stream.Stream<HashMap<Topic, Document>>): Stream.Stream<Frame>
}>
```

**The rule.** On each connected socket, follow every wanted topic whose document is `AwaitingCheckpoint` and has
no follow in flight. Leave every followed topic that is no longer wanted.

| What happens | Seen as | FastCast does |
|---|---|---|
| A game enters the kickoff window | a new topic in `wanted`, `AwaitingCheckpoint` | follows it |
| A topic's document resets (missed mid, a patch that will not apply, a message that does not decode) | its `Document` back to `AwaitingCheckpoint` | follows it again |
| A game goes final | its topic leaves `wanted` | interrupts its follow, logs the leave |
| The socket reconnects | a fresh connection | follows every wanted topic still `AwaitingCheckpoint` |

On a fresh socket every topic needs a checkpoint again. So when a socket opens, the fold sends every document back
to `AwaitingCheckpoint`. It learns of the new socket from a `Pushed` frame of the `C` handshake, which FastCast
already frames.

`Steer` (`Follow | Leave | FollowAgain`) stays only as the name of what each step did, for its log and for
`sportal_live_feed_steers`. It is computed by diffing one wanted set with the next.

**A follow in flight.** This replaces the `PubSub`, its filtered subscriptions and the parking on `Effect.never`.

- `pending: Ref<HashMap<Topic, Deferred<void, CheckpointUnread>>>`. A follow registers its `Deferred`, sends `S`,
  and awaits it. `framed` completes that topic's `Deferred` once the `H`'s checkpoint loads and decodes, or fails
  it with `CheckpointUnread`.
- `follows: FiberMap<Topic>` with `onlyIfMissing`. Each follow is `attempt.pipe(Effect.retry(retry.checkpoint))`.
- When the retry runs out, the follow logs that the topic is left to polling, adds the topic to a `gaveUp:
  Ref<HashSet<Topic>>` for this socket, and ends. The topic is not followed again until the socket reconnects,
  which was the old rule. No fiber is left parked.

**Unchanged:** the handshake and its refusals, `silence`, the reconnect backoff and `Stream.retry`, `stopped`,
`ProviderUnavailable`, `CheckpointUnread`, `FastCast.make(retry)` and `FastCast.layer`'s two Schedules, and every
metric name and its attributes. `FastCast.layerTest(frames)` becomes `layerTest((wanted) => frames)`, so a test can
assert what was wanted.

**Removed:** `Following`, `steered`, `followedAt`, the `outcomes` `PubSub`, and FastCast's imports of
`EspnDecoder` and `FastCastDocument`.

## 4. The Slate says what it changed

```ts
// apps/hub/src/slate/Slate.ts
take(deliveries: ReadonlyArray<Delivery>): readonly [Slate, ReadonlyArray<SlateChange>]

/** One thing a take changed. */
export type SlateChange = Data.TaggedEnum<{
  /** A listed game's snapshot changed, or a listing named it for the first time. */
  Progressed: { readonly game: Game }
  /** No listing of its league names it any more. */
  Delisted: { readonly game: Game }
  /** A play its game did not have before. */
  Played: { readonly game: Game; readonly play: Play }
}>
export const SlateChange = Data.taggedEnum<SlateChange>()
```

- `relisted` and `changed` emit changes where they happen. A take that changes nothing still returns this same
  `Slate`, with no changes.
- `Game#playsAfter` stays: `changed` reads it to emit `Played`. Its only other caller, the Director, no longer
  needs it.
- `Slate.games` stays an ordered array. Order is what the slate means, and it is the shape of `SlateChanged` on the
  wire. An index keyed by id would be a second structure to keep in step, only to speed up a `findIndex` over at
  most ~300 games.

The Director's `take` becomes:

```ts
const before = yield* SubscriptionRef.get(slate)
const [next, changes] = before.take(deliveries)
if (next === before) return

yield* SubscriptionRef.set(slate, next)
yield* Effect.forEach(changes, observed, { discard: true })

// below the layer
const observed = SlateChange.$match({
  Progressed: ({ game }) => gauge(game.snapshot, progressValues[game.snapshot.progress()]),
  Delisted: ({ game }) => gauge(game.snapshot, 0),
  Played: ({ game, play }) => loggedPlay(game.snapshot, play)
})
```

`gaugeChanged`, `loggedNewPlays` and `byId` go.

## 5. Order of work

On a branch `hub-simplify`, in a worktree. Each step passes `pnpm check` and is its own commit.

1. **Typed `Topic` and `Frame`** (section 1). Mechanical; no behaviour change.
2. **`EspnState`** (section 2). FastCast still steers from its own fold for now; its `frames` are read through
   `follow` with the wanted set ignored.
3. **FastCast follows the wanted set** (section 3). The old steering is deleted.
4. **`SlateChange`** (section 4). Independent of 1–3.
5. **Docs** (section 7).

## 6. Tests

All tests follow AGENTS.md: one behaviour per test, `should …`, AAA, recorded payloads from `espn/fixtures`.

- **`EspnState.test.ts`** (new). It mostly takes over `EspnDecoder.test.ts`:
  - a poll lists its league;
  - a poll that does not decode keeps the last listing;
  - a push moves a listed game forward, both in `listings` and as a `Snapshot`;
  - a push for an unlisted game says nothing;
  - a game topic's change is its `Plays`;
  - `wanted` holds the scoreboard topics and live or kicking-off games, and not final ones;
  - a reset turns a topic's document back to `AwaitingCheckpoint`;
  - a `C` handshake sends every document back to `AwaitingCheckpoint`.
- **`EspnProvider.test.ts`**: polling paces itself from the state, including a push that shows a game live.
- **`FastCast.test.ts`**: its steering-from-frames cases go; their assertions move to `EspnState.wanted`. It gains
  reconcile cases:
  - follows a new wanted topic;
  - leaves an unwanted one;
  - follows again a topic whose document went back to `AwaitingCheckpoint`;
  - gives up after the checkpoint retry and follows again after a reconnect.

  The socket, handshake, silence and reconnect cases stay.
- **`Slate.test.ts`**: each take's changes are asserted beside its slate.
- **`Director.test.ts`**: keeps its gauge and play-log assertions.
- **Commit bodies**: each rewritten file lists every old test name and the new tests that carry its assertions, or
  the removed behaviour it went with. The one removed behaviour is "FastCast steers only from the pushed
  scoreboard".

## 7. Docs

- **`CONTEXT.md`**:
  - **Frame**: reworded for its three cases.
  - **Delivery source**: removed, since it is now the frame's tag.
  - **Topic owner**: becomes **Topic**.
  - **Checkpoint unread**: reworded, since the follow ends rather than parks.
  - **New rows**: **ESPN state**, **Wanted topics**, **Slate change**.
- **`docs/technical-spec.md`**: the Hub's data flow.
- **ADR 0014**: "One ESPN fold; FastCast reconciles a wanted set".

## 8. Verification

- `pnpm check` after every step.
- A live run on a game day, against the FastCast items of `docs/game-day-checklist.md`:
  - game topics followed at kickoff window and left at final;
  - a reset followed again;
  - polling at 10 s once a push shows a game live;
  - the Hub dashboard's live-feed panels reading as before.

There are no offline scenarios, so a game day is the only end-to-end check.

## Amendments while planning (2026-10-09)

Reading the tests and the Effect APIs while writing the plan changed these points. Where they conflict with the
sections above, they win.

1. **No reset on the `C` handshake.** Sending every document back to `AwaitingCheckpoint` on `C` races with
   checkpoints already loading for the new socket. FastCast acts on *changes* in the wanted set, not on its level:
   - it follows a topic newly wanted, or one whose document went from `Synced` to `AwaitingCheckpoint`;
   - on each new socket it starts from an empty previous set, so it follows every wanted topic.

   A topic just checkpointed stays `AwaitingCheckpoint` in `wanted` until the fold takes its `Checkpoint` frame, and
   no second follow starts, because no transition happened.
2. **The wanted set carries document states, not documents.** It is
   `Wanted = HashMap<Topic, "Synced" | "AwaitingCheckpoint">`, exported beside `FastCast` as a port's member type,
   so successive sets compare cheaply with `Equal`. `Document` stays private to `FastCastDocument`, which exports
   `isSynced(documents, topic)`.
3. **`Change.Reset` stays.** The fold reads it to log why a topic lost its document; FastCast then logs only that it
   follows the topic again. FastCast no longer knows the reason.
4. **The poll's wait reads pushes; it does not cut a wait short.** The wait is chosen after each poll, from the
   state. So a push that shows a game live shortens the *next* wait, not the one already running.
   - A poll that lags a push must not set the pushed game back in the listing. Relisting keeps, per game, what
     `Game#listed` keeps: `Game.of(pushed).listed(polled).snapshot`.
   - The `Listing` delivery still carries the poll's own games, since the Slate applies its own rule.
5. **Polls are taken into the state inside the poll.** `pollEveryLeague` takes each frame before the schedule
   steps, so the wait reads this poll's games. The schedule's input is each league's part of the poll (what it
   said, or none when it failed).
6. **`Frame` has no `receivedAt`.** Nothing read it.
7. **An `H` on a topic no name reads loads no checkpoint.** It is framed as `Pushed` only. Before, it loaded the
   checkpoint and the documents ignored it.
8. **FastCast no longer needs `HubConfig`.** The wanted set carries the scoreboard topics.
9. **`Steer` drives the socket.** It is the result of `steersBetween(previous, next)`, and the socket acts on it.
   "Only as a name" in section 3 understated this.

## Out of scope

`Source`, `GuideReader`, `HubServer`, `HubStopping`, `HubConfig`, the web app and the shell.
