# The ESPN provider keeps its warnings and loses its telemetry

2026-10-09. Follows ESPN's one writer (`2026-10-09-espn-one-writer-design.md`).

## The problem

`FastCast.ts` and `EspnProvider.ts` carry nine metrics, two named spans, and a log line for every steer. Most of
`FastCast`'s machinery exists to feed them or to give a failed checkpoint a bounded retry:

- **Counting shapes the code.** `framed` parses each text's op and league only to count it; `steer` wraps `steerTo`
  only to count the steer; `failed` exists only to count by reason; a gauge and a finalizer track whether the socket is
  connected and how many game topics it follows; `poll` is a two-part `Effect.fn` so its span records the failure
  before `polled` turns it into a frame.
- **A bounded checkpoint retry.** A topic whose checkpoint fails is retried on a Schedule. To know when an attempt
  failed, each follow parks on a `Deferred` in a `TopicFollow` map that `framed` answers through a callback; once the
  Schedule is done, the topic is `LeftToPolling` until the socket reconnects. That is a `Deferred`, a `Ref` of a tagged
  enum, a `FiberMap`, an `Exit`-passing callback, and a Schedule, all for "subscribe again later".
- **A Steer enum for one action.** Leave sends ESPN nothing: it only cancels the follow, and `EspnState` drops the
  documents of topics no longer wanted. With the retry gone, every steer comes down to "send `S` for this topic".
- **An unreachable end.** `stopped` logs that the live feed stopped once the reconnect Schedule is done, but the
  production reconnect never ends.

## The design

### What goes and what stays

- Every metric goes: `sportal_live_feed_connected`, `_topics`, `_received`, `_steers`, `_errors`,
  `_checkpoint_failures`, `sportal_checkpoint_duration`, `sportal_poll_duration`, `sportal_provider_errors`.
- The named spans go: `FastCast.connect` and `EspnProvider.poll` become `Effect.fnUntraced` or plain pipes, and the
  `sportal.league` span annotation goes.
- The info log for each follow, leave, and follow-again goes.
- Warnings stay: a socket that failed (with its reason), a checkpoint that failed, a poll that failed (annotated with
  its league). `connected to <ip>` stays at info.

### FastCast

**Steering.** `Steer`, `steersBetween`, `steer`, and `steerTo` go. One pure function says what changed:

```ts
function subscriptionsBetween(previous: Wanted, next: Wanted): {
  readonly subscribe: ReadonlyArray<Topic> // newly wanted, or Synced → AwaitingCheckpoint
  readonly left: ReadonlyArray<Topic> // no longer wanted
}
```

Each topic in `subscribe` is offered as an `S` to the socket's outgoing queue; each in `left` has its pending
re-subscribe, if any, removed from the `FiberMap`.

**A failed checkpoint.** `framed` logs the warning, then calls `resubscribeLater(topic)`:

```ts
FiberMap.run(pending, topic, Effect.sleep(refollow).pipe(Effect.andThen(subscribe(topic))), { onlyIfMissing: true })
```

At most one is pending per topic; a later `H` brings a fresh checkpoint URL. There is no limit: a topic whose checkpoint
never loads costs one request every 30 s while it is wanted. `TopicFollow`, `Deferred`, `attempt`, `answer`, the
`answer` callback in `framed`, and the `LeftToPolling` state all go. `framed` no longer parses the op or league.

**`make`** takes `{ refollow: Duration.Input, reconnect: Schedule.Schedule<unknown, ProviderUnavailable> }`. `refollow`
is a delay rather than a Schedule because it is now a fixed wait with no limit. `layer` passes `"30 seconds"` and the
same reconnect backoff as today (1 s doubling, jittered, up to a minute).

**A failed socket.** `failed` is inlined as `Stream.tapError` with the warning. `stopped` and the `HubStopping` import
go; after `Stream.retry`, `Stream.orDie` keeps `follow`'s stream from failing. Only a test's finite reconnect Schedule
can reach it.

**Unchanged:** the handshake, the 45 s silence timeout, the 20 s checkpoint timeout, checkpoints loading four at a time
with frames leaving in the texts' order, and `Wanted`.

### EspnProvider

- `poll` and `polled` become one function: `client.get` → `text` → `Frame.Polled`; on any error, a warning annotated
  with the league, and `Frame.PollFailed`. It no longer builds a `ProviderUnavailable`.
- `wantedOf` becomes `Stream.merge(SubscriptionRef.changes(view), Stream.tick("1 minute") → SubscriptionRef.get(view))`,
  then `wanted(leagues, now)`, then `Stream.changes`. The `mapAccum` over `Option<EspnState>` goes.
- `takeFrame` sets the league's next poll with a plain `if` on the frame's league, not an `Option` chain.

### Errors

- `ProviderUnavailable` loses `league` and the `Unreachable` reason; it is FastCast's socket failure only
  (`Refused`, `Closed`, `Silent`).
- `CheckpointUnread` is unchanged (`Unloaded`, `Undecodable`); it is what the checkpoint warning carries.
- `CONTEXT.md`: the rows **Provider unavailable**, **Checkpoint unread**, and **Wanted topics** say what the code now
  does: logged, not counted; a failed checkpoint is subscribed to again after 30 s while wanted.

### Outside the code

- `telemetry/dashboards/hub.json` loses every panel that reads these metrics, and the Poll traces panel: the stat tiles
  Connected, Game topics followed, Push messages / min, Polls / 15 min, Feed failures in range, Provider errors in
  range; Messages by op, Patches by league, Topics followed and steers, Checkpoint duration, Feed errors by reason; Poll
  duration, Provider errors by league. The log panels and the game and play panels stay. A row left empty goes.
- `docs/technical-spec.md`: the lines naming these metrics say "logged". ADRs stay as written; they are history.

### Tests

- Metric assertions and their `withMetrics` wrappers go, along with tests that only checked a metric.
- The left-to-polling and Schedule-limit tests are replaced by:
  - should subscribe to a topic whose checkpoint failed again after 30 s
  - should not subscribe to it again before 30 s
  - should not subscribe again to a topic left while its re-subscribe waited
- "should log that the live feed stopped and stay quiet once its reconnect is done" goes.
- `TestTelemetry.ts` stays: Director, EspnState, and Telemetry tests use it.
