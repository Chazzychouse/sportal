# ESPN provider without telemetry: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every metric and named span from `FastCast.ts` and `EspnProvider.ts`, and replace FastCast's bounded
checkpoint retry with a plain "subscribe again after 30 s while wanted".

**Architecture:** EspnProvider's poll becomes one pipe that logs and turns any failure into `PollFailed`. FastCast
keeps its socket, handshake, silence timeout and ordered checkpoint loading. Steering becomes `toSubscribe` plus a
wanted `Ref`. A failed checkpoint forks one sleeping re-subscribe per topic in a `FiberMap`. Dashboard panels, spec
lines and glossary rows that named the removed metrics follow.

**Tech Stack:** TypeScript, Effect 4 (`effect@4.0.0`), `@effect/vitest`, Grafana dashboard JSON.

**Spec:** `docs/specs/2026-10-09-espn-no-telemetry-design.md`

## Global Constraints

- Read `AGENTS.md` first. Effect 4 is newer than training data: check APIs in `node_modules/effect/ai-docs/src/`
  and `node_modules/effect/dist/*.d.ts`, not from memory.
- Warnings stay with their exact current messages:
  - `FastCast: the live feed failed (${error.reason}); subscribing again`
  - `EspnProvider: a poll failed; keeping the last good listing for this league, if any`
- The checkpoint warning keeps its `topic` and `reason` log annotations. The poll warning gains a `league` annotation.
- `FastCast: connected to ${host.ip}` stays at Info. No other Info logs in FastCast.
- The checkpoint re-subscribe wait is `"30 seconds"`. Reconnect backoff is unchanged: 1 s doubling, jittered, up to
  a minute. The silence timeout (45 s) and checkpoint timeout (20 s) are unchanged.
- Comments only for a genuinely unclear why; doc comments on exports and module-level functions, in the file's
  existing voice.
- Tests: one behaviour per test, `should …` names, Arrange / Act / Assert separated by one blank line, no AAA comments.
- ADRs and old specs/plans are history: do not edit them.
- Verify with `pnpm check` (biome, typecheck, depcruise, vitest) before the last commit.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: EspnProvider polls with no metric, span, or `ProviderUnavailable`

**Files:**
- Modify: `apps/hub/src/provider/espn/EspnProvider.ts`
- Test: `apps/hub/src/provider/espn/EspnProvider.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `EspnProvider.ts` no longer imports `ProviderUnavailable`, so Task 2 can narrow that class.

- [ ] **Step 1: Rewrite the failure tests**

In `EspnProvider.test.ts`, in `describe("EspnProvider", …)`, replace the two tests
`"should take a poll that cannot connect as Unreachable for its league"` and
`"should take a poll answered with a non-2xx as Refused for its league"` with:

```ts
  it.effect("should take a poll answered with a non-2xx as a failed poll", () =>
    Effect.gen(function* () {
      const said = yield* polledOnce(
        answering(() => Effect.succeed(new Response("busy", { status: 503 }))),
        { leagues: "fbs", frames: 1 }
      )

      assert.deepStrictEqual(said, [[]])
    })
  )
```

Replace `"should log and count a league that fails"` with:

```ts
  it.effect("should warn of a league that fails, annotated with its league", () => {
    const { logs, layer } = recordingLogs()
    return Effect.gen(function* () {
      yield* polledOnce(
        answering(() => Effect.fail(new Cause.UnknownError("ECONNREFUSED"))),
        { leagues: "fbs", frames: 1 }
      )

      const warned = logs.filter(
        ({ level, message }) =>
          level === "Warn" &&
          message.includes(
            "EspnProvider: a poll failed; keeping the last good listing for this league, if any"
          )
      )
      assert.lengthOf(warned, 1)
      assert.strictEqual(warned[0]?.annotations.league, "fbs")
    }).pipe(Effect.provide(layer))
  })
