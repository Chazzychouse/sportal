# Hub Simplify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ESPN one fold of its frames (`EspnState`), make FastCast a socket that follows a wanted set, type
frames and topics once at the edge, and have `Slate.take` say what it changed.

**Architecture:**
- `Frame` and `Topic` become `Data.taggedEnum`s.
- `EspnState`, a `Data.Class`, holds the FastCast documents and each league's listed games. `EspnProvider` keeps
  it in a `SubscriptionRef` and folds every polled and pushed frame into it once. Deliveries, the polling
  schedule, and the set of topics FastCast should follow are all read from that one state.
- `FastCast.follow(wanted)` reconciles toward that wanted set, with one `Deferred` per checkpoint in flight.
- `Slate.take` returns `[Slate, SlateChange[]]`, so the Director stops diffing two slates.

**Tech Stack:** TypeScript 7, Effect 4 (`Data`, `HashMap`, `HashSet`, `SubscriptionRef`, `FiberMap`, `Deferred`,
`Stream`, `Schedule`), `@effect/vitest`.

**Spec:** `docs/specs/2026-10-09-hub-simplify-design.md`. Read its "Amendments while planning" section: the plan
follows the amended spec.

## Global Constraints

- Read `AGENTS.md` first. Effect 4 is newer than training data: check `node_modules/effect/ai-docs/src/` and
  `apps/hub/node_modules/effect/dist/*.d.ts` before using an API this plan does not spell out.
- Every exported type name is a `CONTEXT.md` term. New terms get their row in the same commit. Task 5 holds the
  wording; a task that adds an exported type adds its row then.
- One behaviour per test, `it("should …")`, Arrange/Act/Assert separated by blank lines, no `// Arrange` comments.
- Rewriting a test keeps every assertion it had, unless the behaviour it asserts was removed. The commit body
  lists, per rewritten file, each old test name and the new test names that carry its assertions, or the removed
  behaviour it went with.
- No `any`, no casts outside decoding, no non-null assertions, no `_tag ===` (use `X.$is` / `X.$match`). Time comes
  from `DateTime.now` / `Clock`.
- Metric ids never change: `sportal_live_feed_*`, `sportal_checkpoint_duration`, `sportal_poll_duration`,
  `sportal_provider_errors` and `sportal_game_state` keep their names and attributes.
- `pnpm check` must pass before every commit (the push hook runs it).
- Work in a worktree on branch `hub-simplify`, created from `main`:
  `git worktree add ../sportal-hub-simplify -b hub-simplify main`, then `pnpm install` there.

## File map

| File | After this plan |
|---|---|
| `apps/hub/src/provider/espn/Topic.ts` (new, replaces `FastCastTopic.ts`) | `Topic` (`Scoreboard` / `Game`), `tcOf`, `topicOf` |
| `apps/hub/src/provider/espn/Frame.ts` | `Frame` (`Polled` / `Pushed` / `Checkpoint`), a `Data.taggedEnum` |
| `apps/hub/src/provider/espn/FastCastDocument.ts` | Documents keyed by `Topic` in a `HashMap`; `Document` state; `advance`, `isSynced` |
| `apps/hub/src/provider/espn/EspnState.ts` (new) | The one fold: `take`, `games`, `wanted` |
| `apps/hub/src/provider/espn/EspnDecoder.ts` | Only `byLeague`, `gamesOf`, `playsOf` |
| `apps/hub/src/provider/espn/EspnProvider.ts` | Polls fold into the state; polling reads it; pushes fold into it; derives `wanted` |
| `apps/hub/src/provider/espn/FastCast.ts` | `follow(wanted)`, reconciling; no decode, no steering fold |
| `apps/hub/src/slate/Slate.ts` | `take` returns its `SlateChange`s |
| `apps/hub/src/Director.ts` | Reads the changes; no diffing |

---

### Task 1: Typed topics and frames

Behaviour does not change. Every `Owner` becomes `Topic`, every topic string is parsed once, and `Frame` becomes a
tagged enum without `receivedAt`, which nothing ever read.

**Files:**
- Create: `apps/hub/src/provider/espn/Topic.ts`, `apps/hub/src/provider/espn/Topic.test.ts`
- Delete: `apps/hub/src/provider/espn/FastCastTopic.ts`, `apps/hub/src/provider/espn/FastCastTopic.test.ts`
- Modify: `apps/hub/src/provider/espn/Frame.ts`, `FastCastDocument.ts`, `FastCastMessage.ts`, `FastCast.ts`,
  `EspnDecoder.ts`, `EspnProvider.ts`, `TestEspn.ts`
- Test: `FastCast.test.ts`, `EspnDecoder.test.ts`, `EspnProvider.test.ts`

**Interfaces:**
- Produces:
  - `type Topic = Scoreboard{league} | Game{league, game}`, `const Topic`
  - `tcOf(topic: Topic): string`, `topicOf(tc: string): Option<Topic>`
  - `type Frame = Polled{league, body} | Pushed{topic: Option<Topic>, mid: Option<number>, body} | Checkpoint{topic, mid: number, body}`, `const Frame`
  - `FastCastDocument.advance(documents, frame: Frame)`, with documents a `HashMap<Topic, Document>`
  - `FastCastDocument.Change.Reset { topic: Topic, detail }`
  - `FastCastDocument.scoreboard(documents, topic: Topic)`
  - `FastCastMessage.Checkpoint(topic: Topic)`

- [ ] **Step 1: Write `Topic.test.ts`** (the old `FastCastTopic.test.ts` cases, renamed)

```ts
import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { Option } from "effect"
import { Topic, tcOf, topicOf } from "./Topic.ts"

describe("Topic.tcOf", () => {
  it.each([
    ["nfl", "event-football-nfl"],
    ["fbs", "event-football-college-football"]
  ] as const)("should name the %s scoreboard's topic", (league, expected) => {
    const tc = tcOf(Topic.Scoreboard({ league }))

    assert.strictEqual(tc, expected)
  })

  it.each([
    ["nfl", "401872971", "gp-football-nfl-401872971"],
    ["fbs", "401862787", "gp-football-college-football-401862787"]
  ] as const)(
    "should name %s game %s's package topic after its league's scoreboard topic",
    (league, game, expected) => {
      const tc = tcOf(Topic.Game({ league, game: GameId.make(game) }))

      assert.strictEqual(tc, expected)
    }
  )
})

describe("Topic.topicOf", () => {
  it("should read a scoreboard topic as its league's scoreboard", () => {
    const topic = topicOf("event-football-nfl")

    assert.deepStrictEqual(topic, Option.some(Topic.Scoreboard({ league: "nfl" })))
  })

  it("should read a package topic as its game", () => {
    const topic = topicOf("gp-football-college-football-401862787")

    assert.deepStrictEqual(topic, Option.some(Topic.Game({ league: "fbs", game: GameId.make("401862787") })))
  })

  it.each([
    ["a package topic without a game", "gp-football-nfl-"],
    ["another sport's scoreboard topic", "event-basketball-nba"]
  ])("should read no topic from %s", (_name, tc) => {
    const topic = topicOf(tc)

    assert.isTrue(Option.isNone(topic))
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/Topic.test.ts`
Expected: FAIL, `Cannot find module './Topic.ts'`.

- [ ] **Step 3: Write `Topic.ts`, then delete `FastCastTopic.ts` and its test**

```ts
import { GameId } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Array as Arr, Data, Option } from "effect"

/** What a FastCast topic carries: one league's scoreboard, or one game's package. */
export type Topic = Data.TaggedEnum<{
  Scoreboard: { readonly league: LeagueId }
  Game: { readonly league: LeagueId; readonly game: GameId }
}>
export const Topic = Data.taggedEnum<Topic>()

/**
 * `topic` as FastCast's `tc` names it. A college game's topic is assumed to follow its scoreboard's, unverified until a
 * live college day.
 */
export function tcOf(topic: Topic): string {
  const sport = topic.league === "nfl" ? "football-nfl" : "football-college-football"
  return Topic.$match(topic, {
    Scoreboard: () => `event-${sport}`,
    Game: ({ game }) => `gp-${sport}-${game}`
  })
}

/** The topic FastCast's `tc` names, when it is a scoreboard's or a game's. */
export function topicOf(tc: string): Option.Option<Topic> {
  return Arr.findFirst(LeagueId.literals, (league) => {
    const gamePrefix = tcOf(Topic.Game({ league, game: GameId.make("") }))
    return tc === tcOf(Topic.Scoreboard({ league }))
      ? Option.some(Topic.Scoreboard({ league }))
      : tc.startsWith(gamePrefix) && tc.length > gamePrefix.length
        ? Option.some(Topic.Game({ league, game: GameId.make(tc.slice(gamePrefix.length)) }))
        : Option.none()
  })
}
```

Run: `git rm apps/hub/src/provider/espn/FastCastTopic.ts apps/hub/src/provider/espn/FastCastTopic.test.ts`

- [ ] **Step 4: Replace `Frame.ts`**

```ts
import type { LeagueId } from "@sportal/domain/League"
import { Data, type Option } from "effect"
import type { Topic } from "./Topic.ts"

/** One thing ESPN delivered, as received, before its decode reads it. */
export type Frame = Data.TaggedEnum<{
  /** A poll's response: `league`'s whole site scoreboard. */
  Polled: { readonly league: LeagueId; readonly body: string }
  /** A socket text: a change to its topic's document, or any other op; no topic or mid when the text names none. */
  Pushed: {
    readonly topic: Option.Option<Topic>
    readonly mid: Option.Option<number>
    readonly body: string
  }
  /** The checkpoint an `H` pointed to: `topic`'s whole document as of `mid`. */
  Checkpoint: { readonly topic: Topic; readonly mid: number; readonly body: string }
}>
export const Frame = Data.taggedEnum<Frame>()
```

- [ ] **Step 5: `FastCastMessage.ts` reads a checkpoint by its `Topic`**

Replace `import { Owner } from "./FastCastTopic.ts"` with `import { Topic } from "./Topic.ts"`. Then replace the
`Checkpoint` function:

```ts
/** The checkpoint body of `topic`, read by its schema: a scoreboard's events, or a game's plays. */
export function Checkpoint(topic: Topic) {
  return Topic.$match(topic, {
    Scoreboard: () => Schema.fromJsonString(ScoreboardCheckpoint),
    Game: () => Schema.fromJsonString(GameCheckpoint)
  })
}
```

- [ ] **Step 6: `FastCastDocument.ts` keys documents by `Topic` and reads typed frames**

Make these edits, keeping every helper the list doesn't name.

1. Change the imports:
   ```ts
   import type { GameId } from "@sportal/domain/Game"
   import type { LeagueId } from "@sportal/domain/League"
   import { Array as Arr, Data, Effect, HashMap, JsonPatch, JsonPointer, Option, Record, Result, Schema } from "effect"
   import * as FastCastMessage from "./FastCastMessage.ts"
   import { Frame } from "./Frame.ts"
   import { Topic } from "./Topic.ts"
   ```
2. Replace `advance`. Its doc comment stays, with "frame" for "frame" and no word about channels.
   ```ts
   export const advance = Effect.fnUntraced(function* (
     documents: Documents,
     frame: Frame
   ): Effect.fn.Return<Advanced, Schema.SchemaError> {
     return yield* Frame.$match(frame, {
       Polled: () => Effect.succeed(unchanged(documents)),
       Checkpoint: (checkpointed) => synced(documents, checkpointed),
       Pushed: (pushed) => moveOn(documents, pushed)
     })
   })
   ```
3. `export const empty: Documents = HashMap.empty()`.
4. Replace `scoreboard`:
   ```ts
   export function scoreboard(
     documents: Documents,
     topic: Topic
   ): Option.Option<{ readonly league: LeagueId; readonly events: ReadonlyArray<Schema.Json> }> {
     return Topic.$match(topic, {
       Scoreboard: ({ league }) =>
         HashMap.get(documents, topic).pipe(
           Option.filter(Document.$is("Synced")),
           Option.map(({ document }) => ({ league, events: Record.values(objectAt(document, [])) }))
         ),
       Game: () => Option.none()
     })
   }
   ```
5. Rename the private `type Topic` / `const Topic` (the `AwaitingCheckpoint | Synced` state) to `Document`, and
   rename every use. Its doc comment reads: "Where one topic's document is: …".
6. `type Documents = HashMap.HashMap<Topic, Document>`.
7. `Change.Reset` becomes `Reset: { readonly topic: Topic; readonly detail: string }`.
8. Replace `synced`, `moveOn` and `checkpoint`. `decodeMid` and `withTopic` go.
   ```ts
   const synced = Effect.fnUntraced(function* (
     documents: Documents,
     frame: Extract<Frame, { readonly _tag: "Checkpoint" }>
   ): Effect.fn.Return<Advanced> {
     const loaded = yield* checkpoint(frame).pipe(Effect.result)
     if (Result.isFailure(loaded)) {
       return unchanged(HashMap.set(documents, frame.topic, Document.AwaitingCheckpoint()))
     }

     const document = loaded.success
     return {
       documents: HashMap.set(documents, frame.topic, Document.Synced({ mid: frame.mid, document })),
       change: Option.some(changeOf(frame.topic, document, Option.none()))
     }
   })

   const moveOn = Effect.fnUntraced(function* (
     documents: Documents,
     frame: Extract<Frame, { readonly _tag: "Pushed" }>
   ): Effect.fn.Return<Advanced, Schema.SchemaError> {
     const decoded = yield* decodeMessage(frame.body).pipe(Effect.result)
     if (Result.isFailure(decoded)) return yield* undecoded(documents, frame, decoded.failure)

     const message = decoded.success
     if (Option.isNone(frame.topic) || !movesOn(message)) return unchanged(documents)

     return yield* moved(documents, frame.topic.value, message)
   })

   const checkpoint = Effect.fnUntraced(function* (frame: Extract<Frame, { readonly _tag: "Checkpoint" }>) {
     const body = yield* Schema.decodeEffect(FastCastMessage.Checkpoint(frame.topic))(frame.body)

     const document: Schema.Json =
       "sports" in body
         ? Object.fromEntries(
             body.sports.flatMap((sport) =>
               sport.leagues.flatMap((league) => league.events.map((event) => [event.uid, event] as const))
             )
           )
         : JsonPatch.apply([{ op: "add", path: gamePlays.pointer, value: body.entities?.plays ?? {} }], {
             entities: {}
           })
     return document
   })
   ```
