# Each Display owns its Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Hub publishes the slate with each game's availability from every source; each Display owns, applies, refreshes, and keeps its own Screen; the Remote is parked.

**Architecture:** `ChannelAvailability` becomes a wire union. Every `Source` answers a list (one answer per source), and `mostUseful` moves into `Screen`. The Director publishes `SlateChanged` with `{ game, availability }` entries and holds no Screen. The web app's `screen` atom (`apps/web/src/screen/DisplayScreen.ts`) applies commands locally, refreshes on each slate, and is backed by `Atom.kvs` over `localStorage`. `Screen.ts` moves into `apps/web/src/screen/`.

**Tech Stack:** Effect 4 (`Schema`, `Stream`, `SubscriptionRef`, `effect/reactivity` `Atom`, `effect/persistence` `KeyValueStore`), React with `@effect/atom-react`, Vitest with `@effect/vitest`.

**Spec:** `docs/specs/2026-10-09-display-owns-screen-design.md`

## Global Constraints

- Read `AGENTS.md` first. Every rule there applies (module shapes, file order, one `yield*` per line, test style, commit bodies).
- `pnpm check` passes before every commit.
- A wire union is `Schema.TaggedUnion` with `X.cases.Y.make`, `X.match`, `X.guards` — never `$match`/`$is`.
- Rewriting a test keeps every assertion unless its behaviour was removed. The commit body lists, per rewritten test file, each old test name → the new test names carrying its assertions, or the removed behaviour it went with.
- The localStorage line carries exactly: `// TODO(Chase): fix this once persistence layers are added`
- No new glossary term for "availability": it is a game's availability, a list of `ChannelAvailability`, one per source.
- Comments only where the why is unclear; doc comments on exports.

## File map

| File | Change |
|---|---|
| `packages/domain/src/Channel.ts` | `ChannelAvailability` → `Schema.TaggedUnion` (Task 1) |
| `packages/domain/src/Guide.ts`, `Guide.test.ts` | call sites (Task 1) |
| `apps/hub/src/source/Source.ts`, `Source.test.ts` | answers are a list; `mostUseful` leaves (Task 2) |
| `packages/domain/src/Screen.ts` → `apps/web/src/screen/Screen.ts` | takes lists, picks most useful (Task 2); moves (Task 6) |
| `packages/domain/src/TestScreen.ts` → `apps/web/src/screen/TestScreen.ts` | merges with web's `TestScreen.ts` (Task 6) |
| `packages/api/src/LiveMessage.ts` | `SlateChanged` entries (Task 3); `ScreenChanged` goes (Task 6) |
| `apps/hub/src/Slate.ts`, `Slate.test.ts` | `published(availabilityOf)` (Task 3) |
| `apps/hub/src/Director.ts`, `Director.test.ts` | `published` stream (Task 3); Screen goes (Task 6) |
| `apps/hub/src/HubServer.ts`, `HubServer.test.ts` | live stream from `published` (Task 3); `addresses` goes (Task 4); `screen` goes (Task 6) |
| `packages/api/src/SportalApi.ts` | `addresses` goes (Task 4); `screen` group goes (Task 6) |
| `apps/web/src/remote/` | deleted (Task 4) |
| `apps/web/src/hub/LiveStream.ts` | keeps availability (Task 3); drops screen (Task 5) |
| `apps/web/src/screen/DisplayScreen.ts` | new: `screen` and `rejected` atoms (Task 5) |
| `apps/web/src/hub/HubClient.ts` | loses `hostAddresses` (Task 4), `dispatch`/`screenFailures` (Task 5) |
| `docs/adr/0015-each-display-owns-its-screen.md`, `CONTEXT.md`, `AGENTS.md`, `docs/technical-spec.md` | Task 7 |

---

### Task 1: `ChannelAvailability` is a wire union

**Files:**
- Modify: `packages/domain/src/Channel.ts`
- Modify (call sites): `packages/domain/src/Guide.ts`, `packages/domain/src/Guide.test.ts`, `packages/domain/src/Screen.ts`, `packages/domain/src/Screen.test.ts`, `packages/domain/src/TestScreen.ts`, `apps/hub/src/source/Source.ts`, `apps/hub/src/source/Source.test.ts`, `apps/hub/src/source/GuideReader.test.ts`, `apps/hub/src/Director.ts`, `apps/hub/src/Director.test.ts`, and any other file `grep -rln ChannelAvailability apps packages` lists

**Interfaces:**
- Produces: `ChannelAvailability` (schema and type). Construct with `ChannelAvailability.cases.Carried.make({ channel })`, `.cases.Upcoming.make({ channel, begin })`, `.cases.NoGuide.make({ source })`, `.cases.NotCarried.make({ why })`; read with `ChannelAvailability.match(value, {...})` and `ChannelAvailability.guards.Carried(value)`.

This is a pure refactor: no behaviour changes, so no new test. The existing suite is the test.

- [ ] **Step 1: Replace the type in `Channel.ts`**

Replace the `ChannelAvailability` doc comment, type and const with:

```ts
/**
 * Whether and where a source can show one game: carried, upcoming (its airing is still to come, or past what
 * the guide lists), not carried with why, or no guide (the source has no fresh guide to say).
 */
export const ChannelAvailability = Schema.TaggedUnion({
  Carried: { channel: Channel },
  Upcoming: {
    channel: Schema.OptionFromOptionalKey(Schema.String),
    begin: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString)
  },
  NoGuide: { source: SourceName },
  NotCarried: { why: Schema.Literals(["NoStream", "StreamingOnly", "NotInGuide"]) }
})
export type ChannelAvailability = typeof ChannelAvailability.Type
```

The import line becomes `import { Schema } from "effect"`.

- [ ] **Step 2: Update every call site mechanically**

Run `pnpm typecheck` and fix each error with exactly these rewrites:

| Before | After |
|---|---|
| `ChannelAvailability.Carried({ … })` | `ChannelAvailability.cases.Carried.make({ … })` |
| `ChannelAvailability.Upcoming({ … })` | `ChannelAvailability.cases.Upcoming.make({ … })` |
| `ChannelAvailability.NoGuide({ … })` | `ChannelAvailability.cases.NoGuide.make({ … })` |
| `ChannelAvailability.NotCarried({ … })` | `ChannelAvailability.cases.NotCarried.make({ … })` |
| `ChannelAvailability.$match(x, { … })` | `ChannelAvailability.match(x, { … })` |
| `ChannelAvailability.$is("Carried")(x)` | `ChannelAvailability.guards.Carried(x)` |

Example from `packages/domain/src/Guide.ts`:

```ts
      return ChannelAvailability.cases.Upcoming.make({ channel: Option.none(), begin: Option.none() })
```

- [ ] **Step 3: Run the checks**

Run: `pnpm check`
Expected: PASS. If a `deepStrictEqual` fails because a value was built by `Data.taggedEnum` somewhere you missed, `grep -rn "ChannelAvailability\.\(Carried\|Upcoming\|NoGuide\|NotCarried\|\\\$\)" apps packages` shows the remaining sites.

- [ ] **Step 4: Commit**

```bash
git add -A packages apps
git commit -m "refactor: ChannelAvailability is a wire union, so it can go on the live stream"
```

---

### Task 2: every source answers, and the Screen picks the most useful

**Files:**
- Modify: `apps/hub/src/source/Source.ts`
- Modify: `packages/domain/src/Screen.ts`, `packages/domain/src/TestScreen.ts`
- Modify: `apps/hub/src/Director.ts`
- Test: `packages/domain/src/Screen.test.ts`, `apps/hub/src/source/Source.test.ts`, `apps/hub/src/Director.test.ts`