```

Delete these two tests:
- `"should make each league's poll its own span, named for its league"`
- `"should record each poll's duration by league"`

Change the helpers:
- In `espnOver`, drop the `ended` option from the options type and from the doc comment ("and each span that ends
  recorded in `ended`"). Drop the trailing `Layer.provideMerge(recordingSpans(options.ended ?? []))`, so it ends at
  the `Layer.provide([...])`.
- In `polledOnce`, drop `readonly ended?: Array<Tracer.Span>` from the options type, and drop ", each span that ends
  recorded in `ended`" from its doc comment.
- Delete the `pollFailures` function and its doc comment.
- Remove the imports that are now unused. Expect `counted`, `observed`, `recordingSpans`, `withMetrics`,
  `ProviderUnavailable` and `type Tracer`, and possibly `Exit` and `Schema`; let biome say which.

- [ ] **Step 2: Run the tests to see the new warning test fail**

Run: `pnpm vitest run apps/hub/src/provider/espn/EspnProvider.test.ts`
Expected: `should warn of a league that fails, annotated with its league` FAILS (`annotations.league` is undefined).
The rest pass.

- [ ] **Step 3: Rewrite `EspnProvider.ts`**

Replace the import block with:

```ts
import { GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { DateTime, Duration, Effect, HashSet, Layer, Option, Stream, SubscriptionRef } from "effect"
import { HttpClient } from "effect/http"
import { HubConfig } from "../../HubConfig.ts"
import { Provider } from "../Provider.ts"
import { EspnState } from "./EspnState.ts"
import { FastCast, type Wanted } from "./FastCast.ts"
import { Frame } from "./Frame.ts"
```

Replace the layer's doc comment with:

```ts
/**
 * ESPN as the provider: the site scoreboard of each league `HubConfig` names, polled, and FastCast pushing, every frame
 * folded, in the order it arrives, into one `EspnState` by one fold. Each league polls on its own, waiting after each
 * poll by its own listed games: 10 seconds while one is live, a minute within 30 minutes of a kickoff, and 15 minutes
 * otherwise; at most 30 seconds while its last poll failed or did not decode. A poll that fails is logged and is a
 * `PollFailed` frame. It tells FastCast to follow every league's scoreboard topic and each listed game live or within
 * 30 minutes of kickoff, and keeps no document of a topic it no longer follows. Each run of `deliveries` polls and
 * follows on its own.
 */
```

Replace everything from `const poll = Effect.fn("EspnProvider.poll")(` through the end of `const polled = …`
(including the `// Outside the span…` comment) with:

```ts
    const polled = (league: LeagueId) =>
      client.get(scoreboardUrl(league)).pipe(
        Effect.flatMap((response) => response.text),
        Effect.map((body) => Frame.Polled({ league, body })),
        Effect.catch((error) =>
          Effect.logWarning(
            "EspnProvider: a poll failed; keeping the last good listing for this league, if any",
            error
          ).pipe(Effect.annotateLogs({ league }), Effect.as(Frame.PollFailed({ league })))
        )
      )
```

Replace `takeFrame` with:

```ts
        const takeFrame = Effect.fnUntraced(function* (state: EspnState, frame: Frame) {
          const [taken, said] = yield* state.take(frame)
          const now = yield* DateTime.now

          const league = pollLeagueOf(frame)
          const next = Option.isSome(league) ? taken.retained(leagues, now) : taken
          yield* SubscriptionRef.set(view, next)
          if (Option.isSome(league)) {
            const at = pollAt.get(league.value)
            if (at !== undefined) {
              yield* SubscriptionRef.set(
                at,
                Option.some(DateTime.addDuration(now, interval(next, league.value, now)))
              )
            }
          }

          return [next, [said]] as const
        })
```

Replace `wantedOf` and its doc comment with:

```ts
/**
 * What FastCast follows, read from `view` on each change and once a minute, so a kickoff coming into its window is
 * followed with no frame to say so.
 */
function wantedOf(
  view: SubscriptionRef.SubscriptionRef<EspnState>,
  leagues: ReadonlyArray<LeagueId>
): Stream.Stream<Wanted> {
  return Stream.merge(
    SubscriptionRef.changes(view),
    Stream.tick("1 minute").pipe(Stream.mapEffect(() => SubscriptionRef.get(view)))
  ).pipe(
    Stream.mapEffect((state) => Effect.map(DateTime.now, (now) => state.wanted(leagues, now))),
    Stream.changes
  )
}
```

Delete the `pollDuration` and `providerErrors` metric consts at the end of the file.

- [ ] **Step 4: Run the tests and the checks**

Run: `pnpm vitest run apps/hub/src/provider/espn/EspnProvider.test.ts`
Expected: all PASS, including `should want a game's topic once its kickoff is 30 minutes away, with no frame` (this
exercises the new `wantedOf`).

Run: `pnpm exec biome check apps/hub/src/provider/espn && pnpm typecheck`
Expected: no errors. Fix any unused imports biome names.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/provider/espn/EspnProvider.ts apps/hub/src/provider/espn/EspnProvider.test.ts
git commit -m "refactor: EspnProvider polls with no metrics or span; a failed poll is a warning by league

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: FastCast with no telemetry, re-subscribing a failed checkpoint after 30 s

**Files:**
- Modify: `apps/hub/src/provider/espn/FastCast.ts` (full rewrite below)
- Modify: `apps/hub/src/provider/espn/ProviderUnavailable.ts`
- Test: `apps/hub/src/provider/espn/FastCast.test.ts`

**Interfaces:**
- Consumes: Task 1 (EspnProvider no longer builds `ProviderUnavailable`).
- Produces:
  - `FastCast.make({ refollow: Duration.Input, reconnect: Schedule.Schedule<unknown, ProviderUnavailable> })`.
  - `FastCast.layer` and `FastCast.layerTest` keep their types.
  - `ProviderUnavailable` has fields `{ reason: "Refused" | "Closed" | "Silent"; cause }` and no `league`.

- [ ] **Step 1: Write the new tests**

In `FastCast.test.ts`, inside `describe("FastCast", …)`, add the first two tests after
`"should keep one subscription pending at a time for a topic whose checkpoints keep failing"`:

```ts
  it.effect("should subscribe again every 30 s to a topic whose checkpoints keep failing", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      for (const mid of [1, 2, 3, 4, 5, 6]) {
        yield* Effect.sync(() => server.send(missingCheckpoint(mid)))
        yield* frames.until(numbered(mid))
        yield* TestClock.adjust("30 seconds")
        yield* server.sent.until(subscribed("event-football-nfl", mid + 1))
      }

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S"),
        7
      )
    })
  )

  it.effect(
    "should subscribe at once to a topic whose document is lost while its re-subscribe waits, and not again when the wait ends",
    () =>
      Effect.gen(function* () {
        const server = fakeServer()
        const { want } = yield* dueToBeFollowedAgain(server)

        yield* want([scoreboard, "AwaitingCheckpoint"])
        yield* server.sent.until(subscribed("event-football-nfl", 3))
        yield* TestClock.adjust("30 seconds")

        assert.lengthOf(
          server.sent.all().filter((frame) => frame.op === "S"),
          3,
          "the first gap's S, the second gap's at once, and none when the wait ends"
        )
      })
  )
```

Then add this test after `"should subscribe a topic whose checkpoint did not load again after 30 s, keeping the socket"`:

```ts
  it.effect("should not subscribe again to a topic left while its re-subscribe waited", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, want } = yield* twoGamesFollowed(server, Layer.empty)
      yield* missingCheckpointBesideOther(server)
      yield* frames.until(wholeAt(7))

      yield* want([scoreboard, "Synced"], [gameOf(secondGame), "Synced"])
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("29 seconds")

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S" && frame.tc === missingTopic),
        1
      )
    })
  )
```

- [ ] **Step 2: Run them against the old code**

Run: `pnpm vitest run apps/hub/src/provider/espn/FastCast.test.ts -t "every 30 s|lost while its re-subscribe|left while its re-subscribe"`
Expected:
- `every 30 s`: FAIL (times out). The old Schedule gives up after five tries.
- `lost while its re-subscribe waits`: FAIL (times out). The old code sends no S while a follow is pending.
- `left while`: may pass, because the old Leave interrupts the follow.

- [ ] **Step 3: Narrow `ProviderUnavailable`**

Replace the whole of `apps/hub/src/provider/espn/ProviderUnavailable.ts` with:

```ts
import { Schema } from "effect"

/** FastCast could not be followed: it refused, closed, or went silent. `FastCast` logs it and opens the socket again. */
export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()("ProviderUnavailable", {
  reason: Schema.Literals(["Refused", "Closed", "Silent"]),
  cause: Schema.Defect()
}) {}
```

- [ ] **Step 4: Rewrite `FastCast.ts`**

Replace the whole file with:

```ts
import {
  Channel,
  Context,
  type Duration,
  Effect,
  FiberMap,
  HashMap,
  Layer,
  Option,
  Queue,
  Ref,
  Result,
  Schedule,
  Schema,
  Sink,
  Stream
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import * as FastCastMessage from "./FastCastMessage.ts"
import { Frame } from "./Frame.ts"
import { ProviderUnavailable } from "./ProviderUnavailable.ts"
import { Topic, tcOf, topicOf } from "./Topic.ts"

/**
 * ESPN FastCast as the ESPN provider's push: one socket that subscribes to the topics it is told to follow, subscribes
 * to a topic again when told its document was lost or a while after its checkpoint fails, and opens again when it
 * closes, ends or goes quiet. Every socket text is a frame, each `H` followed by its checkpoint.
 */
export class FastCast extends Context.Service<
  FastCast,
  {
    /**
     * Every socket text and checkpoint, as frames, for as long as it runs, following what `wanted` last said. On each
     * socket it subscribes to every wanted topic, then to each topic that becomes wanted, and to each whose document goes
     * from synced back to waiting for its checkpoint. When the socket closes, ends or goes silent, it reconnects on its
     * backoff and reads `wanted` again. Fails only as a defect, once a reconnect that ends is done.
     */
    follow(wanted: Stream.Stream<Wanted>): Stream.Stream<Frame>
  }
>()("sportal/hub/provider/espn/FastCast") {
  /**
   * FastCast subscribing again to a topic whose checkpoint failed once `refollow` has passed, if it is still wanted,
   * and opening the socket again on `reconnect` after each failure, which it logs with its reason.
   */
  static readonly make = (retry: {
    readonly refollow: Duration.Input
    readonly reconnect: Schedule.Schedule<unknown, ProviderUnavailable>
  }) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<HttpClient.HttpClient | Socket.WebSocketConstructor>()
      const follow = (wanted: Stream.Stream<Wanted>) =>
        Stream.unwrap(connect(wanted, retry.refollow)).pipe(
          Stream.concat(
            Stream.fail(new ProviderUnavailable({ reason: "Closed", cause: "FastCast ended the stream" }))
          ),
          Stream.timeoutOrElse({ duration: silence, orElse: () => Stream.fail(silent()) }),
          Stream.tapError((error) =>
            Effect.logWarning(`FastCast: the live feed failed (${error.reason}); subscribing again`, error)
          ),
          Stream.retry(retry.reconnect),
          Stream.orDie,
          Stream.provideContext(context)
        )
      return FastCast.of({ follow })
    })

  /**
   * FastCast subscribing again to a topic whose checkpoint failed after 30 s; it opens the socket again after about 1
   * second, then twice as long each time, jittered, up to a minute, without end. `Stream.retry` resets that backoff once
   * the socket delivers again.
   */
  static readonly layer: Layer.Layer<FastCast, never, HttpClient.HttpClient | Socket.WebSocketConstructor> =
    Layer.effect(
      FastCast,
      FastCast.make({
        refollow: "30 seconds",
        reconnect: Schedule.min([
          Schedule.exponential("1 second").pipe(Schedule.jittered),
          Schedule.spaced("1 minute")
        ])
      })
    )

  /** FastCast as a test drives it: the frames `follow` gives for what it is told to follow. */
  static layerTest(follow: (wanted: Stream.Stream<Wanted>) => Stream.Stream<Frame>): Layer.Layer<FastCast> {
    return Layer.succeed(FastCast, FastCast.of({ follow }))
  }
}

/** The topics FastCast follows, each with whether its document is synced or waits for its checkpoint. */
export type Wanted = HashMap.HashMap<Topic, "Synced" | "AwaitingCheckpoint">

/** A topic's checkpoint was not read: it could not be loaded (unreachable, refused, timed out) or did not decode. */
export class CheckpointUnread extends Schema.TaggedError<CheckpointUnread>()("CheckpointUnread", {
  topic: Schema.String,
  reason: Schema.Literals(["Unloaded", "Undecodable"]),
  cause: Schema.Defect()
}) {}

/**
 * Opens the socket, then subscribes as `wanted` says, returning the frames that follow, the handshake's first. A topic
 * whose checkpoint fails is subscribed to again once `refollow` has passed, if it is still wanted; one wait per topic.
 */
const connect = Effect.fnUntraced(function* (wanted: Stream.Stream<Wanted>, refollow: Duration.Input) {
  const host = yield* websocketHost
  const outgoing = yield* Queue.unbounded<string>()
  yield* Queue.offer(outgoing, JSON.stringify({ op: "C" }))
  const socket = yield* Socket.makeWebSocket(
    `wss://${host.ip}:${host.securePort}/FastcastService/pubsub/profiles/12000?TrafficManager-Token=${encodeURIComponent(host.token)}`
  )
  const [first, rest] = yield* Channel.fromQueueArray(outgoing).pipe(
    Channel.pipeTo(Socket.toChannelString(socket)),
    Stream.fromChannel,
    Stream.mapError((cause) => new ProviderUnavailable({ reason: "Closed", cause })),
    // One text per chunk, so peeling the first leaves the rest of its batch in the stream.
    Stream.rechunk(1),
    Stream.peel(Sink.head()),
    Effect.timeoutOrElse({ duration: silence, orElse: () => Effect.fail(silent()) })
  )
  const opened = yield* Effect.fromOption(
    first,
    () => new ProviderUnavailable({ reason: "Closed", cause: "FastCast closed before connecting" })
  )
  const sid = yield* Option.match(decodeEnvelope(opened), {
    onNone: () =>
      Effect.fail(
        new ProviderUnavailable({ reason: "Refused", cause: "FastCast opened with an unknown op" })
      ),
    onSome: ({ message }) =>
      message.op === "C"
        ? Effect.succeed(message.sid)
        : Effect.fail(
            new ProviderUnavailable({ reason: "Refused", cause: `FastCast opened with ${message.op}` })
          )
  })

  const current = yield* Ref.make<Wanted>(HashMap.empty())
  const pending = yield* FiberMap.make<Topic>()
  const subscribeTo = (topic: Topic) => Queue.offer(outgoing, JSON.stringify({ op: "S", sid, tc: tcOf(topic) }))
  const subscribeNow = (topic: Topic) => FiberMap.remove(pending, topic).pipe(Effect.andThen(subscribeTo(topic)))
  const resubscribeLater = (topic: Topic) =>
    FiberMap.run(
      pending,
      topic,
      Effect.sleep(refollow).pipe(
        Effect.andThen(Ref.get(current)),
        Effect.flatMap((wantedNow) => (HashMap.has(wantedNow, topic) ? subscribeTo(topic) : Effect.void))
      ),
      { onlyIfMissing: true }
    )

  yield* Effect.logInfo(`FastCast: connected to ${host.ip}`)

  // From nothing on this socket to what is wanted, then each change after.
  yield* wanted.pipe(
    Stream.runForEach((next) =>
      Ref.getAndSet(current, next).pipe(
        Effect.flatMap((previous) => Effect.forEach(toSubscribe(previous, next), subscribeNow, { discard: true }))
      )
    ),
    Effect.forkScoped
  )

  // Up to four at once, so a reconnect's checkpoints load side by side; frames still leave in the texts' order.
  return Stream.concat(Stream.make(opened), rest).pipe(
    Stream.mapEffect((text) => framed(text, resubscribeLater), { concurrency: 4 }),
    Stream.flattenIterable
  )
})