9. In `changeOf`, `moved`, `relevant`, `patched` and `reset`, the parameter `owner: Owner` becomes `topic: Topic`, and
   `tc: string` becomes `topic: Topic`.
   - `Owner.$match(owner, …)` becomes `Topic.$match(topic, …)`, and `Owner.$is("Scoreboard")(owner)` becomes
     `Topic.$is("Scoreboard")(topic)`.
   - In `moved`, `documents.get(tc) ?? Topic.AwaitingCheckpoint()` becomes
     `Option.getOrElse(HashMap.get(documents, topic), () => Document.AwaitingCheckpoint())`. Every
     `withTopic(documents, tc, X)` becomes `HashMap.set(documents, topic, X)`.
   - `moved(documents, tc, owner, message)` loses its `tc` parameter: `moved(documents, topic, message)`.
10. Replace `undecoded`:
   ```ts
   function undecoded(
     documents: Documents,
     frame: Extract<Frame, { readonly _tag: "Pushed" }>,
     error: Schema.SchemaError
   ): Effect.Effect<Advanced, Schema.SchemaError> {
     return Option.match(decodeKnownOp(frame.body), {
       onNone: () => Effect.succeed(unchanged(documents)),
       onSome: (known) =>
         Option.match(frame.topic, {
           onNone: () => Effect.fail(error),
           onSome: (topic) =>
             movesOn(known) && Option.exists(HashMap.get(documents, topic), Document.$is("Synced"))
               ? Effect.succeed(
                   reset(
                     documents,
                     topic,
                     `message ${Option.getOrUndefined(frame.mid)} does not decode: ${error.message}`
                   )
                 )
               : Effect.fail(error)
         })
     })
   }
   ```

- [ ] **Step 7: `EspnDecoder.ts` reads typed frames**

Replace `decode`, `listed` and the log annotations. `decodeLeague` goes.

```ts
export function decode(frames: Stream.Stream<Frame>): Stream.Stream<ReadonlyArray<Delivery>> {
  return frames.pipe(
    Stream.mapAccumEffect(
      (): State => ({ listings: HashMap.empty(), documents: FastCastDocument.empty }),
      (state, frame) =>
        Frame.$match(frame, {
          Polled: ({ league, body }) => listed(state, league, body),
          Pushed: () => pushed(state, frame),
          Checkpoint: () => pushed(state, frame)
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("EspnDecoder: skipped a frame that does not decode", cause).pipe(
              Effect.annotateLogs(annotationsOf(frame)),
              Effect.as([state, noDeliveries] as const)
            )
          ),
          Effect.map(([next, decoded]) => [next, [decoded]] as const)
        )
    )
  )
}
```

```ts
const listed = Effect.fnUntraced(function* (state: State, league: LeagueId, body: string) {
  const scoreboard = yield* byLeague[league].decodeScoreboard(body)
  const games = yield* gamesOf(league, scoreboard.events)

  const next: State = { ...state, listings: HashMap.set(state.listings, league, games) }
  return [next, [Delivery.cases.Listing.make({ league, games })]] as const
})
```

Put this right after `decode`'s helpers, in first-use order:

```ts
/** What a log of `frame` is annotated with: its kind, and its league or its topic's name. */
function annotationsOf(frame: Frame): Readonly<Record<string, string>> {
  return Frame.$match(frame, {
    Polled: ({ league }) => ({ frame: "Polled", league }),
    Pushed: ({ topic }) => ({ frame: "Pushed", ...Record.getSomes({ topic: Option.map(topic, tcOf) }) }),
    Checkpoint: ({ topic }) => ({ frame: "Checkpoint", topic: tcOf(topic) })
  })
}
```

Imports: `import { Frame } from "./Frame.ts"` (now a value import) and `import { tcOf } from "./Topic.ts"`. Drop the
`LeagueId` value import if nothing else needs it; `import type { LeagueId }` stays for `listed`.

- [ ] **Step 8: `EspnProvider.ts` frames a poll as `Polled`**

In `poll`:

```ts
const poll = Effect.fn("EspnProvider.poll")(
  function* (league: LeagueId) {
    yield* Effect.annotateCurrentSpan("sportal.league", league)
    const response = yield* client.get(scoreboardUrl(league))
    const body = yield* response.text

    return Frame.Polled({ league, body })
  },
  (effect, league) => /* unchanged */
)
```

The `Frame` import stays a value import. `Polled.frame` keeps its type, `Option.Option<Frame>`.

- [ ] **Step 9: `FastCast.ts` frames typed frames**

Make these edits:

1. Imports: replace `import { ownerOf, topicOf } from "./FastCastTopic.ts"` with
   `import { Topic, tcOf, topicOf } from "./Topic.ts"`. `DateTime` stays (`steered` reads `DateTime.now`).
2. In `connect`: `const topics = leagues.map((league) => tcOf(Topic.Scoreboard({ league })))`.
3. Socket texts carry no `receivedAt`. Delete the
   `Stream.mapEffect((text) => Effect.map(DateTime.now, (receivedAt) => ({ text, receivedAt })))` line.
   - `opened` is now the first text, a `string`, so `decodeEnvelope(opened.text)` becomes `decodeEnvelope(opened)`.
   - The returned stream's first step becomes
     `Stream.mapEffect((text) => framed(text, (outcome) => PubSub.publish(outcomes, outcome)))`.
4. In `steered`, the scoreboard of a frame's topic:
   ```ts
   const shown = Option.flatMap(advanced.change, () =>
     Option.flatMap(topicOfFrame(frame), (topic) => FastCastDocument.scoreboard(advanced.documents, topic))
   )
   ```
   The reset filter becomes `Option.filter(({ topic }) => [...scoreboards, ...followed].includes(tcOf(topic)))`. Its
   steer becomes `Steer.FollowAgain({ tc: tcOf(topic), detail })`. Add, below `steered`:
   ```ts
   /** The topic a frame is on: none for a poll, or for a socket text that names none. */
   function topicOfFrame(frame: Frame): Option.Option<Topic> {
     return Frame.$match(frame, {
       Polled: () => Option.none(),
       Pushed: ({ topic }) => topic,
       Checkpoint: ({ topic }) => Option.some(topic)
     })
   }
   ```
5. `followedAt`: `.map((game) => tcOf(Topic.Game({ league: game.league, game: game.id })))`.
6. Replace `framed` and `checkpoint`:
   ```ts
   /**
    * A socket text as its frame, an `H`'s followed by its checkpoint once it loads and decodes. Either way the `H`'s
    * outcome is handed to `published`; a checkpoint that fails is logged and counted, and only its `H` is framed. An `H`
    * on a topic FastCast's names do not read loads nothing. Every text is counted by its op.
    */
   const framed = Effect.fnUntraced(function* (
     text: string,
     published: (outcome: Result.Result<string, CheckpointUnread>) => Effect.Effect<boolean>
   ) {
     const envelope = Option.getOrUndefined(decodeEnvelope(text))
     const topic = Option.fromUndefinedOr(envelope?.channel).pipe(Option.flatMap(topicOf))
     const league = Option.map(topic, (on) => on.league)
     const op = envelope?.message.op ?? "unknown"
     yield* Metric.update(Metric.withAttributes(textsReceived, { op, ...Record.getSomes({ league }) }), 1)
     const frame = Frame.Pushed({ topic, mid: Option.fromUndefinedOr(envelope?.mid), body: text })
     if (envelope === undefined) {
       yield* Effect.logDebug("FastCast: framed a text of an unknown op", text)
       return [frame]
     }
     const { message } = envelope
     if (message.op !== "H" || Option.isNone(topic)) return [frame]

     const loaded = yield* checkpoint(topic.value, message.pl).pipe(Effect.result)
     if (Result.isSuccess(loaded)) {
       yield* published(Result.succeed(message.tc))
       return [frame, Frame.Checkpoint({ topic: topic.value, mid: message.mid, body: loaded.success })]
     }

     const error = loaded.failure
     yield* Effect.logWarning(
       `FastCast: the checkpoint of ${message.tc} at ${message.mid} failed`,
       error.cause
     ).pipe(Effect.annotateLogs({ topic: message.tc, reason: error.reason }))
     yield* Metric.update(Metric.withAttributes(checkpointFailures, Record.getSomes({ league })), 1)
     yield* published(Result.fail(error))
     return [frame]
   })

   /** The body of the checkpoint at `url`, as served, once it decodes as `topic`'s checkpoint. */
   function checkpoint(topic: Topic, url: string) {
     const tc = tcOf(topic)
     return HttpClient.get(url).pipe(
       Effect.flatMap(HttpClientResponse.filterStatusOk),
       Effect.flatMap((response) => response.text),
       Effect.timeout(checkpointTimeout),
       Effect.mapError((cause) => new CheckpointUnread({ topic: tc, reason: "Unloaded", cause })),
       Effect.tap((body) =>
         Schema.decodeEffect(FastCastMessage.Checkpoint(topic))(body).pipe(
           Effect.mapError((cause) => new CheckpointUnread({ topic: tc, reason: "Undecodable", cause }))
         )
       ),
       Effect.trackDuration(checkpointDuration)
     )
   }
   ```
7. `import { Frame } from "./Frame.ts"` stays a value import.

- [ ] **Step 10: `TestEspn.ts` reads the recorded day into typed frames**

The recording keeps its old JSON shape; only the reader changes. Replace `decodeFrame` and the `recordedNeAtBuf`
body's last line:

```ts
  const frames = lines.filter((line) => line !== "")
  return yield* Effect.forEach(frames, (line) => frameOf(line))
})
```

```ts
/** A line of the recording, as it was recorded: its way, its league or topic, whole or a change, and its mid. */
const decodeRecorded = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      source: Schema.Literals(["push", "poll"]),
      channel: Schema.String,
      kind: Schema.Literals(["whole", "change"]),
      number: Schema.optional(Schema.Int),
      body: Schema.String
    })
  )
)

/** A recorded line as the frame it is. */
const frameOf = Effect.fnUntraced(function* (line: string) {
  const { source, channel, kind, number, body } = yield* decodeRecorded(line)
  if (source === "poll") {
    const league = yield* decodeLeague(channel)
    return Frame.Polled({ league, body })
  }

  const topic = topicOf(channel)
  const mid = Option.fromUndefinedOr(number)
  if (kind === "change") return Frame.Pushed({ topic, mid, body })

  const checkpointTopic = yield* Effect.fromOption(topic)
  const checkpointMid = yield* Effect.fromOption(mid)
  return Frame.Checkpoint({ topic: checkpointTopic, mid: checkpointMid, body })
})

const decodeLeague = Schema.decodeUnknownEffect(LeagueId)
```

Imports: add `import { LeagueId } from "@sportal/domain/League"`, `Option` from `effect`,
`import { topicOf } from "./Topic.ts"`; `Frame` is a value import.

- [ ] **Step 11: Rewrite the test helpers for typed frames**

`EspnDecoder.test.ts`:
- Imports: `import { Frame } from "./Frame.ts"`, `import { type Topic, tcOf, topicOf } from "./Topic.ts"`;
  drop `DateTime` if unused.
- Delete the `at` constant.
- Replace the frame builders:

```ts
function poll(league: LeagueId, body: string): Frame {
  return Frame.Polled({ league, body })
}

function checkpoint(tc: string, mid: number, document: unknown): Frame {
  return Frame.Checkpoint({ topic: topicNamed(tc), mid, body: JSON.stringify(document) })
}

/** A `P` on `tc`, its patches sent as an array, one of the three ways FastCast spells them. */
function message(tc: string, mid: number, patches: ReadonlyArray<object>): Frame {
  const pl = JSON.stringify({ ts: 1791136341731, pl: patches })
  return Frame.Pushed({
    topic: topicOf(tc),
    mid: Option.some(mid),
    body: JSON.stringify({ op: "P", tc, mid, pl })
  })
}

/** The topic `tc` names; a test names only real ones. */
function topicNamed(tc: string): Topic {
  return Option.getOrThrow(topicOf(tc))
}

/** The recorded socket texts as FastCast frames them, each `H` followed by the recorded checkpoint. */
function recorded(texts: ReadonlyArray<string>): ReadonlyArray<Frame> {
  return texts.flatMap((body) => {
    const { message, channel, mid } = decodeEnvelope(body)
    const topic = Option.flatMap(Option.fromUndefinedOr(channel), topicOf)
    const frame = Frame.Pushed({ topic, mid: Option.fromUndefinedOr(mid), body })
    return message.op === "H" && Option.isSome(topic) && mid !== undefined
      ? [frame, Frame.Checkpoint({ topic: topic.value, mid, body: checkpointBody })]
      : [frame]
  })
}
```

- `moveRecordingFrames`: each message becomes
  `Frame.Pushed({ topic: topicOf(tc), mid: Option.some(mid), body: JSON.stringify({ op, tc, mid, pl: JSON.stringify({ ts, pl }) }) })`.
- `resetTopics`:
  - The filter becomes `frames.filter((frame) => !Frame.$is("Polled")(frame))`.
  - The reset topics become
    `...Option.toArray(change).flatMap((one) => (FastCastDocument.Change.$is("Reset")(one) ? [tcOf(one.topic)] : []))`.
- Rename the test "should log a frame that does not decode at Warning, with its source, channel and kind" to
  "should log a frame that does not decode at Warning, with its kind and league". Its expected annotations become
  `[["Warn", { frame: "Polled", league: "nfl" }]]`.

`EspnProvider.test.ts`, "should deliver FastCast's frames beside its polls":

```ts
const pushed = Frame.Pushed({
  topic: Option.some(Topic.Scoreboard({ league: "nfl" })),
  mid: Option.none(),
  body: "{}"
})
```

Imports: `import { Frame } from "./Frame.ts"`, `import { Topic } from "./Topic.ts"`; drop `DateTime` if unused.

`FastCast.test.ts`:
- Add this helper above `watched`, and import `Frame` (value), `Option`, and `tcOf` from `./Topic.ts`:

```ts
/** A frame as a test compares it: its kind, its topic's name, its mid, and its body, a socket text read as its op. */
function seen(frame: Frame) {
  return Frame.$match(frame, {
    Polled: ({ league, body }) => ({ tag: "Polled", tc: league, mid: undefined, body }),
    Pushed: ({ topic, mid, body }) => ({
      tag: "Pushed",
      tc: Option.getOrUndefined(Option.map(topic, tcOf)),
      mid: Option.getOrUndefined(mid),
      body: decodeSent(body).op
    }),
    Checkpoint: ({ topic, mid, body }) => ({ tag: "Checkpoint", tc: tcOf(topic), mid, body })
  })
}
```

- `numbered(mid)`: `all.some((frame) => seen(frame).mid === mid)`.
- `wholeAt(mid)`: `all.some((frame) => Frame.$is("Checkpoint")(frame) && frame.mid === mid)`.
- "should emit each socket text as a message frame, and an H's checkpoint after it":
  - The mapping becomes `firstFour.map(seen)`, with expected
    `[{ tag: "Pushed", tc: undefined, mid: undefined, body: "C" }, { tag: "Pushed", tc: "event-football-nfl", mid: undefined, body: "S" }, { tag: "Pushed", tc: "event-football-nfl", mid: 7, body: "H" }, { tag: "Checkpoint", tc: "event-football-nfl", mid: 7, body: checkpointBody }]`.
  - The last assertion becomes `assert.isFalse(firstFour.some(Frame.$is("Polled")))`.
- "should give a patch's frame its mid": `assert.strictEqual(patch === undefined ? undefined : seen(patch).mid, 8)`.
- "should keep the socket and the other topics when a checkpoint does not load…":
  - The mapping becomes
    `received.map(seen).flatMap(({ tag, tc, mid }) => (tc?.startsWith("gp-") ? [[tc, tag, mid]] : []))`.
  - Expected
    `[[missingTopic, "Pushed", undefined], [otherTopic, "Pushed", undefined], [missingTopic, "Pushed", 5], [otherTopic, "Pushed", 9], [otherTopic, "Checkpoint", 9], [otherTopic, "Pushed", 10]]`.
- "should emit only the H of a checkpoint that does not decode…":
  `received.slice(2).map(seen).map(({ tag, mid }) => [tag, mid])`, expected `[["Pushed", 7], ["Pushed", 8]]`.

- [ ] **Step 12: Run the whole check**

Run: `pnpm check`
Expected: PASS, with every test passing; the counts change only because of the renamed topic tests.

- [ ] **Step 13: Commit**

```bash
git add -A apps/hub/src/provider
git commit -m "refactor: typed ESPN frames and FastCast topics

Frame is a tagged enum (Polled, Pushed, Checkpoint) and a FastCast topic
is a Topic, parsed once where it arrives. FastCast documents are a HashMap
keyed by Topic. Frames carry no receivedAt; nothing read it.

FastCastTopic.test.ts -> Topic.test.ts:
- \"should name the %s scoreboard's topic\" -> same name
- \"should name %s game %s's package topic…\" -> same name
- \"should own a scoreboard topic by its league's scoreboard\" -> \"should read a scoreboard topic as its league's scoreboard\"
- \"should own a package topic by its game\" -> \"should read a package topic as its game\"
- \"should give no owner for %s\" -> \"should read no topic from %s\"
EspnDecoder.test.ts:
- \"should log a frame that does not decode at Warning, with its source, channel and kind\" -> \"…with its kind and league\"

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The Slate says what it changed

Independent of Tasks 1, 3 and 4.

**Files:**
- Modify: `apps/hub/src/slate/Slate.ts`, `apps/hub/src/Director.ts`, `CONTEXT.md`
- Test: `apps/hub/src/slate/Slate.test.ts`

**Interfaces:**
- Produces:
  - `Slate#take(deliveries): readonly [Slate, ReadonlyArray<SlateChange>]`
  - `type SlateChange = Progressed{game} | Delisted{game} | Played{game, play}`, `const SlateChange`

- [ ] **Step 1: Make the existing tests read the slate out of the tuple**

In `apps/hub/src/slate/Slate.test.ts`, every `X.take([…])` expression becomes `X.take([…])[0]`, including inside
`listed(…)`. There are 52 calls. A `take([` whose array spans several lines needs the `[0]` after its closing `])`;
the typechecker in Step 4 finds any that were missed.

- [ ] **Step 2: Write the failing tests for the changes**

Append to `Slate.test.ts`, before the helpers. Add `SlateChange` to the `./Slate.ts` import.

```ts
describe("Slate#take, its changes", () => {
  it("should give a game a listing names for the first time as Progressed", () => {
    const game = live(one, "10:00")

    const [next, changes] = Slate.empty.take([listing("fbs", [game])])

    assert.deepStrictEqual(changes, [SlateChange.Progressed({ game: gameIn(next, one) })])
  })

  it("should give a listed game whose snapshot it takes as Progressed", () => {
    const slate = listed(live(one, "10:00"))

    const [next, changes] = slate.take([snapshotOf(live(one, "9:00"))])

    assert.deepStrictEqual(changes, [SlateChange.Progressed({ game: gameIn(next, one) })])
  })

  it("should give a game its league's listing no longer names as Delisted", () => {
    const slate = listed(live(one, "10:00"), live(two, "10:00"))

    const [, changes] = slate.take([listing("fbs", [live(one, "10:00")])])

    assert.deepStrictEqual(changes, [SlateChange.Delisted({ game: gameIn(slate, two) })])
  })

  it("should give each play it adds as Played, in Play.order", () => {
    const slate = listed(live(one, "10:00"))

    const [next, changes] = slate.take([playsOf(one, 2)])

    const game = gameIn(next, one)
    assert.deepStrictEqual(
      changes,
      game.plays.map((play) => SlateChange.Played({ game, play }))
    )
  })

  it("should give no Progressed for a game whose plays alone change", () => {
    const slate = listed(live(one, "10:00"))

    const [, changes] = slate.take([playsOf(one, 1)])

    assert.isFalse(changes.some(SlateChange.$is("Progressed")))
  })

  it("should give no change for a take that changes nothing", () => {
    const game = live(one, "10:00")
    const slate = listed(game)

    const [, changes] = slate.take([listing("fbs", [game])])

    assert.deepStrictEqual(changes, [])
  })
})
```

Add the helper beside `snapshotIn`:

```ts
/** Game `id`, as `slate` has it; the test fails when the slate lacks it. */
function gameIn(slate: Slate, id: GameId): Game {
  return Option.getOrThrow(slate.game(id))
}
```

Change the domain import to `import { type Game, GameId, type GameSnapshot } from "@sportal/domain/Game"`.

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @sportal/hub exec vitest run src/slate/Slate.test.ts`
Expected: FAIL. `SlateChange` is not exported, and `take` returns a `Slate`.

- [ ] **Step 4: Implement `take`'s changes in `Slate.ts`**

```ts
import { LiveMessage, type SlateChanged } from "@sportal/api/LiveMessage"
import { Game, type GameId, type GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import type { Play } from "@sportal/domain/Play"
import { Array as Arr, Data, type Option } from "effect"
import { Delivery } from "./Delivery.ts"

/**
 * The slate: the games each league's last listing names, in its order, each with its latest snapshot not behind the one
 * before it and its plays. Pure: `take` returns the next slate and what it changed.
 */
export class Slate extends Data.Class<{
  /** The listed games: leagues in `LeagueId.literals` order, each league's in its listing's order. */
  readonly games: ReadonlyArray<Game>
}> {
  static readonly empty: Slate = new Slate({ games: [] })

  /**
   * Takes one frame's deliveries, in order, and gives the next slate with what each delivery changed, in order. A listing
   * replaces its league's games with the ones it names, each taken into the game the slate had (`Game#listed`) or new. A
   * snapshot or plays of a listed game are taken into it (`Game#snapshotTaken`, `Game#playsTaken`); of a game no listing
   * names, dropped. A take that changes nothing gives back this slate itself and no change, and a game it does not
   * change stays the same `Game`.
   */
  take(deliveries: ReadonlyArray<Delivery>): Taken {
    return deliveries.reduce<Taken>(
      ([slate, changes], delivery) => {
        const [next, changed] = slate.delivered(delivery)
        return [next, [...changes, ...changed]]
      },
      [this, []]
    )
  }

  /** Game `id`, where the slate has it. */
  game(id: GameId): Option.Option<Game> {
    return Arr.findFirst(this.games, ({ snapshot }) => snapshot.id === id)
  }

  /** What the live stream sends of it: every listed game, with its recent plays. */
  published(): SlateChanged {
    const games = this.games.map((game) => game.recent())
    return LiveMessage.cases.SlateChanged.make({ games })
  }

  private delivered(delivery: Delivery): Taken {
    return Delivery.match(delivery, {
      Listing: ({ league, games }) => this.relisted(league, games),
      Snapshot: ({ snapshot }) => this.changed(snapshot.id, (game) => game.snapshotTaken(snapshot)),
      Plays: ({ game, plays }) => this.changed(game, (had) => had.playsTaken(plays))
    })
  }

  /**
   * League `league` listing `snapshots`: its games, in their order, each taken into the game the slate had; each game it
   * no longer names is delisted.
   */
  private relisted(league: LeagueId, snapshots: ReadonlyArray<GameSnapshot>): Taken {
    const had = this.games.filter((game) => game.snapshot.league === league)
    const listed = snapshots.map((snapshot) => {
      const game = had.find((each) => each.snapshot.id === snapshot.id)
      return game === undefined ? Game.of(snapshot) : game.listed(snapshot)
    })
    if (sameGames(listed, had)) return [this, []]

    const games = LeagueId.literals.flatMap((each) =>
      each === league ? listed : this.games.filter((game) => game.snapshot.league === each)
    )
    const delisted = had
      .filter((game) => !listed.some((each) => each.snapshot.id === game.snapshot.id))
      .map((game) => SlateChange.Delisted({ game }))
    const changed = listed.flatMap((game) =>
      changesOf(
        had.find((each) => each.snapshot.id === game.snapshot.id),
        game
      )
    )
    return [new Slate({ games }), [...delisted, ...changed]]
  }

  /** Game `id` changed by `change`, where the slate has it. */
  private changed(id: GameId, change: (game: Game) => Game): Taken {
    const index = this.games.findIndex((game) => game.snapshot.id === id)
    const had = this.games[index]
    if (had === undefined) return [this, []]

    const next = change(had)
    if (next === had) return [this, []]

    return [new Slate({ games: this.games.with(index, next) }), changesOf(had, next)]
  }
}

/** One thing a take changed: a game's snapshot, a game no listing names any more, or a play a game did not have. */
export type SlateChange = Data.TaggedEnum<{
  /** A listed game's snapshot changed, or a listing named it for the first time. */
  Progressed: { readonly game: Game }
  /** No listing of its league names it any more. */
  Delisted: { readonly game: Game }
  /** A play its game did not have before. */
  Played: { readonly game: Game; readonly play: Play }
}>
export const SlateChange = Data.taggedEnum<SlateChange>()

/** The next slate, and what a take changed to reach it. */
type Taken = readonly [Slate, ReadonlyArray<SlateChange>]

/** Whether `games` are the very games `had`, in the same order. */
function sameGames(games: ReadonlyArray<Game>, had: ReadonlyArray<Game>): boolean {
  return games.length === had.length && games.every((game, index) => game === had[index])
}

/** What `next` changed of `had`, none when the slate did not have it: its snapshot, then each play it added. */
function changesOf(had: Game | undefined, next: Game): ReadonlyArray<SlateChange> {
  if (had === next) return []

  const progressed = had?.snapshot === next.snapshot ? [] : [SlateChange.Progressed({ game: next })]
  const played = next
    .playsAfter(had ?? Game.of(next.snapshot))
    .map((play) => SlateChange.Played({ game: next, play }))
  return [...progressed, ...played]
}
```

- [ ] **Step 5: Run the Slate tests**

Run: `pnpm --filter @sportal/hub exec vitest run src/slate/Slate.test.ts`
Expected: PASS.

- [ ] **Step 6: The Director reads the changes**

In `apps/hub/src/Director.ts`, replace `take`'s generator body:

```ts
        function* (deliveries: ReadonlyArray<Delivery>) {
          yield* Effect.annotateCurrentSpan({ "sportal.deliveries": deliveries.length })
          const before = yield* SubscriptionRef.get(slate)
          const [next, changes] = before.take(deliveries)
          if (next === before) return

          yield* SubscriptionRef.set(slate, next)
          yield* Effect.forEach(changes, observed, { discard: true })
        },
```

Delete `gaugeChanged`, `byId` and `loggedNewPlays`. Below the class, before `gauge`, add:

```ts
/** A change the slate took, observed: a game's progress gauged (0 once delisted), or a play it added logged. */
function observed(change: SlateChange) {
  return SlateChange.$match(change, {
    Progressed: ({ game }) => gauge(game.snapshot, progressValues[game.snapshot.progress()]),
    Delisted: ({ game }) => gauge(game.snapshot, 0),
    Played: ({ game, play }) => loggedPlay(game.snapshot, play)
  })
}
```

Imports:
- `import { type GameId, type GameSnapshot } from "@sportal/domain/Game"`; `Game` is no longer used.
- `import { Slate, SlateChange } from "./slate/Slate.ts"`.

Update the layer's doc comment to read "…gauging each game a take changed by its progress, and logging each play it
adds, as the take says…".

- [ ] **Step 7: Add the glossary row**

In `CONTEXT.md`, after the **Slate changed** row:

```
| **Slate change** | One thing a take changed: a game's snapshot (`Progressed`, including a game newly listed), a game no listing names any more (`Delisted`), or a play a game did not have (`Played`); `SlateChange` in `apps/hub/src/slate/Slate.ts`, given by `Slate#take` beside the next slate. The Director gauges and logs from them. | diff, delta, event |
```

In the **Slate** row, replace "Pure; `take` returns the next slate, or this one when nothing changed." with
"Pure; `take` returns the next slate and its slate changes, or this one and none when nothing changed."

- [ ] **Step 8: Run the whole check**

Run: `pnpm check`
Expected: PASS. Director tests "Director's game state gauge" and "Director's play log" pass unchanged.

- [ ] **Step 9: Commit**

```bash
git add -A apps/hub/src/slate apps/hub/src/Director.ts CONTEXT.md
git commit -m "refactor: the slate says what each take changed

Slate#take returns the next slate and its SlateChanges (Progressed,
Delisted, Played); the Director gauges and logs from them instead of
diffing the slates before and after.