**Interfaces:**
- Consumes: Task 1's `ChannelAvailability`.
- Produces:
  - `Source["Service"]["availability"]: Effect.Effect<(game: GameSnapshot) => ReadonlyArray<ChannelAvailability>>` — one answer per source, in `layerAll` order.
  - `Source.layerTest(availabilityOf: (game: GameSnapshot) => ChannelAvailability, changes?)` is unchanged in its signature; it answers `[availabilityOf(game)]`.
  - `Screen#apply(command: ScreenCommand, availabilityOf: (game: GameId) => ReadonlyArray<ChannelAvailability>): Result.Result<Screen, ScreenRejection>`
  - `Screen#refresh(availabilityOf: (game: GameId) => Option.Option<ReadonlyArray<ChannelAvailability>>): Screen`
  - `TestScreen.onFox(): ReadonlyArray<ChannelAvailability>`, `TestScreen.nowhere(): ReadonlyArray<ChannelAvailability>`, `TestScreen.assign(screen, tile, game, availabilityOf: () => ReadonlyArray<ChannelAvailability>)`

- [ ] **Step 1: Write the failing Screen tests**

In `packages/domain/src/Screen.test.ts`, add to `describe("Screen#apply")`. These carry the six `Source.layerAll` "should answer … over …" assertions, moved here with the choosing:

```ts
  it("should assign a later source's carried game over an earlier source's not carried as a stream tile", () => {
    const screen = assign(Screen.initial, 0, bama, () => [streamingOnly, onTwitch])

    assert.deepStrictEqual(screen.tiles[0], { _tag: "StreamTile", game: bama, channel: twitchChannel })
  })

  it("should assign a carried game over an upcoming one as a stream tile", () => {
    const screen = assign(Screen.initial, 0, bama, () => [upcomingOnPrime, onTwitch])

    assert.deepStrictEqual(screen.tiles[0], { _tag: "StreamTile", game: bama, channel: twitchChannel })
  })

  it("should assign upcoming on a named channel over upcoming with nothing known", () => {
    const screen = assign(Screen.initial, 0, bama, () => [...unknownUpcoming(), upcomingOnPrime])

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: bama,
      why: { _tag: "NotYet", channel: Option.some("Prime Video"), begin: Option.some(primeBegin) }
    })
  })

  it("should assign upcoming over no guide", () => {
    const screen = assign(Screen.initial, 0, bama, () => [...noGuide(), ...unknownUpcoming()])

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: bama,
      why: { _tag: "NotYet", channel: Option.none(), begin: Option.none() }
    })
  })

  it("should assign no guide over not carried", () => {
    const screen = assign(Screen.initial, 0, bama, () => [streamingOnly, ...noGuide()])

    assert.deepStrictEqual(screen.tiles[0], {
      _tag: "DataTile",
      game: bama,
      why: { _tag: "NoGuide", source: "YouTube TV" }
    })
  })

  it("should assign streaming only over not in the guide", () => {
    const screen = assign(Screen.initial, 0, bama, () => [notInGuide, streamingOnly])

    assert.deepStrictEqual(screen.tiles[0], { _tag: "DataTile", game: bama, why: { _tag: "StreamingOnly" } })
  })

  it("should assign a game no source answers for as a data tile with no stream", () => {
    const screen = assign(Screen.initial, 0, bama, () => [])

    assert.deepStrictEqual(screen.tiles[0], { _tag: "DataTile", game: bama, why: { _tag: "NoStream" } })
  })
```

Add to `describe("Screen#refresh")`:

```ts
  it("should keep a stream tile when its own source no longer carries it but another source does", () => {
    const streaming = assign(Screen.initial, 0, bama, onFox)

    const refreshed = streaming.refresh(() => Option.some([...noGuide(), onTwitch]))

    assert.deepStrictEqual(refreshed.tiles[0], streaming.tiles[0])
  })

  it("should move a stream tile when its own source carries it elsewhere, whatever other sources say", () => {
    const streaming = assign(Screen.initial, 0, bama, onFox)

    const moved = streaming.refresh(() => Option.some([onTwitch, ChannelAvailability.cases.Carried.make({ channel: fox43 })]))

    assert.deepStrictEqual(moved.tiles[0], { _tag: "StreamTile", game: bama, channel: fox43 })
  })
```

Add these beside the file's other module-level values (below the tests, with `channel` and `tiles`):

```ts
const twitchChannel = {
  name: "Prime Video",
  source: "Twitch" as const,
  locator: { _tag: "WebView" as const, url: "https://player.twitch.tv/?channel=primevideo" }
}
const onTwitch = ChannelAvailability.cases.Carried.make({ channel: twitchChannel })
const primeBegin = DateTime.makeUnsafe("2026-10-04T00:15:00Z")
const upcomingOnPrime = ChannelAvailability.cases.Upcoming.make({
  channel: Option.some("Prime Video"),
  begin: Option.some(primeBegin)
})
const streamingOnly = ChannelAvailability.cases.NotCarried.make({ why: "StreamingOnly" })
const notInGuide = ChannelAvailability.cases.NotCarried.make({ why: "NotInGuide" })
const fox43 = {
  ...foxChannel,
  name: "FOX 43",
  locator: { ...foxChannel.locator, url: "https://tv.youtube.com/watch/fox43" }
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run packages/domain/src/Screen.test.ts`
Expected: FAIL — type errors (`assign` takes `() => ChannelAvailability`), so the file does not compile.

- [ ] **Step 3: Make `Screen` take lists and choose**

In `packages/domain/src/Screen.ts`:

1. `apply`'s doc and signature:

```ts
  /**
   * Applies a command. `availabilityOf` gives every source's answer for a game: a game is assigned as the most
   * useful of them says, a carried game as a stream tile and any other as a data tile.
   */
  apply(
    command: ScreenCommand,
    availabilityOf: (game: GameId) => ReadonlyArray<ChannelAvailability>
  ): Result.Result<Screen, ScreenRejection> {
```

The `Assign` case is unchanged (`tileFor(game, availabilityOf(game))`).

2. `refresh`'s doc and signature (body unchanged):

```ts
  /**
   * Re-resolves every occupied tile, on screen and benched, after what a source knows has changed. A game
   * `availabilityOf` knows nothing about keeps its tile as it was: the change did not concern it.
   *
   * A stream tile is replaced only when its own source carries its game on another channel. Any other answer
   * (another source carrying it, a game running past its listing, no guide, a failed or stale read) never stops
   * it. Every other occupied tile becomes what the most useful answer says. When no tile changes, it is this Screen.
   */
  refresh(availabilityOf: (game: GameId) => Option.Option<ReadonlyArray<ChannelAvailability>>): Screen {
```

3. Replace `tileFor` with:

```ts
function tileFor(game: GameId, availability: ReadonlyArray<ChannelAvailability>): Tile {
  return ChannelAvailability.match(mostUseful(availability), {
    Carried: ({ channel }): Tile => ({ _tag: "StreamTile", game, channel }),
    Upcoming: ({ channel, begin }): Tile => ({
      _tag: "DataTile",
      game,
      why: { _tag: "NotYet", channel, begin }
    }),
    NoGuide: ({ source }): Tile => ({ _tag: "DataTile", game, why: { _tag: "NoGuide", source } }),
    NotCarried: ({ why }): Tile => ({ _tag: "DataTile", game, why: { _tag: why } })
  })
}

/** The answer that says most of several: ties go to the first, and no answer at all is no stream. */
function mostUseful(availability: ReadonlyArray<ChannelAvailability>): ChannelAvailability {
  return Arr.reduce<ChannelAvailability, ChannelAvailability>(
    availability,
    ChannelAvailability.cases.NotCarried.make({ why: "NoStream" }),
    (best, answer) => (usefulness(answer) > usefulness(best) ? answer : best)
  )
}

/**
 * How much an answer tells: carried; upcoming on a known channel; upcoming with nothing known; no guide (it may yet be
 * carried); streaming only; not in the guide; no stream.
 */
function usefulness(answer: ChannelAvailability): number {
  return ChannelAvailability.match(answer, {
    Carried: () => 6,
    Upcoming: ({ channel }) => (Option.isSome(channel) ? 5 : 4),
    NoGuide: () => 3,
    NotCarried: ({ why }) => (why === "StreamingOnly" ? 2 : why === "NotInGuide" ? 1 : 0)
  })
}
```

4. Replace `keepsStream` with:

```ts
/**
 * Whether a stream tile stays as it is: only its own source carrying its game on another channel replaces it. A tile
 * never moves to another source.
 */
function keepsStream(tile: Occupied, availability: ReadonlyArray<ChannelAvailability>): boolean {
  return (
    Tile.guards.StreamTile(tile) &&
    !availability.some(
      (answer) =>
        ChannelAvailability.guards.Carried(answer) &&
        answer.channel.source === tile.channel.source &&
        answer.channel.locator.url !== tile.channel.locator.url
    )
  )
}
```

5. In `packages/domain/src/TestScreen.ts`:

```ts
/** Every game is carried on FOX. */
export function onFox(): ReadonlyArray<ChannelAvailability> {
  return [ChannelAvailability.cases.Carried.make({ channel: foxChannel })]
}

/** No game has a stream. */
export function nowhere(): ReadonlyArray<ChannelAvailability> {
  return [ChannelAvailability.cases.NotCarried.make({ why: "NoStream" })]
}

/** `screen` with `game` assigned to `tile`, its channel from `availabilityOf`. */
export function assign(
  screen: Screen,
  tile: number,
  game: GameId,
  availabilityOf: () => ReadonlyArray<ChannelAvailability>
) {
  return Result.getOrThrow(screen.apply({ _tag: "Assign", tile, game }, availabilityOf))
}
```

6. In `Screen.test.ts`, bring the existing tests to lists:
   - `const noGuide = () => [ChannelAvailability.cases.NoGuide.make({ source: "YouTube TV" })]`
   - `unknownUpcoming()` returns `[ChannelAvailability.cases.Upcoming.make({ channel: Option.none(), begin: Option.none() })]`
   - `some(availability: () => ReadonlyArray<ChannelAvailability>)` keeps its body.
   - Each inline `() => ChannelAvailability.cases.X.make(…)` passed to `assign` or `some` is wrapped in an array: `() => [ChannelAvailability.cases.X.make(…)]`.
   - The `it.each` "should keep a stream tile playing on the answer %s": make every row a list — `noGuide()`, `nowhere()`, `onFox()` already are; wrap the three inline rows as `[ChannelAvailability.cases.X.make(…)]` — and the body passes it straight through: `streaming.refresh(() => Option.some(answer))`.
   - `refresh(() => Option.some(noGuide()))` stays as written.

- [ ] **Step 4: Make every `Source` answer a list**

In `apps/hub/src/source/Source.ts`:

- The port member:

```ts
    /** Whether and where it can show a game, as of now: one answer from each source it stands for, in order. */
    readonly availability: Effect.Effect<(game: GameSnapshot) => ReadonlyArray<ChannelAvailability>>
```

- `layerYouTubeTv` returns `(game: GameSnapshot) => [Option.match(latest, { … })]` — wrap the existing `Option.match` expression in an array literal.
- `layerTwitch` returns `(game: GameSnapshot) => [Twitch.lineup.availabilityOf(game, now)]`.
- `layerAll`: doc becomes "Every source given, as one: for each game every source's answer, in the order given, and a change whenever any of them changes." Its availability returns `(game: GameSnapshot) => answers.flatMap((availabilityOf) => availabilityOf(game))`.
- `layerTest` returns `Effect.succeed((game: GameSnapshot) => [availabilityOf(game)])`; doc: "A source answering `availabilityOf` for every game, which changes whenever `changes` emits."
- Delete `mostUseful` and `usefulness`, and any import only they used (`Array as Arr`, maybe `Option`).

- [ ] **Step 5: Bring the Director along**

In `apps/hub/src/Director.ts`, `availabilityOnSlate` returns `(id: GameId): Option.Option<ReadonlyArray<ChannelAvailability>> => Option.map(current.game(id), ({ snapshot }) => availabilityOf(snapshot))`, and `dispatch` passes `(id) => Option.getOrElse(availabilityOf(id), () => [])`. `ChannelAvailability` becomes a type-only import.

- [ ] **Step 6: Bring the Source and Director tests along**

`apps/hub/src/source/Source.test.ts`:
- A single source's assertion compares against a one-element list: e.g. `assert.deepStrictEqual(availabilityOf(onEspn), [ChannelAvailability.cases.NoGuide.make({ source: "YouTube TV" })])`, and `[onPrimeVideo]` for `Source.layerTwitch`.
- `tallied` loops: `for (const answer of availabilityOf(game)) ChannelAvailability.match(answer, { … })`.
- Delete the six "should answer … over …" tests and `answerOf` (their assertions moved to `Screen.test.ts` in Step 1). Add:

```ts
  it.effect("should give every source's answer, in the order given", () =>
    Effect.gen(function* () {
      const all = Source.layerAll([Source.layerTest(() => streamingOnly), Source.layerTest(() => carried("Twitch"))])

      const answers = yield* Source.use((source) => source.availability).pipe(
        Effect.map((availabilityOf) => availabilityOf(thursdayNight)),
        Effect.provide(all)
      )

      assert.deepStrictEqual(answers, [streamingOnly, carried("Twitch")])
    })
  )
```

- "should carry Thursday's Prime Video game on Twitch while YouTube TV has no guide" becomes "should answer no guide from YouTube TV and carried from Twitch for Thursday's Prime Video game", asserting `[ChannelAvailability.cases.NoGuide.make({ source: "YouTube TV" }), onPrimeVideo]`.
- "should carry a Prime Video game on Twitch over YouTube TV's streaming only" becomes "should answer YouTube TV's streaming only and Twitch's carried for a Prime Video game", asserting `[ChannelAvailability.cases.NotCarried.make({ why: "StreamingOnly" }), onPrimeVideo]`.
- Unused `upcomingOn`, `upcomingUnknown`, `noGuide`, `notInGuide` consts in that `describe` go (keep `notInGuide` if the "should change whenever any of its sources changes" test still uses it).

`apps/hub/src/Director.test.ts`:
- The hand-built YouTube TV `Source.of` in "should keep a stream tile on Twitch when YouTube TV's guide then carries its game" returns `() => [carries ? ChannelAvailability.cases.Carried.make({ channel: primeOnYouTubeTv }) : streamingOnly]`.
- "should keep a guide-matched tile playing when its guide goes stale" asserts `availability(ohioStateAtIowa)` equals `[ChannelAvailability.cases.NoGuide.make({ source: "YouTube TV" })]`.

- [ ] **Step 7: Run the checks**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 8: Commit**

Body lists, for `Source.test.ts`: each of the six "should answer … over …" tests → the matching new `Screen#apply` test name; the two Thursday tests → their new names; and for `Screen.test.ts`, that its tests now pass lists.

```bash
git add -A packages apps
git commit -m "refactor: every source answers for a game, and the Screen picks the most useful

<the test name mapping>"
```

---

### Task 3: the Hub publishes each game's availability

**Files:**
- Modify: `packages/api/src/LiveMessage.ts`, `packages/api/src/LiveMessage.test.ts`
- Modify: `apps/hub/src/Slate.ts`, `apps/hub/src/Slate.test.ts`
- Modify: `apps/hub/src/Director.ts`, `apps/hub/src/Director.test.ts`
- Modify: `apps/hub/src/HubServer.ts`, `apps/hub/src/HubServer.test.ts`
- Modify: `apps/web/src/hub/LiveStream.ts`, `apps/web/src/hub/LiveStream.test.ts`

**Interfaces:**
- Consumes: Task 2's `Source["Service"]["availability"]`.
- Produces:
  - `LiveMessage.cases.SlateChanged`: `{ games: ReadonlyArray<{ game: Game; availability: ReadonlyArray<ChannelAvailability> }> }`
  - `Slate#published(availabilityOf: (game: GameSnapshot) => ReadonlyArray<ChannelAvailability>): SlateChanged`
  - `Director["Service"]["published"]: Stream.Stream<SlateChanged>` — the latest first, then each change of the slate or of any game's availability; replaces `slateChanges`.
  - Web `Live.availability: ReadonlyMap<GameId, ReadonlyArray<ChannelAvailability>>`, beside `Live.slate: ReadonlyArray<Game>`.