/**
 * The topics to subscribe to as what is wanted goes from `previous` to `next`: each newly wanted, and each whose
 * document went from synced back to waiting for its checkpoint.
 */
function toSubscribe(previous: Wanted, next: Wanted): ReadonlyArray<Topic> {
  return [...HashMap.entries(next)].flatMap(([topic, document]) => {
    const had = HashMap.get(previous, topic)
    return Option.isNone(had) || (document === "AwaitingCheckpoint" && had.value === "Synced") ? [topic] : []
  })
}

/**
 * A socket text as its frame, an `H`'s followed by its checkpoint once it loads and decodes. An `H` whose topic has
 * no name FastCast reads loads nothing. A checkpoint that fails is logged, its topic is given to `resubscribeLater`,
 * and only its `H` is framed.
 */
const framed = Effect.fnUntraced(function* (
  text: string,
  resubscribeLater: (topic: Topic) => Effect.Effect<unknown>
) {
  const envelope = Option.getOrUndefined(decodeEnvelope(text))
  const topic = Option.fromUndefinedOr(envelope?.channel).pipe(Option.flatMap(topicOf))
  const frame = Frame.Pushed({ topic, mid: Option.fromUndefinedOr(envelope?.mid), body: text })
  if (envelope === undefined) {
    yield* Effect.logDebug("FastCast: framed a text of an unknown op", text)
    return [frame]
  }
  const { message } = envelope
  if (message.op !== "H" || Option.isNone(topic)) return [frame]

  const loaded = yield* checkpoint(topic.value, message.pl).pipe(Effect.result)
  if (Result.isSuccess(loaded)) {
    return [frame, Frame.Checkpoint({ topic: topic.value, mid: message.mid, document: loaded.success })]
  }

  const error = loaded.failure
  yield* Effect.logWarning(
    `FastCast: the checkpoint of ${message.tc} at ${message.mid} failed; subscribing to it again later`,
    error.cause
  ).pipe(Effect.annotateLogs({ topic: message.tc, reason: error.reason }))
  yield* resubscribeLater(topic.value)
  return [frame]
})