Slate.test.ts: every test keeps its name and assertions, reading the
slate from the tuple.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: One fold, `EspnState`

FastCast still steers from its own fold for now (Task 4 removes it). After this task, polls and pushes are folded
once in `EspnProvider`, a push moves its game forward in the listing, a lagging poll does not set a pushed game
back, and polling reads the state.

**Files:**
- Create: `apps/hub/src/provider/espn/EspnState.ts`
- Create: `apps/hub/src/provider/espn/EspnState.test.ts` (`git mv` from `EspnDecoder.test.ts`, then edit)
- Create: `apps/hub/src/provider/espn/EspnDecoder.test.ts` (only its `byLeague` test)
- Modify: `EspnDecoder.ts`, `EspnProvider.ts`, `TestEspn.ts`, `CONTEXT.md`
- Test: `EspnProvider.test.ts`

**Interfaces:**
- Consumes: Task 1's `Frame`, `Topic`, `FastCastDocument.advance` and `Change`.
- Produces:
  - `class EspnState { documents; listings; static empty; take(frame): Effect<readonly [EspnState, ReadonlyArray<Delivery>]>; games(): ReadonlyArray<GameSnapshot> }`
  - `EspnDecoder.byLeague`, `EspnDecoder.gamesOf`, `EspnDecoder.playsOf`; `decode` is gone
  - `TestEspn.decodedFrames(frames)`, now over `EspnState`, and `TestEspn.stateAfter(frames): Effect<EspnState>`

- [ ] **Step 1: Move the decoder's tests to `EspnState.test.ts`**

```bash
git mv apps/hub/src/provider/espn/EspnDecoder.test.ts apps/hub/src/provider/espn/EspnState.test.ts
```

In `EspnState.test.ts`:
- `describe("EspnDecoder", …)` becomes `describe("EspnState#take", …)`.
- Cut the `describe("EspnDecoder.byLeague", …)` block into a new `EspnDecoder.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { LeagueId } from "@sportal/domain/League"
import { Record } from "effect"
import * as EspnDecoder from "./EspnDecoder.ts"

describe("EspnDecoder.byLeague", () => {
  it("should have a decoder for every league", () => {
    const leagues = Record.keys(EspnDecoder.byLeague)

    assert.deepStrictEqual(leagues, [...LeagueId.literals])
  })
})
```

- Drop the `EspnDecoder` and `LeagueId` imports from `EspnState.test.ts` if they're now unused (`LeagueId` stays as
  a type for `poll`). Add `import { stateAfter } from "./TestEspn.ts"` and `import { Topic } from "./Topic.ts"` (merge
  it with the `topicOf` import).

- [ ] **Step 2: Write the failing tests for what the fold now adds**

Append inside `describe("EspnState#take", …)`, before `describe("a game's plays", …)`:

```ts
  it.effect("should move a listed game forward in its listing on a push", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([...synced(), scoreReplaced(4286638)])

      const ari = state.games().find((game) => game.id === "401872966")
      assert.strictEqual(ari?.away.score, 17)
    })
  )

  it.effect("should keep a pushed game's progress over a poll that lags it", () =>
    Effect.gen(function* () {
      const final = message("event-football-nfl", 4286638, [
        { op: "replace", path: `${neAtBuf}/fullStatus/type/state`, value: "post" }
      ])

      const state = yield* stateAfter([...synced(), final, poll("nfl", scoreboardBody)])

      const game = state.games().find((each) => each.id === "401872971")
      assert.strictEqual(game?.progress(), "over")
    })
  )

  it.effect("should deliver a poll's own games in its listing, whatever a push moved forward", () =>
    Effect.gen(function* () {
      const final = message("event-football-nfl", 4286638, [
        { op: "replace", path: `${neAtBuf}/fullStatus/type/state`, value: "post" }
      ])

      const deliveries = yield* decoded([...synced(), final, poll("nfl", scoreboardBody)])

      const relisted = deliveries.at(-1)?.delivery
      const game =
        relisted !== undefined && Delivery.guards.Listing(relisted)
          ? relisted.games.find((each) => each.id === "401872971")
          : undefined
      assert.strictEqual(game?.progress(), "live")
    })
  )
```

Add, beside `ariAtNyg`:

```ts
const neAtBuf = "s:20~l:28~e:401872971~c:401872971"
```

`synced()` lists `nfl` from `scoreboardBody` (18:00Z), where NE at BUF (`401872971`) is live; the final patch is the
one `FastCast.test.ts`'s `stateOf(firstGame, "post")` sends.

- [ ] **Step 3: Rewrite `TestEspn.decodedFrames` over the state, and add `stateAfter`**

```ts
/** What ESPN's fold says each of `frames` said, from an empty state. */
export const decodedFrames = Effect.fn("TestEspn.decodedFrames")(function* (frames: ReadonlyArray<Frame>) {
  return yield* Stream.fromIterable(frames).pipe(
    Stream.mapAccumEffect(
      () => EspnState.empty,
      (state, frame) => Effect.map(state.take(frame), ([next, deliveries]) => [next, [deliveries]] as const)
    ),
    Stream.runCollect
  )
})

/** ESPN's state after `frames`, from an empty one. */
export const stateAfter = Effect.fn("TestEspn.stateAfter")(function* (frames: ReadonlyArray<Frame>) {
  return yield* Effect.reduce(
    frames,
    () => EspnState.empty,
    (state, frame) => Effect.map(state.take(frame), ([next]) => next)
  )
})
```

Imports: replace `import * as EspnDecoder from "./EspnDecoder.ts"` with `import { EspnState } from "./EspnState.ts"`.

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/EspnState.test.ts`
Expected: FAIL, `Cannot find module './EspnState.ts'`.

- [ ] **Step 5: Write `EspnState.ts`**

```ts
import { Game, type GameSnapshot } from "@sportal/domain/Game"
import type { LeagueId } from "@sportal/domain/League"
import { Array as Arr, Data, Effect, HashMap, Option, Record } from "effect"
import { Delivery } from "../../slate/Delivery.ts"
import * as EspnDecoder from "./EspnDecoder.ts"
import * as FastCastDocument from "./FastCastDocument.ts"
import { Frame } from "./Frame.ts"
import { tcOf } from "./Topic.ts"

/**
 * What ESPN has said, every frame folded in once: each FastCast topic's document, and each league's listed games, as its
 * last poll listed them, each moved forward by every push since.
 */
export class EspnState extends Data.Class<{
  readonly documents: typeof FastCastDocument.empty
  readonly listings: HashMap.HashMap<LeagueId, ReadonlyArray<GameSnapshot>>
}> {
  static readonly empty: EspnState = new EspnState({
    documents: FastCastDocument.empty,
    listings: HashMap.empty()
  })

  /**
   * This state after `frame`, and what the frame said. A poll is its league's `Listing` of the games it shows; the
   * listing it keeps holds, for a game a push moved past the poll, the pushed one (`Game#listed`). A scoreboard topic's
   * change is a `Snapshot` of each listed game it touched, advanced to it (FastCast has no short names), and moves that
   * game forward in its listing; a game no listing has is not delivered. A game topic's change is a `Plays` of the
   * game's whole list, in `Play.order`. An event or a play that does not decode is skipped. A frame that does not decode
   * says nothing, leaves the state as it was, and is logged.
   */
  take(frame: Frame): Effect.Effect<readonly [EspnState, ReadonlyArray<Delivery>]> {
    return taken(this, frame)
  }

  /** Every listed game, as the state has it. */
  games(): ReadonlyArray<GameSnapshot> {
    return [...HashMap.values(this.listings)].flat()
  }
}

const taken = Effect.fnUntraced(
  function* (state: EspnState, frame: Frame) {
    return yield* Frame.$match(frame, {
      Polled: ({ league, body }) => listed(state, league, body),
      Pushed: () => pushed(state, frame),
      Checkpoint: () => pushed(state, frame)
    })
  },
  (effect, state, frame) =>
    Effect.catch(effect, (cause) =>
      Effect.logWarning("EspnState: skipped a frame that does not decode", cause).pipe(
        Effect.annotateLogs(annotationsOf(frame)),
        Effect.as([state, noDeliveries] as const)
      )
    )
)

const listed = Effect.fnUntraced(function* (state: EspnState, league: LeagueId, body: string) {
  const scoreboard = yield* EspnDecoder.byLeague[league].decodeScoreboard(body)
  const games = yield* EspnDecoder.gamesOf(league, scoreboard.events)

  const had = Option.getOrElse(HashMap.get(state.listings, league), () => [])
  const kept = games.map((game) => keptOver(had, game))
  const next = new EspnState({ ...state, listings: HashMap.set(state.listings, league, kept) })
  return [next, [Delivery.cases.Listing.make({ league, games })]] as const
})

/** A polled `game` as its listing keeps it: the one `had` held when a push moved it past the poll (`Game#listed`). */
function keptOver(had: ReadonlyArray<GameSnapshot>, game: GameSnapshot): GameSnapshot {
  return Option.match(
    Arr.findFirst(had, (each) => each.id === game.id),
    {
      onNone: () => game,
      onSome: (pushed) => Game.of(pushed).listed(game).snapshot
    }
  )
}

const noDeliveries: ReadonlyArray<Delivery> = []

const pushed = Effect.fnUntraced(function* (state: EspnState, frame: Frame) {
  const { documents, change } = yield* FastCastDocument.advance(state.documents, frame)

  const advanced = new EspnState({ ...state, documents })
  return yield* Option.match(change, {
    onNone: () => Effect.succeed([advanced, noDeliveries] as const),
    onSome: FastCastDocument.Change.$match({
      Scoreboard: ({ league, events }) =>
        Effect.map(EspnDecoder.gamesOf(league, events), (games) => movedForward(advanced, league, games)),
      Game: ({ league, game, plays }) =>
        Effect.map(
          EspnDecoder.playsOf(league, plays),
          (sorted) => [advanced, [Delivery.cases.Plays.make({ game, plays: sorted })]] as const
        ),
      Reset: () => Effect.succeed([advanced, noDeliveries] as const)
    })
  })
})

/** `state` with each pushed game its league lists moved forward in the listing, and a `Snapshot` of each. */
function movedForward(
  state: EspnState,
  league: LeagueId,
  games: ReadonlyArray<GameSnapshot>
): readonly [EspnState, ReadonlyArray<Delivery>] {
  const listing = Option.getOrElse(HashMap.get(state.listings, league), () => [])
  const advanced = games.flatMap((game) =>
    Arr.findFirst(listing, (listedGame) => listedGame.id === game.id).pipe(
      Option.map((listedGame) => listedGame.advancedTo(game)),
      Option.toArray
    )
  )
  if (advanced.length === 0) return [state, noDeliveries]

  const moved = listing.map((listedGame) => advanced.find((game) => game.id === listedGame.id) ?? listedGame)
  const next = new EspnState({ ...state, listings: HashMap.set(state.listings, league, moved) })
  return [next, advanced.map((snapshot) => Delivery.cases.Snapshot.make({ snapshot }))]
}

/** What a log of `frame` is annotated with: its kind, and its league or its topic's name. */
function annotationsOf(frame: Frame): Readonly<Record<string, string>> {
  return Frame.$match(frame, {
    Polled: ({ league }) => ({ frame: "Polled", league }),
    Pushed: ({ topic }) => ({ frame: "Pushed", ...Record.getSomes({ topic: Option.map(topic, tcOf) }) }),
    Checkpoint: ({ topic }) => ({ frame: "Checkpoint", topic: tcOf(topic) })
  })
}
```

Note: `Effect.fnUntraced`'s second argument receives `(effect, ...args)`, as `EspnProvider.poll`'s `Effect.fn` does.
If the typechecker rejects it for `fnUntraced`, move the `Effect.catch` into `take` itself:
`return taken(this, frame).pipe(Effect.catch(…))`.

- [ ] **Step 6: Shrink `EspnDecoder.ts`**

Delete `decode`, `State`, `listed`, `noDeliveries`, `pushed`, `advancedToListed`, `annotationsOf` and their imports
(`Delivery`, `Frame`, `FastCastDocument`, `HashMap`, `Option`, `Stream`, `tcOf`). Export `playsOf`:

```ts
/** The game's plays, in `Play.order`; a play that does not decode is skipped. */
export const playsOf = Effect.fnUntraced(function* (/* unchanged */)
```

The file's doc comment, on `byLeague`:

```ts
/**
 * Each league's decode of what ESPN sends for it: an event of either feed, a play entity, and the site scoreboard's JSON.
 * `EspnState` folds frames through these.
 */
```

- [ ] **Step 7: `EspnProvider` folds every frame into one state, and polling reads it**

Replace the layer's body, `Polled`, `polledOf`, `polling`, `shownAfter` and `interval`. `gamesShown` and `HashMap`
go; `scoreboardUrl` and the metrics stay.

```ts
/**
 * ESPN as the provider: the site scoreboard of each league `HubConfig` names, polled, and FastCast pushing, every frame
 * folded once into one `EspnState`. It polls every league, then waits by every game the state lists (a push moves a
 * listed game forward): 10 seconds while a game is live, a minute within 30 minutes of a kickoff, and 15 minutes
 * otherwise; at most 30 seconds after a poll in which a league failed or did not decode. A poll that does not connect is
 * `Unreachable` for its league, and one answered with a status other than 2xx `Refused`; either is logged and counted,
 * and delivers no frame.
 */
export const layer: Layer.Layer<Provider, never, FastCast | HttpClient.HttpClient | HubConfig> = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const { leagues } = yield* HubConfig
    const http = yield* HttpClient.HttpClient
    const fastCast = yield* FastCast
    const client = http.pipe(HttpClient.filterStatusOk)
    const state = yield* SubscriptionRef.make(EspnState.empty)

    // One frame at a time into the one state: what it said.
    const taken = (frame: Frame) =>
      SubscriptionRef.modifyEffect(state, (current) =>
        Effect.map(current.take(frame), ([next, deliveries]) => [deliveries, next] as const)
      )

    const poll = Effect.fn("EspnProvider.poll")(
      /* unchanged from Task 1 */
    )
    // Its timer keeps the name the dashboards read.
    const pollEveryLeague = Effect.fn("EspnProvider.pollEveryLeague")(function* () {
      const polled = yield* Effect.forEach(leagues, (league) => polledOf(league, poll(league), taken))
      const failed = polled.flatMap(({ league, said }) => (Option.isNone(said) ? [league] : []))
      yield* Effect.annotateCurrentSpan({ "sportal.leagues": leagues, "sportal.failed_leagues": failed })
      return polled
    }, Effect.trackDuration(pollDuration))

    const polls = Stream.fromEffectSchedule(pollEveryLeague(), polling(state)).pipe(
      Stream.flatMap((polled) => Stream.fromIterable(polled.flatMap(({ said }) => Option.toArray(said))))
    )
    const pushes = fastCast.frames.pipe(Stream.mapEffect(taken))

    return Provider.of({ deliveries: Stream.merge(polls, pushes) })
  })
)
```

```ts
/** One league's part of a poll: what its frame said, none when the poll failed. */
interface Polled {
  readonly league: LeagueId
  readonly said: Option.Option<ReadonlyArray<Delivery>>
}