- [ ] **Step 1: Write the failing tests**

`apps/hub/src/Slate.test.ts`, in `describe("Slate#published")` (existing tests: call `slate.published(noAnswers)` and read `({ game }) => game.snapshot.id`, `games[0]?.game.plays`), add:

```ts
  it("should put every source's answer for each game beside it", () => {
    const slate = listed([liveSnapshot({ id: GameId.make("1") })])

    const { games } = slate.published(() => [streamingOnly])

    assert.deepStrictEqual(games[0]?.availability, [streamingOnly])
  })
```

with `const noAnswers = () => []` and `const streamingOnly = ChannelAvailability.cases.NotCarried.make({ why: "StreamingOnly" })` at module level. Use the file's existing way of building a slate from a listing in place of `listed` if it names it differently.

`apps/hub/src/Director.test.ts`: rename `describe("Director#slateChanges")` to `describe("Director#published")`; both tests read `director.published`, and the first records `snapshotOf(current, one)`:

```ts
/** Game `id`'s snapshot in a published slate, if it is there. */
function snapshotOf(message: SlateChanged, id: GameId) {
  return message.games.find(({ game }) => game.snapshot.id === id)?.game.snapshot
}
```

Add to that `describe`:

```ts
  it.live("should publish again when a source's answers change", () =>
    Effect.gen(function* () {
      const pulses = yield* Queue.unbounded<void>()
      const carries = yield* Ref.make(false)
      const youTubeTv = Layer.succeed(
        Source,
        Source.of({
          availability: Ref.get(carries).pipe(
            Effect.map((on) => () => [on ? ChannelAvailability.cases.Carried.make({ channel: primeOnYouTubeTv }) : streamingOnly])
          ),
          changes: Stream.fromQueue(pulses)
        })
      )

      const availability = yield* Effect.gen(function* () {
        const director = yield* Director
        yield* Ref.set(carries, true)
        yield* Queue.offer(pulses, undefined)

        const message = yield* director.published.pipe(
          Stream.filter(({ games }) => games.some(({ availability }) => availability.some(ChannelAvailability.guards.Carried))),
          Stream.runHead,
          Effect.timeout("2 seconds")
        )
        return Option.map(message, ({ games }) => games[0]?.availability)
      }).pipe(Effect.provide(listed(games).pipe(Layer.provideMerge(directorOver), Layer.provideMerge(youTubeTv))))

      assert.deepStrictEqual(availability, Option.some([ChannelAvailability.cases.Carried.make({ channel: primeOnYouTubeTv })]))
    })
  )

  it.live("should publish nothing when a source's change changes no answer", () =>
    Effect.gen(function* () {
      const pulses = yield* Queue.unbounded<void>()
      const answering = Source.layerTest(() => streamingOnly, Stream.fromQueue(pulses))

      const next = yield* Effect.gen(function* () {
        const director = yield* Director
        const waiting = yield* director.published.pipe(
          Stream.drop(1),
          Stream.runHead,
          Effect.timeoutOption("200 millis"),
          Effect.forkScoped
        )
        yield* Effect.yieldNow

        yield* Queue.offer(pulses, undefined)

        return yield* Fiber.join(waiting)
      }).pipe(Effect.provide(listed(games).pipe(Layer.provideMerge(directorOver), Layer.provideMerge(answering))))

      assert.isTrue(Option.isNone(next))
    })
  )
```

If `listed` delivers after the first `published` value is taken, the drop-one in the second test can see the listing as a change: make the test wait for a published message with games (`Stream.filter(({ games }) => games.length > 0)`) before forking the waiter, and drop nothing.

`apps/hub/src/HubServer.test.ts`:
- "should stream the current slate and screen first …": the plays check reads `message.games.map(({ game }) => game.plays)`.
- "should send a burst of slate changes once, when it settles": `message.games.map(({ game }) => game.snapshot.period)`.
- "should send each listed game as its snapshot and plays, and nothing else the slate remembers" becomes "should send each listed game as its snapshot and plays, beside its availability, and nothing else the slate remembers":

```ts
        const [entry] = JSON.parse(line.slice("data: ".length)).games
        assert.strictEqual(entry.game.snapshot.id, game.id)
        assert.deepStrictEqual(Object.keys(entry), ["game", "availability"])
        assert.deepStrictEqual(Object.keys(entry.game), ["snapshot", "plays"])
        assert.deepStrictEqual(entry.availability, [{ _tag: "NoGuide", source: "YouTube TV" }])
        assert.notMatch(line, /"state"|"updatedAt"|"from"/)
```

- Add to `describe("GET /api/live")`:

```ts
  it.live("should send the slate again when a guide read carries its game", () =>
    Effect.gen(function* () {
      const client = yield* makeClient
      yield* firstSlate()
      const lines = yield* pastInitialMessages()
      const now = yield* DateTime.now

      yield* client.guide.read({ payload: { guide: realSizedGuideAiring(now) } })
      const line = yield* Queue.take(lines).pipe(
        Effect.repeat({ until: (line) => line.includes("SlateChanged") && line.includes("Carried") }),
        Effect.timeout("3 seconds")
      )

      const message = messageOf(line)
      assert.deepStrictEqual(
        LiveMessage.guards.SlateChanged(message) ? message.games[0]?.availability : message,
        [
          ChannelAvailability.cases.Carried.make({
            channel: {
              name: "ESPN",
              source: "YouTube TV",
              locator: { _tag: "WebView", url: "https://tv.youtube.com/watch/PFuNFGzJDE4?vp=0gEEEgIwAQ%3D%3D" }
            }
          })
        ]
      )
    }).pipe(Effect.scoped, Effect.provide(serverUnderTest()))
  )
```

`apps/web/src/hub/LiveStream.test.ts`:
- "should keep the plays each game of a slate message carries …": the message is `{ _tag: "SlateChanged", games: [{ game, availability: [] }] }`; `state.slate` stays a list of `Game`.
- "should replace the screen and the slate from their messages": `games: []` is unchanged.
- Add:

```ts
  it.effect("should keep each game's availability from a slate message, by its id", () =>
    Effect.gen(function* () {
      const source = yield* opened()
      const game = new Game({ snapshot: snapshot({ id: GameId.make("401") }), plays: [] })
      const availability = [ChannelAvailability.cases.NotCarried.make({ why: "StreamingOnly" })]

      source.onmessage?.({ data: message({ _tag: "SlateChanged", games: [{ game, availability }] }) })
      const state = yield* until((current) => current.slate.length > 0)

      assert.deepStrictEqual(state.availability.get(GameId.make("401")), availability)
    }).pipe(Effect.provide(AtomRegistry.layer))
  )
```

`packages/api/src/LiveMessage.test.ts`: the `SlateChanged` encode test is unchanged (`games: []`).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/hub/src/Slate.test.ts apps/hub/src/Director.test.ts apps/hub/src/HubServer.test.ts apps/web/src/hub/LiveStream.test.ts`
Expected: FAIL — `published` takes no argument, `director.published` does not exist, entries have no `game` key, `Live` has no `availability`.

- [ ] **Step 3: Implement**

`packages/api/src/LiveMessage.ts`:

```ts
import { ChannelAvailability } from "@sportal/domain/Channel"
import { Game } from "@sportal/domain/Game"
import { Screen } from "@sportal/domain/Screen"
import { Schema } from "effect"

/** A message on the live stream at GET /api/live, sent as one JSON object per server-sent event. */
export const LiveMessage = Schema.TaggedUnion({
  /** Every listed game, each beside every source's answer for where it can be streamed. */
  SlateChanged: {
    games: Schema.Array(Schema.Struct({ game: Game, availability: Schema.Array(ChannelAvailability) }))
  },
  ScreenChanged: { screen: Screen }
})
```

`apps/hub/src/Slate.ts`:

```ts
  /** What the live stream sends of it: every listed game, with its recent plays, beside `availabilityOf` it. */
  published(availabilityOf: (game: GameSnapshot) => ReadonlyArray<ChannelAvailability>): SlateChanged {
    const games = this.games.map((game) => ({ game: game.recent(), availability: availabilityOf(game.snapshot) }))
    return LiveMessage.cases.SlateChanged.make({ games })
  }