/** The document of the checkpoint at `url`, decoded as `topic`'s checkpoint. */
function checkpoint(topic: Topic, url: string) {
  const tc = tcOf(topic)
  return HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.timeout(checkpointTimeout),
    Effect.mapError((cause) => new CheckpointUnread({ topic: tc, reason: "Unloaded", cause })),
    Effect.flatMap((body) =>
      Schema.decodeEffect(FastCastMessage.Checkpoint(topic))(body).pipe(
        Effect.mapError((cause) => new CheckpointUnread({ topic: tc, reason: "Undecodable", cause }))
      )
    )
  )
}

// Well inside `silence`, so a checkpoint that hangs fails its topic rather than the whole socket.
const checkpointTimeout = "20 seconds"

const decodeEnvelope = Schema.decodeUnknownOption(FastCastMessage.Envelope)

// FastCast sends `B` itself after 10 s without another frame (it answers a client's `B` with an error, so the client
// never sends one); live, a subscribed socket went at most 20 s between frames.
const silence = "45 seconds"

function silent(): ProviderUnavailable {
  return new ProviderUnavailable({ reason: "Silent", cause: `No FastCast message for ${silence}` })
}

const websocketHost = HttpClient.get("https://fastcast.semfs.engsvc.go.com/public/websockethost").pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.flatMap(HttpClientResponse.schemaBodyJson(FastCastMessage.Host)),
  Effect.mapError((cause) => new ProviderUnavailable({ reason: "Refused", cause }))
)
```

If `typecheck` rejects an Effect API used here (`Stream.orDie`, `FiberMap.remove`, `Ref.getAndSet`, `Effect.result`),
look it up in `node_modules/effect/dist/<Module>.d.ts` and use the Effect 4 spelling. Do not fall back to imperative
code.

- [ ] **Step 5: Update the rest of `FastCast.test.ts`**

Delete these tests. Each checked only a metric, or behaviour that is gone:
- `"should log that the live feed stopped and stay quiet once its reconnect is done"`
- `"should time a checkpoint it loads"`
- `"should count each socket text by its op and its topic's league"`
- `"should count a socket text of an unknown op as unknown"`
- `"should gauge one game topic followed once one is wanted"`
- `"should gauge no game topic followed, and count the leave, once none is wanted"`
- `"should count a topic followed again once its document goes back to waiting for its checkpoint"`
- `"should send no second S for a topic whose document is lost again while its follow waits to retry"`
- `"should follow a topic whose document was lost again while its follow waited only once more"`
- `"should leave a topic to polling once the Schedule is done, saying so once, and not subscribe it again until the socket reconnects"`
- `"should follow a topic left to polling again once the socket reconnects"`

Edit these tests:
- `"should count a failed live feed by its reason"`:
  - Rename it to `"should warn of a failed live feed with its reason"`.
  - Delete the `const failures = yield* counted(…)` line and `assert.strictEqual(failures, 1)`.
  - Change `}).pipe(withMetrics)` to `})`.
- `"should keep running when the socket goes silent"`:
  - Delete the `const silences = …` line and `assert.strictEqual(silences, 1)`.
  - Change `}).pipe(withMetrics)` to `})`.
- `"should leave a topic no longer wanted, saying so"`:
  - Rename it to `"should send nothing for a topic no longer wanted"`.
  - Drop `recordingLogs`, so it starts `const server = fakeServer()` and `nflFrames(server)` has no `.pipe(Effect.provide(layer))`.
  - Delete the `assert.isTrue(logs.some(… left …))` assertion.
- `"should keep the socket and the other topics when a checkpoint does not load, counting it and warning of it"`:
  - Rename it to `"should keep the socket and the other topics when a checkpoint does not load, warning of it"`.
  - Delete the `const failures = …` line and `assert.strictEqual(failures, 1)`.
  - Change `}).pipe(withMetrics)` to `})`.
- `"should fail a checkpoint that hangs for 20 s as Unloaded, counting it and warning of it"`:
  - Rename it to `"should fail a checkpoint that hangs for 20 s as Unloaded, warning of it"`.
  - Delete the `failures` line and its assert.
  - Change `}).pipe(withMetrics)` to `})`.
- `"should not follow a topic whose checkpoint hung again before the Schedule says"`: rename it to
  `"should not subscribe again to a topic whose checkpoint hung before 30 s"`.
- `"should follow a topic whose checkpoint hung again when the Schedule says, keeping the socket"`: rename it to
  `"should subscribe again to a topic whose checkpoint hung after 30 s, keeping the socket"`.
- `"should emit only the H of a checkpoint that does not decode, counting it as Undecodable"`:
  - Rename it to `"should emit only the H of a checkpoint that does not decode, warning of it as Undecodable"`.
  - Delete the `failures` line and its assert.
  - Change `}).pipe(withMetrics)` to `})`.

Simplify the helpers, since no test passes its own retry any more:

```ts
/**
 * Runs FastCast's frames over `server` in a fiber of its own, told to follow the NFL's scoreboard until `want` says
 * otherwise, collecting them into `frames` and completing `ended` if they ever end.
 */