/** `league`'s part of a poll by `polling`, its frame `taken` into the state; a failure is logged and counted. */
const polledOf = Effect.fnUntraced(function* (
  league: LeagueId,
  polling: Effect.Effect<Frame, ProviderUnavailable>,
  taken: (frame: Frame) => Effect.Effect<ReadonlyArray<Delivery>>
) {
  const frame = yield* polling.pipe(
    Effect.tapError((error) =>
      Effect.logWarning(
        "EspnProvider: a poll failed; keeping the last good listing for this league, if any",
        error
      ).pipe(Effect.andThen(Metric.update(Metric.withAttributes(providerErrors, { league }), 1)))
    ),
    Effect.option
  )
  const said = yield* Option.match(frame, {
    onNone: () => Effect.succeedNone,
    onSome: (polled) => Effect.map(taken(polled), Option.some)
  })
  return { league, said } satisfies Polled
})

/**
 * ESPN's polling policy: after each poll, wait as `interval` says of every game `state` lists then. A league whose poll
 * failed or did not list caps the wait at 30 seconds.
 */
function polling(
  state: SubscriptionRef.SubscriptionRef<EspnState>
): Schedule.Schedule<Duration.Duration, ReadonlyArray<Polled>> {
  return Schedule.fromStep(
    Effect.succeed((now: number, polled: ReadonlyArray<Polled>) =>
      Effect.map(SubscriptionRef.get(state), (current) => {
        const wait = interval(current.games(), polled.some(unlisted), DateTime.makeUnsafe(now))
        const step: [Duration.Duration, Duration.Duration] = [wait, wait]
        return step
      })
    )
  )
}

/** Whether a league's part of a poll listed nothing: the poll failed, or its scoreboard did not decode. */
function unlisted({ said }: Polled): boolean {
  return !Option.exists(said, (deliveries) => deliveries.some(Delivery.guards.Listing))
}

/**
 * How long to wait before the next poll, given every listed game. When a league failed in the last poll or its
 * scoreboard did not decode, the wait is capped at 30 seconds so that scoreboard is read again soon; a live game still
 * polls every 10 seconds. Reads only each game's progress and kickoff, so any league polls by it.
 */
function interval(games: ReadonlyArray<GameSnapshot>, anyUnlisted: boolean, now: DateTime.Utc): Duration.Duration {
  const normal = games.some((game) => game.progress() === "live")
    ? Duration.seconds(10)
    : games.some((game) => game.isLiveOrKicksOffWithin(GameSnapshot.kickoffWindow, now))
      ? Duration.minutes(1)
      : Duration.minutes(15)
  return anyUnlisted ? Duration.min(normal, Duration.seconds(30)) : normal
}
```

Imports:
- `effect`: `DateTime, Duration, Effect, Layer, Metric, Option, Predicate, Schedule, Stream, SubscriptionRef`.
- `import { Delivery } from "../../slate/Delivery.ts"`
- `import { EspnState } from "./EspnState.ts"`
- `EspnDecoder` is no longer imported here.

- [ ] **Step 8: Write the failing provider test: a push shapes the next wait**

In `EspnProvider.test.ts`, give `polledOver` a third parameter, `pushing: Stream.Stream<Frame> = Stream.never`, and
pass it into `espnOver(client, { leagues: leagues.join(","), pushing })`. A push adds one frame to its queue; the
queue only paces the test clock, so the instants it returns are unchanged.

Append inside `describe("EspnProvider.deliveries", …)`:

```ts
  it.effect("should poll every 10 seconds after a push shows a game live that the poll still shows upcoming", () =>
    Effect.gen(function* () {
      const soon = scoreboardOf([{ state: "pre", period: 0, kickoff: "2026-10-03T12:20Z" }])
      const live = JSON.parse(scoreboardOf([{ state: "in", period: 2, kickoff: "2026-10-03T12:20Z" }]))
      const checkpoint = Frame.Checkpoint({
        topic: Topic.Scoreboard({ league: "fbs" }),
        mid: 1,
        body: JSON.stringify({ sports: [{ leagues: [{ events: live.events }] }] })
      })
      const pushedAt30s = Stream.fromEffect(Effect.sleep("30 seconds")).pipe(Stream.as(checkpoint))

      const polled = yield* polledOver(["1 minute", "10 seconds"], { fbs: soon }, pushedAt30s)

      assert.deepStrictEqual(polled, [0, 60_000, 70_000])
    })
  )
```

The checkpoint's event is a site-scoreboard event. `EspnEvent` decodes either feed's spelling, and the checkpoint
schema needs only each event's `uid`, which the site event has.

- [ ] **Step 9: Run the hub tests**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider`
Expected: PASS, every `EspnState#take` test, every `EspnProvider` test, and `Espn.layer`.

If the new provider test shows `[0, 60_000, 120_000]`, the poll at 60 s set the game back. Check that `keptOver`
holds the pushed game: `Game.listed` keeps a live game over a polled upcoming one at an earlier game time.

- [ ] **Step 10: Add the glossary row**

In `CONTEXT.md`, after **Provider feed**:

```
| **ESPN state** | Everything ESPN has said, each frame folded in once: each FastCast topic's document, and each league's listed games, as its last poll listed them and moved forward by each push since (a lagging poll does not set a pushed game back); `EspnState` in `apps/hub/src/provider/espn/EspnState.ts`. Its `take` gives each frame's deliveries; the poll's wait reads its games. | decoder state, cache |
```

- [ ] **Step 11: Run the whole check**

Run: `pnpm check`
Expected: PASS. `knip --production` raises no unused export: `EspnDecoder.decode` is gone; `playsOf` and `gamesOf`
are used by `EspnState` (and `gamesOf` by `FastCast.steered` until Task 4).

- [ ] **Step 12: Commit**

```bash
git add -A apps/hub/src/provider CONTEXT.md
git commit -m "refactor: ESPN folds every frame once into EspnState

EspnProvider keeps one EspnState in a SubscriptionRef. Each poll and push
is taken into it once; polling reads its games instead of carrying its own
map. A push moves its game forward in the listing, and a lagging poll keeps
the pushed game (Game#listed), so the wait after a poll reads pushes too.
EspnDecoder keeps only the per-league decoders.

EspnDecoder.test.ts -> EspnState.test.ts: every test keeps its name and
assertions under describe(\"EspnState#take\"); \"EspnDecoder.byLeague\"
stays in EspnDecoder.test.ts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: FastCast follows a wanted set

**Files:**
- Modify: `apps/hub/src/provider/espn/FastCast.ts`, `EspnState.ts`, `EspnProvider.ts`, `FastCastDocument.ts`,
  `CONTEXT.md`
- Test: `FastCast.test.ts`, `EspnState.test.ts`, `EspnProvider.test.ts`

**Interfaces:**
- Consumes: Task 3's `EspnState`, and Task 1's `Topic` and `FastCastDocument`.
- Produces:
  - `FastCast { follow(wanted: Stream<Wanted>): Stream<Frame> }`, with `FastCast.make(retry)`, `FastCast.layer` and
    `FastCast.layerTest(follow)`. It no longer needs `HubConfig`.
  - `type Wanted = HashMap<Topic, "Synced" | "AwaitingCheckpoint">`, exported beside `FastCast`
  - `EspnState#wanted(leagues, now): Wanted`
  - `FastCastDocument.isSynced(documents, topic): boolean`; `FastCastDocument.scoreboard` and `unchanged` are no
    longer exported

- [ ] **Step 1: Write the failing `EspnState#wanted` tests**

Append to `EspnState.test.ts`. Add `HashMap` to the `effect` import, and `DateTime` back if Task 1 dropped it.

```ts
describe("EspnState#wanted", () => {
  const nfl = ["nfl"] as const
  const scoreboard = Topic.Scoreboard({ league: "nfl" })
  const gameTopic = (id: string) => Topic.Game({ league: "nfl", game: GameId.make(id) })
  const at = (iso: string) => DateTime.makeUnsafe(iso)

  it("should want each league's scoreboard topic, waiting for its checkpoint, before any frame", () => {
    const wanted = EspnState.empty.wanted(["nfl", "fbs"], at("2026-10-04T18:00:00Z"))

    assert.strictEqual(HashMap.size(wanted), 2)
    assert.deepStrictEqual(HashMap.get(wanted, scoreboard), Option.some("AwaitingCheckpoint"))
    assert.deepStrictEqual(
      HashMap.get(wanted, Topic.Scoreboard({ league: "fbs" })),
      Option.some("AwaitingCheckpoint")
    )
  })

  it.effect("should want a listed game's topic while it is live", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([poll("nfl", scoreboardBody)])

      const wanted = state.wanted(nfl, at("2026-10-04T18:00:00Z"))

      assert.isTrue(HashMap.has(wanted, gameTopic("401872971")))
    })
  )

  it.effect("should want a listed game's topic from 30 minutes before its kickoff", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([poll("nfl", scoreboardBody)])

      const wanted = state.wanted(nfl, at("2026-10-04T19:35:00Z"))

      assert.isTrue(HashMap.has(wanted, gameTopic("401872974")))
    })
  )

  it.effect("should not want a listed game's topic a second before 30 minutes before its kickoff", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([poll("nfl", scoreboardBody)])

      const wanted = state.wanted(nfl, at("2026-10-04T19:34:59Z"))

      assert.isFalse(HashMap.has(wanted, gameTopic("401872974")))
    })
  )

  it.effect("should not want the topic of a game a push shows over", () =>
    Effect.gen(function* () {
      const final = message("event-football-nfl", 4286638, [
        { op: "replace", path: `${neAtBuf}/fullStatus/type/state`, value: "post" }
      ])
      const state = yield* stateAfter([...synced(), final])

      const wanted = state.wanted(nfl, at("2026-10-04T18:00:00Z"))

      assert.isFalse(HashMap.has(wanted, gameTopic("401872971")))
    })
  )

  it.effect("should want no game's topic a push shows before any poll lists it", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter(recorded(socketTexts.slice(0, 3)))

      const wanted = state.wanted(nfl, at("2026-10-04T18:00:00Z"))

      assert.deepStrictEqual([...HashMap.keys(wanted)], [scoreboard])
    })
  )

  it.effect("should show a synced topic as Synced", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter(synced())

      const wanted = state.wanted(nfl, at("2026-10-04T18:00:00Z"))

      assert.deepStrictEqual(HashMap.get(wanted, scoreboard), Option.some("Synced"))
    })
  )

  it.effect("should show a topic that lost its document as waiting for its checkpoint", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter([...synced(), unapplicablePatch(4286638)])

      const wanted = state.wanted(nfl, at("2026-10-04T18:00:00Z"))

      assert.deepStrictEqual(HashMap.get(wanted, scoreboard), Option.some("AwaitingCheckpoint"))
    })
  )
})
```

The game ids come from the recorded checkpoint, as `FastCast.test.ts` names them: `401872971` (NE at BUF) is live at
18:00Z, and `401872974` kicks off at 20:05Z. Check both against `nfl-scoreboard-2026-10-04T1800Z.json` before
running; if `401872974` isn't listed there, use any event of that file whose `date` is `2026-10-04T20:05Z`.

Add, inside `describe("EspnState#take", …)`, the reset log, which moves here from FastCast:

```ts
  it.effect("should log a topic that lost its document at Warning, with why and its topic", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()

      yield* stateAfter([...synced(), unapplicablePatch(4286638)]).pipe(Effect.provide(layer))

      const lost = logs.filter(({ message }) => message.includes("event-football-nfl lost its document"))
      assert.lengthOf(lost, 1)
      assert.strictEqual(lost[0]?.level, "Warn")
      assert.strictEqual(lost[0]?.annotations.topic, "event-football-nfl")
    })
  )
```

Then rewrite `resetTopics` to read the state, not the documents' `Reset` change:

```ts
/** The topics whose document went from synced back to waiting for a checkpoint over `frames`, in order. */
function resetTopics(frames: ReadonlyArray<Frame>) {
  return Effect.reduce(
    frames,
    (): { readonly state: EspnState; readonly topics: ReadonlyArray<string> } => ({
      state: EspnState.empty,
      topics: []
    }),
    ({ state, topics }, frame) =>
      Effect.map(state.take(frame), ([next]) => ({ state: next, topics: [...topics, ...lostBetween(state, next)] }))
  ).pipe(Effect.map(({ topics }) => topics))
}

/** Each topic synced in `before` that is not in `after`, by name. */
function lostBetween(before: EspnState, after: EspnState): ReadonlyArray<string> {
  return [...HashMap.keys(before.documents)]
    .filter(
      (topic) =>
        FastCastDocument.isSynced(before.documents, topic) && !FastCastDocument.isSynced(after.documents, topic)
    )
    .map(tcOf)
}
```