```

(import `type ChannelAvailability` from `@sportal/domain/Channel`.)

`apps/hub/src/Director.ts`:
- Interface: replace `slateChanges` with

```ts
    /**
     * The slate as the live stream sends it, beside each game's availability: the latest first, then again whenever
     * the slate or any game's availability changes.
     */
    readonly published: Stream.Stream<SlateChanged>
```

- In the layer, before `return Director.of(…)`:

```ts
      // The slate whenever it changes, and again whenever the source's answers may have.
      const slateOrAnswers = Stream.merge(
        SubscriptionRef.changes(slate),
        source.changes.pipe(Stream.mapEffect(() => SubscriptionRef.get(slate)))
      )
      const published = slateOrAnswers.pipe(
        Stream.mapEffect((current) =>
          Effect.map(source.availability, (availabilityOf) => current.published(availabilityOf))
        ),
        Stream.changesWith(samePublished)
      )
```

and `published` in `Director.of({ … })` in place of `slateChanges`. At the end of the file, before the metric:

```ts
const samePublished = Schema.toEquivalence(LiveMessage.cases.SlateChanged)
```

(imports: `LiveMessage, type SlateChanged` from `@sportal/api/LiveMessage`; `Schema` from `effect`.) Update the class doc's first sentence to say it offers the slate, as published with each game's availability, and the Screen.

`apps/hub/src/HubServer.ts`, in `liveRoute`:

```ts
    const slateChanges = director.published.pipe(settled)
```

and the route's doc: "the current slate, each game beside its availability, and the screen, then every change".

`apps/web/src/hub/LiveStream.ts`:

```ts
interface Live {
  readonly connection: Connection
  readonly slate: ReadonlyArray<Game>
  /** Every source's answer for each game on the slate, by its id. */
  readonly availability: ReadonlyMap<GameId, ReadonlyArray<ChannelAvailability>>
  readonly screen: Screen
}

function initial(): Live {
  return { connection: Connection.Connecting(), slate: [], availability: new Map(), screen: Screen.initial }
}
```

and in `received`:

```ts
    SlateChanged: ({ games }): Live => ({
      ...live,
      slate: games.map(({ game }) => game),
      availability: new Map(games.map(({ game, availability }) => [game.snapshot.id, availability]))
    }),
```

(imports: `type ChannelAvailability` from `@sportal/domain/Channel`, `type GameId` from `@sportal/domain/Game`.)

- [ ] **Step 4: Run the checks**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

Body lists, for `Director.test.ts`: "Director#slateChanges should give the latest, then each change once" → "Director#published should give the latest, then each change once"; same for "should give no change for a take that changes nothing"; and the `HubServer.test.ts` rename.

```bash
git add -A packages apps
git commit -m "feat: the live stream sends each game beside every source's answer for it

<the test name mapping>"
```

---

### Task 4: the Remote is parked

**Files:**
- Delete: `apps/web/src/remote/RemoteView.tsx`, `apps/web/src/remote/ScreenMap.tsx`, `apps/web/src/remote/JoinRemote.tsx`
- Modify: `apps/web/src/main.tsx`, `apps/web/src/display/DisplayView.tsx`, `apps/web/src/display/TopBar.tsx`, `apps/web/src/display/Display.ts`, `apps/web/src/display/Display.test.ts`, `apps/web/src/layout/LayoutPicker.tsx`, `apps/web/src/hub/HubClient.ts`, `apps/web/package.json`
- Modify: `packages/api/src/SportalApi.ts`, `apps/hub/src/HubServer.ts`, `apps/hub/src/HubServer.test.ts`

**Interfaces:**
- Produces: `Display#open(overlay: "Keys" | "Palette")`; `SportalApi` `host` group holds only `health`; `LayoutPicker(props: { current: LayoutName })`.

This removes a feature; the test changes are removals.

- [ ] **Step 1: Remove the web side**

- `git rm apps/web/src/remote/*.tsx`
- `apps/web/src/main.tsx`:

```tsx
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { DisplayView } from "./display/DisplayView.tsx"
import "./theme.css"

const root = document.getElementById("root")
if (root === null) throw new Error("index.html has no #root element")

createRoot(root).render(
  <StrictMode>
    <DisplayView />
  </StrictMode>
)
```