function nflFrames(server: ReturnType<typeof fakeServer>) {
  return framesOver(fastCastHost(server))
}

/**
 * Runs FastCast's frames over `host` in a fiber of its own, told to follow the NFL's scoreboard until `want` says
 * otherwise, collecting them into `frames` and completing `ended` if they ever end.
 */
function framesOver(host: Layer.Layer<HttpClient.HttpClient | Socket.WebSocketConstructor>) {
  return Effect.gen(function* () {
    const ended = yield* Deferred.make<void>()
    const frames = watched<Frame>()
    const wanted = yield* SubscriptionRef.make(wantedOf([scoreboard, "AwaitingCheckpoint"]))
    const running = yield* FastCast

    yield* running.follow(SubscriptionRef.changes(wanted)).pipe(
      Stream.runForEach((frame) => Effect.sync(() => frames.add(frame))),
      Deferred.into(ended),
      Effect.forkChild({ startImmediately: true })
    )
    const want = (...entries: ReadonlyArray<readonly [Topic, HashMap.HashMap.Value<Wanted>]>) =>
      SubscriptionRef.set(wanted, wantedOf(...entries))
    return { ended, frames, want }
  }).pipe(Effect.provide(FastCast.layer.pipe(Layer.provide(host))))
}
```

Imports: drop `counted`, `gauged`, `observed` and `withMetrics` (keep `recordingLogs`), and drop `Schedule` from
`effect`.

- [ ] **Step 6: Run the tests and checks**

Run: `pnpm vitest run apps/hub/src/provider/espn`
Expected: all PASS, including the three new tests and the `FastCast reconnect` suite.

Run: `pnpm exec biome check apps/hub && pnpm typecheck`
Expected: no errors.

Run: `grep -n "Metric\|Effect.fn(\"" apps/hub/src/provider/espn/FastCast.ts apps/hub/src/provider/espn/EspnProvider.ts`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add apps/hub/src/provider/espn/FastCast.ts apps/hub/src/provider/espn/FastCast.test.ts apps/hub/src/provider/espn/ProviderUnavailable.ts
git commit -m "refactor: FastCast with no telemetry; a failed checkpoint subscribes again after 30 s while wanted

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Dashboard, technical spec, and glossary follow

**Files:**
- Modify: `telemetry/dashboards/hub.json`
- Modify: `docs/technical-spec.md:339-340,377,382`
- Modify: `CONTEXT.md:47,54,57`

**Interfaces:**
- Consumes: the metric names removed in Tasks 1–2.
- Produces: nothing code depends on.

- [ ] **Step 1: Remove the dashboard panels**

Run this from the repo root. It removes the panels by id and moves the rest up into the gaps. The ids come from the
current file:
- 13 Connected, 30 Game topics followed, 31 Push messages / min, 32 Polls / 15 min, 33 Feed failures in range and
  34 Provider errors in range
- 35 Messages by op, 36 Patches by league, 37 Topics followed and steers, 38 Checkpoint duration and 15 Feed errors by
  reason
- 3 Poll duration, 4 Provider errors by league and 5 Poll traces

```bash
node -e '
const fs = require("fs")
const path = "telemetry/dashboards/hub.json"
const dashboard = JSON.parse(fs.readFileSync(path, "utf8"))
const gone = new Set([13, 30, 31, 32, 33, 34, 35, 36, 37, 38, 15, 3, 4, 5])
const place = { 27: [0, 0, 24], 50: [0, 10, 24], 51: [0, 11, 16], 52: [16, 11, 8], 12: [0, 21, 24], 17: [0, 22, 24], 40: [0, 32, 24], 53: [0, 33, 24], 41: [0, 41, 24], 42: [0, 49, 24] }
dashboard.panels = dashboard.panels.filter((panel) => !gone.has(panel.id))
for (const panel of dashboard.panels) {
  const [x, y, w] = place[panel.id] ?? []
  if (y === undefined) throw new Error(`no place for panel ${panel.id}`)
  Object.assign(panel.gridPos, { x, y, w })
}
fs.writeFileSync(path, JSON.stringify(dashboard, null, 2) + "\n")
'
```

Then check:

Run: `grep -c "sportal_live_feed\|sportal_checkpoint_duration\|sportal_poll_duration\|sportal_provider_errors\|EspnProvider.poll" telemetry/dashboards/hub.json`
Expected: `0`

Run: `git diff --stat telemetry/dashboards/hub.json` and look over the diff. Only whole panels should be removed and
`gridPos` values changed. If the original file was not 2-space JSON with a trailing newline, match its formatting
instead.

- [ ] **Step 2: Update `docs/technical-spec.md`**

Replace line 339 (it starts `- A FastCast topic that loses its document`) with:

```markdown
- A FastCast topic that loses its document (a missed message, a patch that will not apply) is a Warning log from `EspnState`, and the push follows the topic again from its checkpoint. A checkpoint that does not load or decode is a Warning log, and FastCast subscribes to its topic again after 30 s while it is still wanted.
```

Delete line 340 (`- Each checkpoint's load and decode is timed (`sportal_checkpoint_duration`).`).