Imports: `import { EspnState } from "./EspnState.ts"`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/EspnState.test.ts`
Expected: FAIL. `wanted` and `isSynced` don't exist, and the lost-document log is missing.

- [ ] **Step 3: `FastCastDocument` exports `isSynced` and stops exporting `scoreboard` and `unchanged`**

Delete `scoreboard`, and make `unchanged` a private `function`. Add, after `empty`:

```ts
/** Whether `topic`'s document is synced: its checkpoint read, and every message since applied. */
export function isSynced(documents: Documents, topic: Topic): boolean {
  return Option.exists(HashMap.get(documents, topic), Document.$is("Synced"))
}
```

`Change.Reset` stays: `EspnState` reads it to log why a topic lost its document.

- [ ] **Step 4: `EspnState` gives what FastCast should follow, and logs a lost document**

Add the method to the class, after `games`:

```ts
  /**
   * What FastCast follows at `now`: each of `leagues`' scoreboard topics, and the topic of each listed game live or
   * kicking off within `GameSnapshot.kickoffWindow`, each with whether its document is synced.
   */
  wanted(leagues: ReadonlyArray<LeagueId>, now: DateTime.Utc): Wanted {
    const scoreboards = leagues.map((league) => Topic.Scoreboard({ league }))
    const games = this.games()
      .filter((game) => game.isLiveOrKicksOffWithin(GameSnapshot.kickoffWindow, now))
      .map((game) => Topic.Game({ league: game.league, game: game.id }))
    return HashMap.fromIterable(
      [...scoreboards, ...games].map(
        (topic) => [topic, FastCastDocument.isSynced(this.documents, topic) ? "Synced" : "AwaitingCheckpoint"] as const
      )
    )
  }
```

In `pushed`, the `Reset` case becomes:

```ts
      Reset: ({ topic, detail }) =>
        Effect.logWarning(`EspnState: ${tcOf(topic)} lost its document (${detail}); FastCast follows it again`).pipe(
          Effect.annotateLogs({ topic: tcOf(topic) }),
          Effect.as([advanced, noDeliveries] as const)
        )
```

Imports:
- `import { Game, GameSnapshot } from "@sportal/domain/Game"`; `GameSnapshot` is now a value import.
- `import { Array as Arr, Data, type DateTime, Effect, HashMap, Option, Record } from "effect"`
- `import type { Wanted } from "./FastCast.ts"`
- `import { Topic, tcOf } from "./Topic.ts"`

The `type` import of `FastCast.ts` is erased, so there is no runtime cycle with `FastCast.ts`, which never imports
`EspnState`.

- [ ] **Step 5: Run the state tests**

Run: `pnpm --filter @sportal/hub exec vitest run src/provider/espn/EspnState.test.ts`
Expected: PASS, once Step 6's `Wanted` export exists. Do Step 6's type export first if the typechecker stops here.

- [ ] **Step 6: Rewrite `FastCast.ts`**

Replace the file. The metrics at its end, `CheckpointUnread`, `checkpointTimeout`, `decodeEnvelope`, `silence`,
`silent`, `failed`, `stopped`, `websocketHost`, and `framed`/`checkpoint` from Task 1 stay as they are, except where
this step shows them.

```ts
import {
  type Cause,
  Channel,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  FiberMap,
  HashMap,
  HashSet,
  Layer,
  Metric,
  Option,
  Queue,
  Record,
  Ref,
  Result,
  Schedule,
  Schema,
  Sink,
  Stream
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import * as HubStopping from "../../HubStopping.ts"
import * as FastCastMessage from "./FastCastMessage.ts"
import { Frame } from "./Frame.ts"
import { ProviderUnavailable } from "./ProviderUnavailable.ts"
import { Topic, tcOf, topicOf } from "./Topic.ts"

/**
 * ESPN FastCast as the ESPN provider's push: one socket that follows the topics it is told to, reads a topic's
 * checkpoint again when told its document was lost, and opens again when it closes, ends or goes quiet. Every socket text
 * is a frame, each `H` followed by its checkpoint. A topic whose checkpoint fails is followed again on the checkpoint
 * retry `FastCast.make` is given; `FastCast.layer` gives it `layer`'s own.
 */
export class FastCast extends Context.Service<
  FastCast,
  {
    /**
     * Every socket text and checkpoint, as frames, for as long as it runs, following what `wanted` last said. On each
     * socket it follows every wanted topic, then each topic that becomes wanted, and each whose document goes from synced
     * back to waiting for its checkpoint; it leaves each topic no longer wanted. When the socket closes, ends or goes
     * silent, it reconnects on its backoff and reads `wanted` again. Never fails.
     */
    follow(wanted: Stream.Stream<Wanted>): Stream.Stream<Frame>
  }
>()("sportal/hub/provider/espn/FastCast") {
  /**
   * FastCast following a topic whose checkpoint failed again on `retry.checkpoint`, then leaving it to polling until the
   * socket reconnects, and opening the socket again on `retry.reconnect` after each failure, which it logs and counts by
   * its reason. Once `retry.reconnect` is done, it logs that the live feed stopped and emits nothing more.
   */
  static readonly make = (retry: {
    readonly checkpoint: Schedule.Schedule<unknown, CheckpointUnread>
    readonly reconnect: Schedule.Schedule<unknown, ProviderUnavailable>
  }) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<HttpClient.HttpClient | Socket.WebSocketConstructor>()
      const follow = (wanted: Stream.Stream<Wanted>) =>
        Stream.unwrap(connect(wanted, retry.checkpoint)).pipe(
          Stream.concat(
            Stream.fail(new ProviderUnavailable({ reason: "Closed", cause: "FastCast ended the stream" }))
          ),
          Stream.timeoutOrElse({ duration: silence, orElse: () => Stream.fail(silent()) }),
          Stream.tapError(failed),
          Stream.retry(retry.reconnect),
          Stream.catchCause(stopped),
          Stream.provideContext(context)
        )
      return FastCast.of({ follow })
    })

  /** (doc comment unchanged) */
  static readonly layer: Layer.Layer<FastCast, never, HttpClient.HttpClient | Socket.WebSocketConstructor> =
    Layer.effect(
      FastCast,
      FastCast.make({
        checkpoint: Schedule.spaced("30 seconds").pipe(
          Schedule.setInputType<CheckpointUnread>(),
          Schedule.upTo({ times: 4 })
        ),
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

/** (CheckpointUnread unchanged) */

/**
 * Opens the socket, then follows what `wanted` says, returning the frames that follow, the handshake's first. To follow
 * a topic is to subscribe to it and wait for its checkpoint; one that fails is followed again on `retry`, one follow per
 * topic at a time, and once `retry` is done the topic is left to polling until the socket reconnects.
 */
const connect = Effect.fn("FastCast.connect")(function* (
  wanted: Stream.Stream<Wanted>,
  retry: Schedule.Schedule<unknown, CheckpointUnread>
) {
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
    /* unchanged */
  })

  // Each follow waiting on its topic's checkpoint, by topic; the `H` that answers it completes it.
  const pending = yield* Ref.make(HashMap.empty<Topic, Deferred.Deferred<void, CheckpointUnread>>())
  // The topics left to polling on this socket: nothing follows them until it reconnects.
  const gaveUp = yield* Ref.make(HashSet.empty<Topic>())
  const follows = yield* FiberMap.make<Topic>()

  const attempt = Effect.fnUntraced(function* (topic: Topic) {
    const answered = yield* Deferred.make<void, CheckpointUnread>()
    yield* Ref.update(pending, HashMap.set(topic, answered))
    yield* Queue.offer(outgoing, JSON.stringify({ op: "S", sid, tc: tcOf(topic) }))
    yield* Deferred.await(answered)
  })
  const answer = Effect.fnUntraced(function* (topic: Topic, outcome: Exit.Exit<void, CheckpointUnread>) {
    const waiting = yield* Ref.modify(pending, (all) => [HashMap.get(all, topic), HashMap.remove(all, topic)])
    yield* Effect.forEach(Option.toArray(waiting), (answered) => Deferred.done(answered, outcome), { discard: true })
  })
  const follow = Effect.fnUntraced(function* (topic: Topic) {
    const leftToPolling = yield* Ref.get(gaveUp)
    if (HashSet.has(leftToPolling, topic)) return

    const followed = attempt(topic).pipe(
      Effect.retry(retry),
      Effect.catch((error) =>
        Effect.logWarning(
          `FastCast: ${tcOf(topic)} is left to polling until the socket reconnects; its checkpoint kept failing`,
          error
        ).pipe(Effect.annotateLogs({ topic: tcOf(topic) }), Effect.andThen(Ref.update(gaveUp, HashSet.add(topic))))
      )
    )
    yield* FiberMap.run(follows, topic, followed, { onlyIfMissing: true })
  })
  const steerTo = Steer.$match({
    Follow: ({ topic }) => Effect.logInfo(`FastCast: subscribed to ${tcOf(topic)}`).pipe(Effect.andThen(follow(topic))),
    Leave: ({ topic }) =>
      Effect.logInfo(`FastCast: left ${tcOf(topic)}; its scoreboard shows it neither live nor about to kick off`).pipe(
        Effect.andThen(FiberMap.remove(follows, topic))
      ),
    FollowAgain: ({ topic }) =>
      Effect.logInfo(`FastCast: following ${tcOf(topic)} again from its checkpoint`).pipe(Effect.andThen(follow(topic)))
  })
  const steer = (one: Steer) =>
    Metric.update(Metric.withAttributes(steersTaken, { steer: one._tag }), 1).pipe(Effect.andThen(steerTo(one)))

  yield* Metric.update(connected, 1)
  yield* Effect.addFinalizer(() =>
    Metric.update(connected, 0).pipe(Effect.andThen(Metric.update(topicsFollowed, 0)))
  )
  yield* Metric.update(connects, 1)
  yield* Effect.logInfo(`FastCast: connected to ${host.ip}`)

  // From nothing on this socket to what is wanted, then each change after.
  yield* wanted.pipe(
    Stream.mapAccum(
      (): Wanted => HashMap.empty(),
      (previous, next) => [next, [{ next, steers: steersBetween(previous, next) }]] as const
    ),
    Stream.runForEach(({ next, steers }) =>
      Metric.update(topicsFollowed, [...HashMap.keys(next)].filter(Topic.$is("Game")).length).pipe(
        Effect.andThen(Effect.forEach(steers, steer, { discard: true }))
      )
    ),
    Effect.forkScoped
  )

  return Stream.concat(Stream.make(opened), rest).pipe(
    Stream.mapEffect((text) => framed(text, answer)),
    Stream.flattenIterable
  )
})

/** One turn of the socket: follow a topic, leave it, or follow again a topic whose document was lost. */
type Steer = Data.TaggedEnum<{
  Follow: { readonly topic: Topic }
  Leave: { readonly topic: Topic }
  FollowAgain: { readonly topic: Topic }
}>
const Steer = Data.taggedEnum<Steer>()

/**
 * How to steer the socket from following `previous` to `next`: follow each topic newly wanted, leave each no longer
 * wanted, and follow again each whose document went from synced back to waiting for its checkpoint.
 */
function steersBetween(previous: Wanted, next: Wanted): ReadonlyArray<Steer> {
  const followed = [...HashMap.keys(next)]
    .filter((topic) => !HashMap.has(previous, topic))
    .map((topic) => Steer.Follow({ topic }))
  const left = [...HashMap.keys(previous)]
    .filter((topic) => !HashMap.has(next, topic))
    .map((topic) => Steer.Leave({ topic }))
  const lost = [...HashMap.entries(next)]
    .filter(
      ([topic, document]) =>
        document === "AwaitingCheckpoint" && Option.exists(HashMap.get(previous, topic), (had) => had === "Synced")
    )
    .map(([topic]) => Steer.FollowAgain({ topic }))
  return [...followed, ...left, ...lost]
}
```

`framed` takes `answer` in place of `published`:

```ts
const framed = Effect.fnUntraced(function* (
  text: string,
  answer: (topic: Topic, outcome: Exit.Exit<void, CheckpointUnread>) => Effect.Effect<void>
) {
  // …unchanged down to the checkpoint…
  const loaded = yield* checkpoint(topic.value, message.pl).pipe(Effect.result)
  if (Result.isSuccess(loaded)) {
    yield* answer(topic.value, Exit.void)
    return [frame, Frame.Checkpoint({ topic: topic.value, mid: message.mid, body: loaded.success })]
  }

  const error = loaded.failure
  yield* Effect.logWarning(/* unchanged */)
  yield* Metric.update(Metric.withAttributes(checkpointFailures, Record.getSomes({ league })), 1)
  yield* answer(topic.value, Exit.fail(error))
  return [frame]
})
```

Its doc comment's last sentences: "Either way the `H`'s outcome answers the follow waiting on its topic, if any; a
checkpoint that fails is logged and counted, and only its `H` is framed."

Update the `topicsFollowed` metric description to "Game topics the live feed is told to follow, beside each league's
scoreboard; 0 while it is not subscribed". Its id stays.

Deleted: `Following`, `steered`, `followedAt`, `topicOfFrame`, the `PubSub`, and the imports of `GameSnapshot`,
`LeagueId`, `HubConfig`, `EspnDecoder`, `FastCastDocument`, `DateTime`, `PubSub` and `Array as Arr`.

- [ ] **Step 7: `EspnProvider` tells FastCast what to follow**

In the layer, replace `pushes`:

```ts
    // What FastCast follows, read again on each change and once a minute, so a kickoff coming into its window is
    // followed with no frame to say so.
    const wanted = Stream.merge(
      SubscriptionRef.changes(state),
      Stream.tick("1 minute").pipe(Stream.mapEffect(() => SubscriptionRef.get(state)))
    ).pipe(
      Stream.mapEffect((current) => Effect.map(DateTime.now, (now) => current.wanted(leagues, now))),
      Stream.changesWith(Equal.equals)
    )
    const pushes = fastCast.follow(wanted).pipe(Stream.mapEffect(taken))
```

Add `Equal` to the `effect` import. In the layer's doc comment, add: "It tells FastCast to follow every league's
scoreboard topic and each listed game live or within 30 minutes of kickoff."

`Espn.ts`'s layer type is unchanged; `EspnProvider` still needs `HubConfig`.

- [ ] **Step 8: Rewrite `FastCast.test.ts` around a wanted set the test controls**

Replace `nflFrames` and `framesOver`:

```ts
/** The NFL's scoreboard topic, and a game's. */
const scoreboard = Topic.Scoreboard({ league: "nfl" })
const gameOf = (game: string) => Topic.Game({ league: "nfl", game: GameId.make(game) })

/** A wanted set of `entries`. */
function wantedOf(...entries: ReadonlyArray<readonly [Topic, "Synced" | "AwaitingCheckpoint"]>): Wanted {
  return HashMap.fromIterable(entries)
}

/**
 * Runs FastCast's frames over `server` in a fiber of its own, told to follow the NFL's scoreboard until `want` says
 * otherwise, collecting them into `frames` and completing `ended` if they ever end.
 */
function nflFrames(server: ReturnType<typeof fakeServer>, retry?: Parameters<typeof FastCast.make>[0]) {
  return framesOver(fastCastHost(server), retry)
}

function framesOver(
  host: Layer.Layer<HttpClient.HttpClient | Socket.WebSocketConstructor>,
  retry?: Parameters<typeof FastCast.make>[0]
) {
  const fastCast = retry === undefined ? FastCast.layer : Layer.effect(FastCast, FastCast.make(retry))
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
    const want = (...entries: ReadonlyArray<readonly [Topic, "Synced" | "AwaitingCheckpoint"]>) =>
      SubscriptionRef.set(wanted, wantedOf(...entries))
    return { ended, frames, want }
  }).pipe(Effect.provide(fastCast.pipe(Layer.provide(host))))
}
```

Imports:
- Add `GameId` from `@sportal/domain/Game`; `HashMap` and `SubscriptionRef` from `effect`;
  `import { FastCast, type Wanted } from "./FastCast.ts"`; `import { Topic, tcOf } from "./Topic.ts"`.
- Drop `HubConfig` and `DateTime` if unused.

Each test below keeps its body except where it's described. "Same" means unchanged.

| Old test | New test |
|---|---|
| should connect, then subscribe to its league's scoreboard topic | same |
| should keep the socket open on FastCast's own heartbeats | same |
| should reconnect after the socket closes | same |
| should count a failed live feed by its reason | same |
| should keep running when the socket goes silent | same |
| should log that the live feed stopped… | same |
| should emit each socket text as a message frame, and an H's checkpoint after it | same; drop its "the checkpoint's live games are subscribed to after it" comment |
| should time a checkpoint it loads | same |
| should give a patch's frame its mid | same |
| should follow a game's topic once its scoreboard shows it live | **should follow a topic once it is wanted** (below) |
| should follow a game's topic from 30 minutes before kickoff | moves to `EspnState#wanted` ("…from 30 minutes before its kickoff", "…a second before…") and `EspnProvider` ("should want a game's topic once its kickoff is 30 minutes away, with no frame") |
| should not follow a game's topic again while its scoreboard still shows it live | **should not follow a topic again while it stays wanted** (below) |
| should leave a game's topic when its scoreboard shows it final | **should leave a topic no longer wanted, saying so** (below); its "a gap on a topic it left reads no checkpoint again" assertion goes with FastCast's own gap reading |
| should count each socket text by its op and its topic's league | same |
| should count a socket text of an unknown op as unknown | same |
| should gauge one topic followed once a game's scoreboard shows it live | **should gauge one game topic followed once one is wanted** (below) |
| should gauge no topic followed once the followed game's scoreboard shows it final | **should gauge no game topic followed, and count the leave, once none is wanted** (below) |
| should count a topic followed again after its document reset | **should count a topic followed again once its document goes back to waiting for its checkpoint** (below) |
| should keep the socket and the other topics when a checkpoint does not load… | same, with `twoGamesFollowed` below |
| should subscribe a topic whose checkpoint did not load again after 30 s… | same |
| should read a topic's checkpoint again after a gap | **should follow a topic again once its document goes back to waiting for its checkpoint, and only once while it waits** (below) |
| should read a topic's checkpoint again after a message that will not apply | carried by `EspnState#take` "should send a topic back to waiting for a checkpoint when a patch will not apply" and the new FastCast test above |
| should wait up to 20 s for a checkpoint | same |
| should fail a checkpoint that hangs for 20 s as Unloaded… | same |
| should not follow a topic whose checkpoint hung again before the Schedule says | same |
| should follow a topic whose checkpoint hung again when the Schedule says… | same |
| should emit only the H of a checkpoint that does not decode… | same |
| should follow a topic whose checkpoint did not decode again after 30 s | same |
| should send no second S for a gap on a topic already due to be followed again | **should send no second S for a topic whose document is lost again while its follow waits to retry**, with `dueToBeFollowedAgain` below |
| should follow a topic that had a gap while due to be followed again only once more | **should follow a topic whose document was lost again while its follow waited only once more**, with `dueToBeFollowedAgain` below |
| should keep one subscription pending at a time for a topic whose checkpoints keep failing | same |
| should leave a topic to polling once the Schedule is done… | same name; body below |
| FastCast reconnect (five tests) | same |
| — | **should follow every wanted topic again on a new socket** (new) |
| — | **should follow a topic left to polling again once the socket reconnects** (new) |