- `Display.ts`: `type Overlay = Data.TaggedEnum<{ None: object; Keys: object; Palette: object }>`.
- `Display.test.ts`: the `it.each(["Palette", "JoinRemote"])` Esc test becomes one test, "should close the Palette overlay with Esc and send nothing", with `Display.initial.open("Palette")`; the `{ from: "Palette", to: "JoinRemote" }` row goes; "should close the open overlay" opens `"Palette"`.
- `DisplayView.tsx`: remove the `JoinRemote` import and element, and `onRemote`.
- `TopBar.tsx`: remove `onRemote` from props, the Remote `Button`, and `Smartphone` from the `lucide-react` import.
- `LayoutPicker.tsx`: remove `fill` from props and both `props.fill === true` uses (`className` becomes absent on `ToggleGroup`; the item's `cn(…)` keeps only its first string); doc: "One button per layout, the current one lit; choosing one sends it to the Hub."
- `HubClient.ts`: remove `hostAddresses`.
- `pnpm --filter @sportal/web remove uqr`

- [ ] **Step 2: Remove the Hub side**

- `SportalApi.ts`: the `host` group keeps only `health`; its comment becomes `// Whether the Hub is up.`
- `HubServer.ts`: `addresses` handler, `lanAddresses`, `bridges`, `rank`, and the `node:os` import go.
- `HubServer.test.ts`: the `vi.mock("node:os", …)`, `network`, `Interfaces`, `afterEach`, the "should list the addresses a Remote can reach the Hub at …" test, `describe("HubServer.lanAddresses")`, `v4`, `v6`, and now-unused imports go.

- [ ] **Step 3: Run the checks**

Run: `pnpm check`
Expected: PASS (knip finds nothing unused; if it names another remote-only export, remove it).

- [ ] **Step 4: Commit**

Body lists removed tests with "went with the Remote": the addresses API test, the three `HubServer.lanAddresses` tests, the `JoinRemote` overlay rows.

```bash
git add -A apps packages pnpm-lock.yaml
git commit -m "feat: park the Remote; it comes back with its own design

<the removed tests>"
```

---

### Task 5: the Display owns its Screen

**Files:**
- Create: `apps/web/src/screen/DisplayScreen.ts`, `apps/web/src/screen/DisplayScreen.test.ts`, `apps/web/src/hub/TestLiveStream.ts`
- Modify: `apps/web/src/hub/LiveStream.ts`, `apps/web/src/hub/LiveStream.test.ts`
- Modify: `apps/web/src/hub/HubClient.ts`, delete `apps/web/src/hub/HubClient.test.ts` if only its `dispatch` tests remain
- Modify: `apps/web/src/screen/Rejections.ts`
- Modify (dispatch call sites): `apps/web/src/display/DisplayView.tsx`, `apps/web/src/display/CommandPalette.tsx`, `apps/web/src/layout/LayoutPicker.tsx`, `apps/web/src/screen/TileChrome.tsx`, `apps/web/src/screen/ScreenView.tsx`

**Interfaces:**
- Consumes: Task 3's `Live.availability`; `Screen#apply`/`Screen#refresh` from Task 2.
- Produces:
  - `DisplayScreen.screen: Atom.Writable<Screen, ScreenCommand>` — read for the Screen, write a command to apply it.
  - `DisplayScreen.rejected: Atom.Writable<Option.Option<ScreenRejection>>` — the last refused command's rejection.
  - `TestLiveStream.FakeEventSource`, `TestLiveStream.opened()`, `TestLiveStream.slateMessage(games)` for both test files.
  - `Live` without `screen`.

- [ ] **Step 1: Move the live stream's fake to a Test module**

Create `apps/web/src/hub/TestLiveStream.ts` holding `FakeEventSource`, `eventSource`, and `opened` exactly as they are at the bottom of `LiveStream.test.ts` (export `FakeEventSource` and `opened`), plus:

```ts
/** A slate message's `data`, as the Hub sends it. */
export function slateMessage(
  games: ReadonlyArray<{ game: Game; availability: ReadonlyArray<ChannelAvailability> }>
) {
  return encodeLiveMessage({ _tag: "SlateChanged", games })
}

const encodeLiveMessage = Schema.encodeSync(LiveMessageJson)
```

`LiveStream.test.ts` imports `FakeEventSource` and `opened` from it.

- [ ] **Step 2: Write the failing atom tests**

`apps/web/src/screen/DisplayScreen.test.ts`:

```ts
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { ChannelAvailability } from "@sportal/domain/Channel"
import { Game, GameId } from "@sportal/domain/Game"
import { Screen } from "@sportal/domain/Screen"
import { snapshot } from "@sportal/domain/TestGame"
import { Effect, Option, Schema, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { vi } from "vitest"
import { FakeEventSource, opened, slateMessage } from "../hub/TestLiveStream.ts"
import * as DisplayScreen from "./DisplayScreen.ts"

describe("DisplayScreen.screen", () => {
  beforeEach(() => {
    FakeEventSource.opened = []
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal("localStorage", new MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("should assign a game as the slate's availability says", () =>
    Effect.gen(function* () {
      const source = yield* opened()
      source.onmessage?.({ data: slateMessage([{ game, availability: [onEspn] }]) })
      yield* untilLive((live) => live.slate.length > 0)

      yield* Atom.set(DisplayScreen.screen, { _tag: "Assign", tile: 0, game: id })

      const screen = yield* Atom.get(DisplayScreen.screen)
      assert.deepStrictEqual(screen.tiles[0], { _tag: "StreamTile", game: id, channel: espn })
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should publish a refused command's rejection and keep the Screen", () =>
    Effect.gen(function* () {
      yield* opened()
      const before = yield* Atom.get(DisplayScreen.screen)

      yield* Atom.set(DisplayScreen.screen, { _tag: "Clear", tile: 9 })

      const after = yield* Atom.get(DisplayScreen.screen)
      const rejected = yield* Atom.get(DisplayScreen.rejected)
      assert.strictEqual(after, before)
      assert.deepStrictEqual(Option.map(rejected, ({ reason }) => reason), Option.some("no-such-tile"))
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should refresh a tile when a slate brings its game a stream", () =>
    Effect.gen(function* () {
      const source = yield* opened()
      source.onmessage?.({ data: slateMessage([{ game, availability: [] }]) })
      yield* untilLive((live) => live.slate.length > 0)
      yield* Atom.set(DisplayScreen.screen, { _tag: "Assign", tile: 0, game: id })

      source.onmessage?.({ data: slateMessage([{ game, availability: [onEspn] }]) })
      const screen = yield* untilScreen((screen) => screen.tiles[0]?._tag === "StreamTile")

      assert.deepStrictEqual(screen.tiles[0], { _tag: "StreamTile", game: id, channel: espn })
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should start from the Screen this browser kept", () =>
    Effect.gen(function* () {
      const kept = new Screen({ ...Screen.initial, layout: "Pair" })
      localStorage.setItem("sportal/screen", JSON.stringify(Schema.encodeSync(Screen)(kept)))
      yield* opened()

      const screen = yield* Atom.get(DisplayScreen.screen)

      assert.strictEqual(screen.layout, "Pair")
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should start from the initial Screen when what was kept does not read", () =>
    Effect.gen(function* () {
      localStorage.setItem("sportal/screen", "{not a screen")
      yield* opened()

      const screen = yield* Atom.get(DisplayScreen.screen)

      assert.deepStrictEqual(screen, Screen.initial)
    }).pipe(Effect.provide(AtomRegistry.layer))
  )

  it.effect("should keep each change in this browser", () =>
    Effect.gen(function* () {
      yield* opened()

      yield* Atom.set(DisplayScreen.screen, { _tag: "SetLayout", layout: "Single" })
      yield* untilScreen((screen) => screen.layout === "Single")

      const kept = localStorage.getItem("sportal/screen") ?? ""
      assert.include(kept, '"layout":"Single"')
    }).pipe(Effect.provide(AtomRegistry.layer))
  )
})

const id = GameId.make("401")
const game = new Game({ snapshot: snapshot({ id }), plays: [] })
const espn = {
  name: "ESPN",
  source: "YouTube TV" as const,
  locator: { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/espn" }
}
const onEspn = ChannelAvailability.cases.Carried.make({ channel: espn })

function untilLive(predicate: (live: Atom.Type<typeof LiveStream.live>) => boolean) {
  return Atom.toStream(LiveStream.live).pipe(Stream.filter(predicate), Stream.runHead, Effect.flatMap(Effect.fromOption))
}

function untilScreen(predicate: (screen: Screen) => boolean) {
  return Atom.toStream(DisplayScreen.screen).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption)
  )
}

/** A `Storage` in memory, as a browser's `localStorage` is. */
class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>()
  get length() {
    return this.items.size
  }
  clear() {
    this.items.clear()
  }
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
  setItem(key: string, value: string) {
    this.items.set(key, value)
  }
}
```

(add `import * as LiveStream from "../hub/LiveStream.ts"`). If the atoms' module-level `keepAlive` state leaks between tests, each test's fresh `AtomRegistry.layer` isolates it: atoms hold state per registry.

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm vitest run apps/web/src/screen/DisplayScreen.test.ts`
Expected: FAIL — `./DisplayScreen.ts` does not exist.

- [ ] **Step 4: Write `DisplayScreen.ts`**

```ts
import { Screen, type ScreenCommand, type ScreenRejection } from "@sportal/domain/Screen"
import { Option, Result } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Atom } from "effect/reactivity"
import * as LiveStream from "../hub/LiveStream.ts"

/**
 * This Display's Screen. A screen command written to it is applied against where each game on the live slate can be
 * streamed; one refused is published on `rejected` instead. Each slate the live stream brings refreshes it, and it is
 * kept in this browser, so a reload shows it as it was.
 */
export const screen: Atom.Writable<Screen, ScreenCommand> = Atom.writable(
  (get) => {
    get.subscribe(
      LiveStream.live,
      ({ availability }) => {
        const current = get.once(kept)
        const next = current.refresh((game) => Option.fromNullishOr(availability.get(game)))
        if (next !== current) get.set(kept, next)
      },
      { immediate: true }
    )
    return get(kept)
  },
  (ctx, command: ScreenCommand) => {
    const { availability } = ctx.get(LiveStream.live)
    const result = ctx.get(kept).apply(command, (game) => availability.get(game) ?? [])
    Result.match(result, {
      onSuccess: (next) => ctx.set(kept, next),
      onFailure: (rejection) => ctx.set(rejected, Option.some(rejection))
    })
  }
).pipe(Atom.keepAlive)

/** The last screen command this Display refused, and why; none until one is. */
export const rejected = Atom.make<Option.Option<ScreenRejection>>(Option.none()).pipe(Atom.keepAlive)