In the failure table, replace the `Provider unreachable or refused` row with:

```markdown
| Provider unreachable or refused | Logged as a Warning, annotated with its league; the slate keeps each game's last snapshot; that league is polled again within 30 s |
```

Replace the `Live feed refused, closed, silent, or out of step` row with:

```markdown
| Live feed refused, closed, silent, or out of step | Logged as a Warning with its reason; resubscribed from a checkpoint with backoff from 1 s to 1 min; the poll carries on, so games go on updating at the poll's pace |
```

- [ ] **Step 3: Update `CONTEXT.md`**

Replace the **Provider unavailable** row (line 47) with:

```markdown
| **Provider unavailable** | FastCast could not be followed: it refused, closed, or went silent; `ProviderUnavailable` in code, in `espn/`. Logged with its reason, and the socket opens again on its backoff; the poll goes on. | provider error, live feed error |
```

Replace the **Wanted topics** row (line 54) with:

```markdown
| **Wanted topics** | What the live feed is told to follow: each league's scoreboard topic and the topic of each listed game live or within 30 minutes of kickoff, each with whether its document is synced or waits for its checkpoint; `Wanted` in code, beside `FastCast`, which `EspnState#wanted` gives. FastCast subscribes to each newly wanted topic and each whose document goes from synced back to waiting; a topic no longer wanted is not subscribed to again. | subscriptions, follows |
```

Replace the **Checkpoint unread** row (line 57) with:

```markdown
| **Checkpoint unread** | A live feed topic's checkpoint could not be loaded or did not decode; logged, and FastCast subscribes to the topic again after 30 s while it is still wanted; `CheckpointUnread` in code. | checkpoint error |
```

- [ ] **Step 4: Run the full check**

Run: `pnpm check`
Expected: biome, typecheck, structure and tests all pass.

Run: `grep -rn "sportal_live_feed\|sportal_checkpoint_duration\|sportal_poll_duration\|sportal_provider_errors\|left to polling" --exclude-dir=node_modules --exclude-dir=.git . | grep -v "^./docs/\(adr\|plans\|specs\)/"`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add telemetry/dashboards/hub.json docs/technical-spec.md CONTEXT.md
git commit -m "docs: dashboard, technical spec and glossary drop the ESPN provider's metrics

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Eye-check the dashboard (user)**

With `pnpm telemetry` running, the user opens the Hub dashboard at `localhost:3000`. It should show:
- the Games table at the top
- Plays
- Live feed, with only the FastCast logs
- Poll, with "Pushes behind their listing by league" full width, then the Provider logs
- the Hub row

There should be no empty panels.