New and changed bodies:

```ts
  it.effect("should follow a topic once it is wanted", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, want } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* want([scoreboard, "AwaitingCheckpoint"], [gameOf(laterGame), "AwaitingCheckpoint"])

      yield* server.sent.until(subscribed(gameTopic(laterGame), 1))
      assert.deepStrictEqual(gameTopicsSent(server), [{ op: "S", sid: "sid-1", tc: gameTopic(laterGame) }])
    })
  )

  it.effect("should not follow a topic again while it stays wanted", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, want } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* want([scoreboard, "AwaitingCheckpoint"], [gameOf(firstGame), "AwaitingCheckpoint"])
      yield* server.sent.until(subscribed(gameTopic(firstGame), 1))

      yield* want([scoreboard, "AwaitingCheckpoint"], [gameOf(firstGame), "AwaitingCheckpoint"])
      yield* want(
        [scoreboard, "AwaitingCheckpoint"],
        [gameOf(firstGame), "AwaitingCheckpoint"],
        [gameOf(secondGame), "AwaitingCheckpoint"]
      )

      // Wanted sets are taken in order, so once the third has subscribed, the second has sent all it would.
      yield* server.sent.until(subscribed(gameTopic(secondGame), 1))
      assert.deepStrictEqual(
        gameTopicsSent(server).map((frame) => frame.tc),
        [gameTopic(firstGame), gameTopic(secondGame)],
        "the same topic wanted again sends none"
      )
    })
  )

  it.effect("should leave a topic no longer wanted, saying so", () =>
    Effect.gen(function* () {
      const { logs, layer } = recordingLogs()
      const server = fakeServer()
      const { frames, want } = yield* nflFrames(server).pipe(Effect.provide(layer))
      yield* frames.until(atLeast(2))
      yield* want([scoreboard, "AwaitingCheckpoint"], [gameOf(firstGame), "AwaitingCheckpoint"])
      yield* server.sent.until(subscribed(gameTopic(firstGame), 1))

      yield* want([scoreboard, "AwaitingCheckpoint"])
      yield* TestClock.adjust("1 second")

      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S" && frame.tc === gameTopic(firstGame)),
        1
      )
      assert.isTrue(
        logs.some((log) => log.level === "Info" && log.message.includes(`left ${gameTopic(firstGame)}`))
      )
    })
  )

  it.effect("should gauge one game topic followed once one is wanted", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, want } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))

      yield* want([scoreboard, "AwaitingCheckpoint"], [gameOf(firstGame), "AwaitingCheckpoint"])

      yield* server.sent.until(subscribed(gameTopic(firstGame), 1))
      const topics = yield* gauged("sportal_live_feed_topics")
      assert.strictEqual(topics, 1)
    }).pipe(withMetrics)
  )

  it.effect("should gauge no game topic followed, and count the leave, once none is wanted", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, want } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* want([scoreboard, "AwaitingCheckpoint"], [gameOf(firstGame), "AwaitingCheckpoint"])
      yield* server.sent.until(subscribed(gameTopic(firstGame), 1))

      yield* want([scoreboard, "AwaitingCheckpoint"])
      yield* TestClock.adjust("1 second")

      const topics = yield* gauged("sportal_live_feed_topics")
      const leaves = yield* counted("sportal_live_feed_steers", { steer: "Leave" })
      assert.strictEqual(topics, 0)
      assert.strictEqual(leaves, 1)
    }).pipe(withMetrics)
  )

  it.effect("should count a topic followed again once its document goes back to waiting for its checkpoint", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, want } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(scoreboardShowing(7)))
      yield* frames.until(wholeAt(7))
      yield* want([scoreboard, "Synced"])

      yield* want([scoreboard, "AwaitingCheckpoint"])

      yield* server.sent.until(subscribed("event-football-nfl", 2))
      const followedAgain = yield* counted("sportal_live_feed_steers", { steer: "FollowAgain" })
      assert.strictEqual(followedAgain, 1)
    }).pipe(withMetrics)
  )

  it.effect(
    "should follow a topic again once its document goes back to waiting for its checkpoint, and only once while it waits",
    () =>
      Effect.gen(function* () {
        const server = fakeServer()
        const { frames, want } = yield* nflFrames(server)
        yield* frames.until(atLeast(2))
        yield* Effect.sync(() => server.send(scoreboardShowing(7)))
        yield* frames.until(wholeAt(7))
        yield* want([scoreboard, "Synced"])

        yield* want([scoreboard, "AwaitingCheckpoint"])
        yield* server.sent.until(subscribed("event-football-nfl", 2))
        yield* want([scoreboard, "AwaitingCheckpoint"])
        yield* Effect.sync(() => server.send(scoreboardShowing(20)))
        yield* frames.until(wholeAt(20))

        assert.deepStrictEqual(
          server.sent.all().filter((frame) => frame.op === "S"),
          [
            { op: "S", sid: "sid-1", tc: "event-football-nfl" },
            { op: "S", sid: "sid-1", tc: "event-football-nfl" }
          ]
        )
      })
  )

  it.effect("should follow every wanted topic again on a new socket", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames, want } = yield* nflFrames(server)
      yield* frames.until(atLeast(2))
      yield* want([scoreboard, "Synced"], [gameOf(firstGame), "Synced"])
      yield* server.sent.until(subscribed(gameTopic(firstGame), 1))

      yield* Effect.sync(() => server.close(1000))
      yield* TestClock.adjust("2 seconds")

      yield* server.sent.until(subscribed(gameTopic(firstGame), 2))
      assert.lengthOf(
        server.sent.all().filter((frame) => frame.op === "S" && frame.tc === "event-football-nfl"),
        2
      )
    })
  )

  it.effect("should follow a topic left to polling again once the socket reconnects", () =>
    Effect.gen(function* () {
      const server = fakeServer()
      const { frames } = yield* nflFrames(server, {
        checkpoint: Schedule.recurs(1),
        reconnect: Schedule.spaced("1 second")
      })
      yield* frames.until(atLeast(2))
      yield* Effect.sync(() => server.send(missingCheckpoint(1)))
      yield* server.sent.until(subscribed("event-football-nfl", 2))
      yield* Effect.sync(() => server.send(missingCheckpoint(2)))
      yield* frames.until(numbered(2))

      yield* Effect.sync(() => server.close(1000))
      yield* TestClock.adjust("2 seconds")

      yield* server.sent.until(subscribed("event-football-nfl", 3))
    })
  )
```

The last test needs no assertion of its own beyond the wait: it fails by timing out if the third `S` never comes.
If the suite's lint rejects a test with no `assert`, end it with
`assert.lengthOf(connectsSent(server), 2)`.

"should leave a topic to polling once the Schedule is done…" becomes:

```ts
  it.effect(
    "should leave a topic to polling once the Schedule is done, saying so once, and not subscribe it again until the socket reconnects",
    () =>
      Effect.gen(function* () {
        const { logs, layer } = recordingLogs()
        const server = fakeServer()
        const { frames, want } = yield* nflFrames(server, {
          checkpoint: Schedule.recurs(1),
          reconnect: Schedule.spaced("1 second")
        }).pipe(Effect.provide(layer))
        yield* frames.until(atLeast(2))
        yield* Effect.sync(() => server.send(missingCheckpoint(1)))
        yield* server.sent.until(subscribed("event-football-nfl", 2))

        yield* Effect.sync(() => server.send(missingCheckpoint(2)))
        yield* frames.until(numbered(2))
        // A checkpoint FastCast sends unasked syncs the topic; then its document is lost.
        yield* Effect.sync(() => server.send(scoreboardShowing(3)))
        yield* frames.until(wholeAt(3))
        yield* want([scoreboard, "Synced"])
        yield* want([scoreboard, "AwaitingCheckpoint"])
        yield* TestClock.adjust("1 minute")

        const gaveUp = logs.filter((log) => log.message.includes("left to polling"))
        assert.lengthOf(
          server.sent.all().filter((frame) => frame.op === "S"),
          2
        )
        assert.lengthOf(gaveUp, 1)
        assert.strictEqual(gaveUp[0]?.level, "Warn")
      })
  )
```

`twoGamesFollowed` becomes:

```ts
function twoGamesFollowed(server: ReturnType<typeof fakeServer>, logged: Layer.Layer<never>) {
  return Effect.gen(function* () {
    const following = yield* nflFrames(server).pipe(Effect.provide(logged))

    yield* following.frames.until(atLeast(2))
    yield* following.want(
      [scoreboard, "AwaitingCheckpoint"],
      [gameOf(firstGame), "AwaitingCheckpoint"],
      [gameOf(secondGame), "AwaitingCheckpoint"]
    )
    yield* server.sent.until(subscribed(otherTopic, 1))
    return following
  })
}
```

`dueToBeFollowedAgain` drives the same story through `want`:

```ts
/**
 * NFL frames once the scoreboard topic is due to be followed again: synced at 7, its document lost so it is
 * subscribed to again, that subscription's checkpoint at 10 missing, then a checkpoint at 11 FastCast sent unasked,
 * which synced it.
 */
function dueToBeFollowedAgain(server: ReturnType<typeof fakeServer>) {
  return Effect.gen(function* () {
    const following = yield* nflFrames(server)

    yield* following.frames.until(atLeast(2))
    yield* Effect.sync(() => server.send(scoreboardShowing(7)))
    yield* following.frames.until(wholeAt(7))
    yield* following.want([scoreboard, "Synced"])
    yield* following.want([scoreboard, "AwaitingCheckpoint"])
    yield* server.sent.until(subscribed("event-football-nfl", 2))
    yield* Effect.sync(() => server.send(missingCheckpoint(10)))
    yield* following.frames.until(numbered(10))
    yield* Effect.sync(() => server.send(scoreboardShowing(11)))
    yield* following.frames.until(wholeAt(11))
    yield* following.want([scoreboard, "Synced"])
    return following
  })
}
```