// TODO(Chase): fix this once persistence layers are added
const kept = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: "sportal/screen",
  schema: Screen,
  defaultValue: () => Screen.initial
}).pipe(Atom.keepAlive)
```

If `Result.match`'s option names differ in this Effect version, check `node_modules/effect/dist/Result.d.ts` (`match`).

- [ ] **Step 5: Run the atom tests**

Run: `pnpm vitest run apps/web/src/screen/DisplayScreen.test.ts`
Expected: PASS.

- [ ] **Step 6: Take the Screen off the live stream's state**

`LiveStream.ts`: `Live` loses `screen`; `initial()` loses `screen: Screen.initial`; `received` ignores `ScreenChanged` (`ScreenChanged: (): Live => live`) until Task 6 removes the case; the `Screen` import goes; the module doc says the Hub replays the current slate on every connection.

`LiveStream.test.ts`: tests that waited on `state.screen.layout === "Pair"` after a `ScreenChanged` message wait on the slate instead — send `slateMessage([{ game: someGame, availability: [] }])` and wait for `state.slate.length > 0`:
- "should stay connecting after an error before the stream first opens"
- "should publish nothing for an error while connecting or already lost" (`takeUntil((state) => state.slate.length > 0)`)
- "should skip a malformed message and keep reading" (the malformed second message becomes `JSON.stringify({ _tag: "SlateChanged", games: "nope" })`; assert `after.connection` is `before.connection`)
- "should replace the screen and the slate from their messages" becomes "should replace the slate from its message", sending one slate with one game and asserting `state.slate.map(({ snapshot }) => snapshot.id)` is `[GameId.make("401")]`.
Remove `pair` and the `Screen` import.

- [ ] **Step 7: Send every command to the atom**

In each component, take the setter once at the top of the component that sends: `const dispatch = useAtomSet(DisplayScreen.screen)` (import `useAtomSet` from `@effect/atom-react`, `* as DisplayScreen` from `../screen/DisplayScreen.ts` or `./DisplayScreen.ts`), then replace `runtime.runFork(dispatch(X))` with `dispatch(X)`:
- `DisplayView.tsx` `useDisplay`: `for (const command of step.commands) dispatch(command)`; its doc: "… its commands applied to this Display's Screen …". `DisplayView` reads `const screen = useAtomValue(DisplayScreen.screen)` and passes `screen` wherever it passed `live.screen`.
- `CommandPalette.tsx` `run`, `LayoutPicker.tsx` `onValueChange` (doc: "… choosing one applies it."), `TileChrome.tsx` (both sites), `ScreenView.tsx` (the `SetSplit` site; `sendGuide` stays on `runtime`).
- Drop `runtime` and `HubClient` imports a file no longer uses.

- [ ] **Step 8: Toast rejections from the atom**

`apps/web/src/screen/Rejections.ts`:

```ts
import { useAtomSubscribe } from "@effect/atom-react"
import type { ScreenRejection } from "@sportal/domain/Screen"
import { Option } from "effect"
import { toast } from "sonner"
import * as DisplayScreen from "./DisplayScreen.ts"

/** Shows each screen command this Display refused as a warning toast, saying why. */
export function useScreenRejectionToasts() {
  useAtomSubscribe(DisplayScreen.rejected, (rejected) =>
    Option.map(rejected, ({ reason }) => toast.warning(rejectionText[reason]))
  )
}

const rejectionText: Record<ScreenRejection["reason"], string> = {
  "no-such-tile": "There is no tile there.",
  "empty-tile": "That tile is empty.",
  "offscreen-tile": "That game is on the bench. Swap it in first.",
  "split-out-of-range": "Every tile needs some room."
}
```

`DisplayView.tsx` calls `useScreenRejectionToasts()` in place of `useScreenFailureToasts()`.

- [ ] **Step 9: Strip the Hub client**

`HubClient.ts`: the service is `{ api: HttpApiClient.ForApi<typeof SportalApi> }`; `dispatch`, `screenFailures`, the `PubSub` and `HttpClientError`/`ScreenCommand`/`ScreenRejection` imports go; the class doc: "This client's way to the Hub's HTTP API." Delete `HubClient.test.ts` (its two tests went with sending commands to the Hub).

- [ ] **Step 10: Run the checks**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 11: Commit**

Body lists, for `HubClient.test.ts`: both tests → removed with sending commands to the Hub (a local rejection is "DisplayScreen.screen should publish a refused command's rejection and keep the Screen"); for `LiveStream.test.ts`: each rewritten test and "should replace the screen and the slate from their messages" → "should replace the slate from its message".

```bash
git add -A apps
git commit -m "feat: each Display applies, refreshes and keeps its own Screen

<the test name mapping>"
```

---

### Task 6: the Hub holds no Screen

**Files:**
- Move: `packages/domain/src/Screen.ts` → `apps/web/src/screen/Screen.ts`; `packages/domain/src/Screen.test.ts` → `apps/web/src/screen/Screen.test.ts`; `packages/domain/src/TestScreen.ts` merged into `apps/web/src/screen/TestScreen.ts`
- Modify: `apps/hub/src/Director.ts`, `apps/hub/src/Director.test.ts`, `apps/hub/src/HubServer.ts`, `apps/hub/src/HubServer.test.ts`, `packages/api/src/SportalApi.ts`, `packages/api/src/LiveMessage.ts`, `packages/api/src/LiveMessage.test.ts`, `apps/web/src/hub/LiveStream.ts`
- Modify (imports): every `@sportal/domain/Screen` and `@sportal/domain/TestScreen` importer in `apps/web`

**Interfaces:**
- Produces: `Director["Service"]` is `{ slate: Effect.Effect<Slate>; published: Stream.Stream<SlateChanged> }`; `Director.layer: Layer.Layer<Director, never, Provider | Source>`; `LiveMessage` has only `SlateChanged`.

- [ ] **Step 1: Take the Screen out of the Director**

`Director.ts`: remove `screen`, `screenChanges`, `dispatch` from the interface; the `screen` `SubscriptionRef`, `availabilityOnSlate`, `dispatch`, `refresh` and its fork from the layer; the `Screen`, `ScreenCommand`, `ScreenRejection`, `GameId`, `Option` imports it no longer needs. Class doc:

```ts
/**
 * The Hub's one holder of what is going on: the day's slate, taken from each frame its provider decodes as it
 * arrives, and published beside where each game can be streamed now.
 */
```

The layer doc drops its last sentence ("Applies each command … changes.") and gains: "Publishes the slate beside every source's answer for each game whenever either changes."

`Director.test.ts`: delete `describe("Director, the Screen")` and the helpers only it used (`readAtOnce`, `availabilityHeldOnce`, `firstScreenWhere`, `noGuideTile`, `isNoGuideTile`, `directing` if nothing else uses it, `news3Live`, `ohioStateAtIowa`, `primeOnTwitch`, and the `Screen`/`Tile`/`Deferred`/`TestClock` imports if unused). Add to `describe("Director#published")` the two assertions about what availability the Director reads, carried from the removed tests:

```ts
  it.effect("should publish a game the guide carries as carried on its channel", () =>
    Effect.gen(function* () {
      const director = yield* Director
      yield* readRecordedGuide

      const message = yield* director.published.pipe(
        Stream.filter(({ games }) => games.length > 0),
        Stream.runHead,
        Effect.map(Option.getOrThrow)
      )

      assert.deepStrictEqual(message.games.find(({ game }) => game.snapshot.id === ohioStateAtIowa.id)?.availability, [
        ChannelAvailability.cases.Carried.make({
          channel: { name: "News 3", source: "YouTube TV", locator: { _tag: "WebView", url: news3Live } }
        })
      ])
    }).pipe(Effect.provide(directing([ohioStateAtIowa, ...games])))
  )

  it.effect("should publish a game as no guide while the source has read none", () =>
    Effect.gen(function* () {
      const director = yield* Director

      const message = yield* director.published.pipe(
        Stream.filter(({ games }) => games.length > 0),
        Stream.runHead,
        Effect.map(Option.getOrThrow)
      )

      assert.deepStrictEqual(message.games.find(({ game }) => game.snapshot.id === GameId.make("5"))?.availability, [
        ChannelAvailability.cases.NoGuide.make({ source: "YouTube TV" })
      ])
    }).pipe(Effect.provide(directing(games)))
  )
```

(so keep `directing`, `ohioStateAtIowa`, `news3Live` for these.)

- [ ] **Step 2: Take the Screen out of the API and live stream**

- `SportalApi.ts`: delete the `screen` group and its imports.
- `LiveMessage.ts`: delete `ScreenChanged` and the `Screen` import.
- `LiveMessage.test.ts`: delete "should encode ScreenChanged as {_tag, screen}" and the `Screen` import.
- `HubServer.ts`: delete `screenHandlers` (and from `Layer.mergeAll`), `screenChanges`; `liveRoute`'s messages are `director.published.pipe(settled)`; its doc: "GET /api/live — the current slate, each game beside its availability, then every change, …".
- `HubServer.test.ts`:
  - Delete "should turn an assignment with no guide read into a data tile saying so", "should reject a command for a missing tile", `tileOnceItIs`, `noGuide`, the `Tile` import.
  - Delete "should read a guide the size of a real one, playing a waiting tile once its airing is on": its assertion (a real-sized guide read makes the game carried on ESPN) is carried by Task 3's "should send the slate again when a guide read carries its game".
  - "should stream the current slate and screen first, as server-sent events" becomes "should stream the current slate first, as a server-sent event": take one line; assert it starts with `data: `, is a `SlateChanged`, and its plays are `[[]]`.
  - "should stream each change after the current slate and screen" becomes "should stream each change after the current slate": after `pastInitialMessages()`, deliver `Delivery.Snapshot({ snapshot: inPeriod(2) })` via `delivered`, `TestClock.adjust("250 millis")`, take a line, assert the `SlateChanged` game's period is `2`.
  - "should still send each change as data after a keep-alive comment": the change is `delivered(Delivery.Snapshot({ snapshot: inPeriod(2) }))` then `TestClock.adjust("250 millis")`, and the line awaited includes `SlateChanged`.
  - `pastInitialMessages` takes one line; its doc: "Opens the live stream and takes its first message, the current slate: the lines after it."
- `apps/web/src/hub/LiveStream.ts`: `received` loses the `ScreenChanged` case.

- [ ] **Step 3: Move the Screen into the web app**

```bash
git mv packages/domain/src/Screen.ts apps/web/src/screen/Screen.ts
git mv packages/domain/src/Screen.test.ts apps/web/src/screen/Screen.test.ts
```

- In `apps/web/src/screen/Screen.ts`: imports become `@sportal/domain/Channel` and `@sportal/domain/Game`; `ScreenRejection` drops its `{ httpApiStatus: 422 }` third argument.
- Move `bama`, `irish`, `foxChannel`, `onFox`, `nowhere`, `assign`, `fill`, `soloed` from `packages/domain/src/TestScreen.ts` into `apps/web/src/screen/TestScreen.ts` (below `withTiles`), with imports from `@sportal/domain/Channel`, `@sportal/domain/Game`, `./Screen.ts`; then `git rm packages/domain/src/TestScreen.ts`.
- `Screen.test.ts` imports `./Screen.ts` and `./TestScreen.ts`, and `@sportal/domain/Channel` / `@sportal/domain/Game`.
- Every other importer: `sed -i 's#@sportal/domain/Screen#../screen/Screen.ts#; s#@sportal/domain/TestScreen#../screen/TestScreen.ts#'` over `apps/web/src/{display,layout,slate,hub}/*.ts*`, and `#./Screen.ts#`/`#./TestScreen.ts#` for files in `apps/web/src/screen/`. Re-sort imports with `pnpm format`.

- [ ] **Step 4: Run the checks**

Run: `pnpm check`
Expected: PASS. `depcruise` confirms the Hub and `packages/api` import nothing from `apps/web`.

- [ ] **Step 5: Commit**

Body lists, for `Director.test.ts`: each "Director, the Screen" test → removed with the Hub's Screen, except "should assign a game the guide carries as a stream tile" → "Director#published should publish a game the guide carries as carried on its channel", and "should assign a game as a data tile with no guide while the source has read none" → "Director#published should publish a game as no guide while the source has read none"; "should keep a stream tile on Twitch when YouTube TV's guide then carries its game" and "should keep a tile whose game has left the slate …" and "should keep a guide-matched tile playing when its guide goes stale" → carried by `Screen#refresh` tests ("should keep a stream tile when another source carries its game", "should re-resolve only the tiles whose game has an availability to report", the "should keep a stream tile playing on the answer no guide" row); "should assign a game missing from the slate as a data tile" → "Screen#apply should assign a game no source answers for as a data tile with no stream". For `HubServer.test.ts` and `LiveMessage.test.ts`: each removed or renamed test as in Step 2.

```bash
git add -A apps packages
git commit -m "refactor: the Hub holds no Screen; the Screen module lives in the web app

<the test name mapping>"
```

---

### Task 7: records

**Files:**
- Create: `docs/adr/0015-each-display-owns-its-screen.md`
- Modify: `docs/adr/0003-hub-owns-stage-state.md`, `CONTEXT.md`, `AGENTS.md`, `docs/technical-spec.md`

- [ ] **Step 1: Write ADR 0015**

```markdown
# 15. Each Display owns its Screen

Date: 2026-10-09
Status: Accepted. Supersedes 0003.

## Context

ADR 0003 put the Screen in the Hub so a phone could change what a TV shows and automation could change the Screen
while no client was focused. Automation does not exist yet, the Remote is parked, and one shared Screen contradicts
the product plan, where each Display runs its own. The Hub also chose which source's answer won for a game.

## Decision

The Hub publishes the slate, each game beside every source's answer for where it can be streamed. Each Display owns
its Screen: it applies screen commands, refreshes its tiles from each slate, and chooses between sources. The Screen
module lives in the web app.

## Consequences

Two sources for one game are two answers, not a conflict the Hub settles. A command costs no round trip. A Display's
Screen lasts as long as its browser keeps it. When automation comes, the Hub delivers a ranking of games by
watchability, not screen commands, and each Display decides how its layout shows it. A stream budget shared across
Displays will need the Hub's coordination; the Remote comes back with its own design.
```

- [ ] **Step 2: Point 0003 at it**

Append under the existing note in `docs/adr/0003-hub-owns-stage-state.md`:

```markdown
Note, 2026-10-09: superseded by ADR 0015 (each Display owns its Screen).
```

and change its `Status:` to `Superseded by 0015`.

- [ ] **Step 3: Update CONTEXT.md**

- **Director**: drop "It holds the one Screen shared by every Display, applies screen commands … publishing only when a tile changed." and "Its rules, which will issue screen commands from game events, are planned."; add "It publishes the slate, each game beside every source's answer for where it can be streamed, whenever either changes. Automation, planned, will publish a ranking of games."; "It offers the slate and each change of either" becomes "It offers the slate and what it publishes."
- **Live message**: "the slate changed, each game beside its availability".
- **Hub client**: "The web UI's way to the Hub's API, `HubClient` in code. It runs in the web UI's one runtime (`HubRuntime.ts`)."
- **Display**: add "It owns its Screen (`apps/web/src/screen/DisplayScreen.ts`), kept in its browser."
- **Remote**: move the row under Planned.
- **Screen**: path `apps/web/src/screen/Screen.ts`; add "owned by its Display".
- **Screen command**: "Issued by people on a Display."
- **Screen rejection**: unchanged unless it names the Hub; if so, "The reason a Display refused a screen command."
- Any row that says a source's answer is the most useful of several: it is now chosen by the Screen.

- [ ] **Step 4: Update AGENTS.md and the technical spec**

- `AGENTS.md`: the `pnpm --filter @sportal/hub dev` line keeps "on every interface (`SPORTAL_HOST` narrows it)" and drops "so a phone Remote can reach it". The web dev line drops "(a phone opens `/remote`)"; the firewall sentence becomes "A firewall must let the home network reach both ports for another device to load the UI: …" with its command unchanged. `Screen.ts` in the module-shape example stays valid.
- `docs/technical-spec.md`: replace every passage that says the Hub holds or applies the Screen, `/api/screen`, `ScreenChanged`, or the Remote, with this model. `grep -n -i "screen\|remote\|mostUseful" docs/technical-spec.md` lists them.

- [ ] **Step 5: Run the checks and commit**

Run: `pnpm check`
Expected: PASS.

```bash
git add docs CONTEXT.md AGENTS.md
git commit -m "docs: ADR 0015, each Display owns its Screen; glossary and spec follow"
```