In both tests that use it, the line `yield* Effect.sync(() => server.send(patchMessage(13)))` then
`yield* frames.until(numbered(13))` becomes `yield* want([scoreboard, "AwaitingCheckpoint"])`. Destructure `want` beside
`frames`.

`scoreboardShowing` stays, since it still names a checkpoint URL. Delete `stateOf`, `clockOf`, `eventUid`,
`gameCheckpoint` and `patchMessage` wherever nothing uses them any more; the linter flags unused functions.

- [ ] **Step 9: Update the provider tests for `follow`**

In `EspnProvider.test.ts`:
- `espnOver` passes `FastCast.layerTest(() => options.pushing ?? Stream.never)`.
- Add a `wanting?: (wanted: Stream.Stream<Wanted>) => Stream.Stream<Frame>` option, which `espnOver` uses in place of
  `() => pushing` when given.

Then append inside `describe("EspnProvider.deliveries", …)`:

```ts
  it.effect("should tell FastCast to follow every league's scoreboard topic from the start", () =>
    Effect.gen(function* () {
      const told = yield* toldOver(recordedHttp(fbsLive), "fbs", [])

      const [first] = told
      assert.deepStrictEqual(
        first === undefined ? [] : [...HashMap.entries(first)],
        [[Topic.Scoreboard({ league: "fbs" }), "AwaitingCheckpoint"]]
      )
    })
  )

  it.effect("should want a game's topic once its kickoff is 30 minutes away, with no frame", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.makeUnsafe("2026-10-03T12:00:00Z").epochMilliseconds)
      const later = scoreboardOf([{ state: "pre", period: 0, kickoff: "2026-10-03T12:31Z" }])
      const [event] = decodeEventIds(later).events
      const game = Topic.Game({ league: "fbs", game: event.id })
      const answering = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(later)))
      )

      const told = yield* toldOver(answering, "fbs", ["1 minute"])

      assert.isFalse(told.slice(0, -1).some((one) => HashMap.has(one, game)), "31 minutes out, it is not followed")
      assert.isTrue(Option.exists(Arr.last(told), (one) => HashMap.has(one, game)))
    })
  )
```

Add these helpers below `polledOver`:

```ts
/**
 * Each wanted set ESPN's provider over `client`, polling `leagues`, tells FastCast as the test clock moves by each of
 * `spans`.
 */
function toldOver(client: HttpClient.HttpClient, leagues: string, spans: ReadonlyArray<Duration.Input>) {
  return Effect.gen(function* () {
    const told = yield* Ref.make<ReadonlyArray<Wanted>>([])
    const espn = espnOver(client, {
      leagues,
      wanting: (wanted) =>
        wanted.pipe(
          Stream.tap((one) => Ref.update(told, (all) => [...all, one])),
          Stream.drain
        )
    })

    yield* Effect.gen(function* () {
      const provider = yield* Provider
      yield* provider.deliveries.pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
      yield* TestClock.adjust(0)
      yield* Effect.forEach(spans, (span) => TestClock.adjust(span), { discard: true })
    }).pipe(Effect.provide(espn), Effect.scoped)

    return yield* Ref.get(told)
  })
}

const decodeEventIds = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ events: Schema.Tuple([Schema.Struct({ id: GameId })]) }))
)
```

Imports: `GameId` from `@sportal/domain/Game` (beside `Network`); `HashMap` from `effect`;
`import { FastCast, type Wanted } from "./FastCast.ts"`.

- [ ] **Step 10: Add the glossary row and update the steer rows**

In `CONTEXT.md`, after **ESPN state**:

```
| **Wanted topics** | What the live feed is told to follow: each league's scoreboard topic and the topic of each listed game live or within 30 minutes of kickoff, each with whether its document is synced or waits for its checkpoint; `Wanted` in code, beside `FastCast`, which `EspnState#wanted` gives. FastCast follows each newly wanted topic and each whose document goes from synced back to waiting, and leaves each no longer wanted. | subscriptions, follows |
```

Replace the **Checkpoint unread** row's "then the topic is left to polling until the socket reconnects" with "then its
follow ends and the topic is left to polling until the socket reconnects".

- [ ] **Step 11: Run the whole check**

Run: `pnpm check`
Expected: PASS. In particular:
- `knip --production` finds no unused export: `FastCastDocument.scoreboard` is gone, and `EspnDecoder.gamesOf` is
  still used by `EspnState`.
- `Espn.test.ts` passes. `noSocket` throws on open, so the stream retries quietly as before.

- [ ] **Step 12: Commit**

```bash
git add -A apps/hub/src/provider CONTEXT.md
git commit -m "refactor: FastCast follows the topics EspnState wants

FastCast.follow(wanted) reconciles each socket toward a wanted set: it
follows each newly wanted topic and each whose document went from synced
back to waiting, and leaves each no longer wanted. A follow waits on a
Deferred its H completes, and one whose checkpoint retry runs out ends,
leaving its topic to polling until the socket reconnects. FastCast no longer
folds or decodes; EspnState#wanted says what it follows, and logs why a
topic lost its document. FastCast no longer needs HubConfig.

FastCast.test.ts:
- \"should follow a game's topic once its scoreboard shows it live\" -> \"should follow a topic once it is wanted\"; \"its scoreboard shows it live\" -> EspnState#wanted \"should want a listed game's topic while it is live\"
- \"should follow a game's topic from 30 minutes before kickoff\" -> EspnState#wanted \"should want a listed game's topic from 30 minutes before its kickoff\", \"should not want a listed game's topic a second before 30 minutes before its kickoff\"; EspnProvider \"should want a game's topic once its kickoff is 30 minutes away, with no frame\"
- \"should not follow a game's topic again while its scoreboard still shows it live\" -> \"should not follow a topic again while it stays wanted\"
- \"should leave a game's topic when its scoreboard shows it final\" -> \"should leave a topic no longer wanted, saying so\"; EspnState#wanted \"should not want the topic of a game a push shows over\"; its gap assertion goes with FastCast's own gap reading
- \"should gauge one topic followed once a game's scoreboard shows it live\" -> \"should gauge one game topic followed once one is wanted\"
- \"should gauge no topic followed once the followed game's scoreboard shows it final\" -> \"should gauge no game topic followed, and count the leave, once none is wanted\"
- \"should count a topic followed again after its document reset\" -> \"should count a topic followed again once its document goes back to waiting for its checkpoint\"
- \"should read a topic's checkpoint again after a gap\" -> \"should follow a topic again once its document goes back to waiting for its checkpoint, and only once while it waits\"; the gap itself -> EspnState#take \"should reset a topic's document, once, after a gap\"
- \"should read a topic's checkpoint again after a message that will not apply\" -> EspnState#take \"should send a topic back to waiting for a checkpoint when a patch will not apply\", and the FastCast test above
- \"should send no second S for a gap on a topic already due to be followed again\" -> \"should send no second S for a topic whose document is lost again while its follow waits to retry\"
- \"should follow a topic that had a gap while due to be followed again only once more\" -> \"should follow a topic whose document was lost again while its follow waited only once more\"
- every other test keeps its name and assertions
EspnState.test.ts: resetTopics reads the state's documents; every test keeps its assertions.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs

**Files:**
- Modify: `CONTEXT.md`, `docs/technical-spec.md`, `docs/game-day-checklist.md`
- Create: `docs/adr/0014-one-espn-fold.md`

- [ ] **Step 1: `CONTEXT.md`**

Edit or remove these rows:
- **Delivery source**: delete the row; grep `Delivery source` and `delivery source` in `CONTEXT.md` and `docs/` and
  reword each use as "a polled or a pushed frame".
- **Topic owner**: replace with
  `| **Topic** | A live feed topic: one league's scoreboard, or one game's package; \`Topic\` in code, in \`Topic.ts\`, read from FastCast's \`tc\` once where it arrives (\`topicOf\`), and named for it by \`tcOf\`. | subscription, owner, channel |`
- **Frame**: replace with
  `| **Frame** | One thing ESPN delivered, as received, before its decode reads it: a poll's response (\`Polled\`, its league's whole scoreboard), a socket text (\`Pushed\`, with its topic and mid when it names them), or the checkpoint an \`H\` pointed to (\`Checkpoint\`, a topic's whole document as of its mid); \`Frame\` in code. | message, payload, feed frame |`
- **Provider**: its "reads each frame it receives with its own decode" stays.

- [ ] **Step 2: `docs/technical-spec.md`**

- In the source tree:
  - Replace the `EspnDecoder.ts` line with
    `EspnDecoder.ts      Each league's decode of an event, a play and a scoreboard`.
  - Add `EspnState.ts        The one fold of ESPN's frames: deliveries, listed games, the topics FastCast follows`.
  - Replace `FastCastTopic.ts` with `Topic.ts            A FastCast topic, read once from its \`tc\``.
  - `FastCast.ts`'s line becomes
    `ESPN's push, a service: follows the topics it is told to, and gives the socket as frames`.
  - `EspnProvider.ts`'s becomes
    `Implements the port: polls each league, folds every frame into one EspnState, tells FastCast what to follow`.
- In **Provider**, the second bullet's ``ESPN's decode (`EspnDecoder.decode`)`` becomes ``ESPN's fold (`EspnState#take`)``.
- The third bullet becomes:
  "ESPN's cadence is `EspnProvider`'s: after each poll it waits by every game its `EspnState` lists, each moved forward
  by every push, about every 10 seconds while any game is live, every minute near kickoff, every 15 minutes otherwise.
  FastCast (`docs/adr/0007-fastcast-live-feed.md`, `docs/adr/0014-one-espn-fold.md`) is the service its push reads
  from: it follows the topics `EspnState#wanted` names (every scoreboard, and each listed game live or near kickoff),
  follows a topic again when its document goes back to waiting for its checkpoint, and retries its socket on a
  jittered exponential backoff."
- In **Director**, the second bullet: "…and gauges each game whose snapshot changed…" becomes "…and, from the slate
  changes each take gives, gauges each game whose snapshot changed…".
- In **5.2**, the FastCast bullet becomes:
  "A FastCast topic that loses its document (a missed message, a patch that will not apply) is a Warning log from
  `EspnState`, and the push follows the topic again from its checkpoint, counted as a `FollowAgain` on
  `sportal_live_feed_steers`. FastCast also counts every socket text by op and league (`sportal_live_feed_received`)
  and gauges the game topics it is told to follow (`sportal_live_feed_topics`)."
- Grep for `EspnDecoder.decode`, `FastCastTopic`, `ownerOf` and `Owner` across `docs/` (except `history.md`, plans
  and specs) and fix each.

- [ ] **Step 3: `docs/game-day-checklist.md` row 46**

Its expected column becomes:
"An `EspnState: <topic> lost its document (…); FastCast follows it again` Warning is logged, then
`FastCast: following <topic> again from its checkpoint` (Info). The socket re-sends `S` for that topic and a fresh `H`
(checkpoint) arrives. Checkpoint failures on the Hub dashboard does not rise (it counts only checkpoints that fail to
load or decode; each topic is followed again every 30 s, five tries in all, then left to polling), and the game's
plays carry on. Unverified live: if no `H` comes back, record it."

- [ ] **Step 4: Write `docs/adr/0014-one-espn-fold.md`**

```markdown
# 14. One ESPN fold; FastCast follows what it is told

Date: 2026-10-09
Status: Accepted

Amends ADR 0007 (the FastCast live feed).

## Context

ESPN's frames were folded four times. The poll's schedule kept the games each scoreboard last showed, to pace the next
poll. ESPN's decode kept each league's listing and every FastCast document, to decode pushes. FastCast folded the same
documents again, and decoded the scoreboards again, to decide which game topics to follow. The slate held the result.
Polling and steering answered "what is live or about to kick off" from separate states that could disagree, and every
pushed frame was patched twice.

## Decision

- **One fold.** `EspnState` holds each topic's document and each league's listed games, moved forward by every push.
  `EspnProvider` keeps it in one `SubscriptionRef` and takes every polled and pushed frame into it once. Deliveries,
  the wait after each poll, and the topics FastCast follows are all read from it.
- **FastCast follows what it is told.** `FastCast.follow(wanted)` reconciles each socket toward the wanted set. It
  follows each topic newly wanted and each whose document went from synced back to waiting for its checkpoint, and
  leaves each no longer wanted. It no longer decodes anything.
- **Typed at the edge.** Frames (`Polled`, `Pushed`, `Checkpoint`) and topics (`Scoreboard`, `Game`) are tagged
  enums, read once where they arrive.

## Consequences

- A push that shows a game live paces the next poll's wait. A poll lagging a push does not set the pushed game back in
  the listing (`Game#listed`'s rule).
- FastCast follows only games a poll has listed; before the first poll it follows only the scoreboards.
- A lost document is logged by the fold, which knows why; FastCast logs only that it follows the topic again.
- FastCast no longer needs `HubConfig`: the wanted set carries the scoreboards.
```

- [ ] **Step 5: Run the check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add CONTEXT.md docs/technical-spec.md docs/game-day-checklist.md docs/adr/0014-one-espn-fold.md
git commit -m "docs: one ESPN fold, FastCast follows what it is told (ADR 0014)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Game day (the user runs this)

Not for a subagent. On the next live game day, run `pnpm dev` from the worktree and check:

- [ ] Game topics are followed from 30 minutes before kickoff (`FastCast: subscribed to gp-…`) and left at final
  (`FastCast: left gp-…`).
- [ ] Polling drops to 10 s while a game is live (the Hub dashboard's poll panel, or the poll spans).
- [ ] Checklist row 46: cut the network briefly. Expect the `EspnState … lost its document` Warning, then
  `FastCast: following … again`, then a fresh `H`.
- [ ] The Hub dashboard's live-feed panels (topics followed, steers, checkpoints) read as before.
- [ ] The strip shows scores and recent plays as before.
