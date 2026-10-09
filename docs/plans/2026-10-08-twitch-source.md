# Twitch as a Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Play Thursday Night Football from Twitch's `primevideo` channel by adding Twitch as a second source, with
every source behind one `Source` abstraction whose order does not matter.

**Architecture:** `Source` shrinks to `{ availability, changes }` with variants `Source.layerYouTubeTv`,
`Source.layerTwitch` and `Source.layerAll([...])`, which combines answers by usefulness. YouTube TV's pushed guide
moves to a `GuideReader` service (`GuideReader.layerYouTubeTv`) that HubServer's `/guide` uses and
`Source.layerYouTubeTv` reads. A guide's channel can name the network it carries in full. Twitch's lineup is one such
channel.

**Tech Stack:** TypeScript 7, Effect 4 (`Context.Service`, `Layer`, `SubscriptionRef`, `Stream`), `@effect/vitest`,
Electron (desktop allowlist).

**Spec:** `docs/specs/2026-10-08-twitch-source-design.md`

## Global Constraints

- Read `AGENTS.md` first. Effect 4 is newer than training data: check `node_modules/effect/ai-docs/src/` and
  `node_modules/effect/dist/*.d.ts` before using an API this plan does not spell out.
- Every exported type name is a `CONTEXT.md` term. New terms get their row in the same commit.
- One behaviour per test, `it("should …")`, Arrange/Act/Assert separated by blank lines, no `// Arrange` comments.
- Rewriting a test keeps every assertion. The commit body lists, per rewritten file, each old test name and the new
  test names that carry its assertions.
- No `any`, no casts outside decoding, no non-null assertions. Time comes from `Clock`/`DateTime.now`.
- `pnpm check` must pass before every commit (the push hook runs it).
- Source names are exactly `"YouTube TV"` and `"Twitch"`. The network is exactly `"Prime Video"`, as ESPN reports it.
- Twitch's player address is `https://player.twitch.tv/?channel=primevideo&parent=twitch.tv&player=popout`
  (Twitch's own popout player). Players are loaded unmodified.
- Work on branch `twitch-source` (it exists; the spec is committed there).

---

### Task 1: A guide's channel can carry a network; answers take `now`

**Files:**
- Modify: `packages/domain/src/Channel.ts` (`SourceName`)
- Modify: `packages/domain/src/Guide.ts`
- Modify: `packages/domain/src/Guide.test.ts`
- Modify: `apps/hub/src/source/youtube-tv/YouTubeTv.ts:41` (the one caller)

**Interfaces:**
- Produces: `SourceName = "YouTube TV" | "Twitch"`. On `Guide`: each channel has an optional `network: Network`, and
  `availabilityOf(game: GameSnapshot, now: DateTime.Utc): ChannelAvailability`.

- [ ] **Step 1: Pass `now` in every existing test**

In `packages/domain/src/Guide.test.ts`, every call `X.availabilityOf(game)` becomes `X.availabilityOf(game, readAt)`
(each guide in the file is read at `readAt`, so behaviour is unchanged). There are 22 calls. Use
`sed -i 's/\.availabilityOf(\([^)]*\))/.availabilityOf(\1, readAt)/' packages/domain/src/Guide.test.ts`, then check
that the nested call `miamiAtClemson([broadcast("ABC")])` came out as
`guide.availabilityOf(miamiAtClemson([broadcast("ABC")]), readAt)`. Fix any line the regex split wrongly by hand.

- [ ] **Step 2: Add the failing tests**

Append to `packages/domain/src/Guide.test.ts`, before the `airing` helper at the bottom. Add `Network` to the
`./Game.ts` import (`import { type Broadcast, Network } from "./Game.ts"`).

```ts
describe("Guide#availabilityOf on a channel that carries a network", () => {
  const kickoff = DateTime.makeUnsafe("2026-10-09T00:15:00Z")
  const primeVideo = ChannelId.make("primevideo")
  const primeVideoLive = { _tag: "WebView" as const, url: "https://player.twitch.tv/?channel=primevideo" }
  const lineup = new Guide({
    source: "Twitch",
    readAt: DateTime.makeUnsafe(0),
    channels: [{ id: primeVideo, name: "Prime Video", live: primeVideoLive, network: Network.make("Prime Video") }],
    airings: []
  })
  const thursdayNight = snapshot({ league: "nfl", kickoff, broadcasts: [broadcast("Prime Video", "streaming")] })

  it("should be carried on the network's channel from 30 minutes before kickoff", () => {
    const now = DateTime.subtract(kickoff, { minutes: 30 })

    const availability = lineup.availabilityOf(thursdayNight, now)

    assert.deepStrictEqual(
      availability,
      ChannelAvailability.Carried({
        channel: { name: "Prime Video", source: "Twitch", locator: primeVideoLive }
      })
    )
  })

  it("should be upcoming on the network's channel at kickoff until 30 minutes before it", () => {
    const now = DateTime.subtract(kickoff, { minutes: 30, seconds: 1 })

    const availability = lineup.availabilityOf(thursdayNight, now)

    assert.deepStrictEqual(
      availability,
      ChannelAvailability.Upcoming({ channel: Option.some("Prime Video"), begin: Option.some(kickoff) })
    )
  })

  it("should not carry a game that is over on the network's channel", () => {
    const over = snapshot({ ...thursdayNight, status: "final" })

    const availability = lineup.availabilityOf(over, DateTime.add(kickoff, { hours: 4 }))

    assert.deepStrictEqual(availability, ChannelAvailability.NotCarried({ why: "StreamingOnly" }))
  })

  it("should not carry a game of a network no channel carries", () => {
    const onPeacock = snapshot({ league: "nfl", kickoff, broadcasts: [broadcast("Peacock", "streaming")] })

    const availability = lineup.availabilityOf(onPeacock, kickoff)

    assert.deepStrictEqual(availability, ChannelAvailability.NotCarried({ why: "StreamingOnly" }))
  })

  it("should not be upcoming past its reach when the guide lists no airings", () => {
    const tomorrow = snapshot({ kickoff: DateTime.add(kickoff, { days: 1 }), broadcasts: [broadcast("CBS")] })

    const availability = lineup.availabilityOf(tomorrow, kickoff)

    assert.deepStrictEqual(availability, ChannelAvailability.NotCarried({ why: "NotInGuide" }))
  })

  it("should take an airing that names the game over a channel that carries its network", () => {
    const live = ChannelId.make("live-1")
    const liveAddress = { _tag: "WebView" as const, url: "https://tv.youtube.com/watch/live1" }
    const both = new Guide({
      source: "YouTube TV",
      readAt: kickoff,
      channels: [
        { id: primeVideo, name: "Prime Video", live: primeVideoLive, network: Network.make("Prime Video") },
        { id: live, name: "Live 1", live: liveAddress }
      ],
      airings: [airing(live, "AWAY at HOME", "2026-10-09T00:15:00Z", "2026-10-09T03:30:00Z")]
    })

    const availability = both.availabilityOf(thursdayNight, kickoff)

    assert.deepStrictEqual(
      availability,
      ChannelAvailability.Carried({ channel: { name: "Live 1", source: "YouTube TV", locator: liveAddress } })
    )
  })
})

describe("Guide#availabilityOf at a time after its reading", () => {
  it("should not match an airing that ended after the guide was read", () => {
    const readAt = DateTime.makeUnsafe("2026-10-03T20:25:00Z")
    const live = ChannelId.make("live-1")
    const guide = new Guide({
      source: "YouTube TV",
      readAt,
      channels: [{ id: live, name: "Live 1", live: { _tag: "WebView", url: "https://tv.youtube.com/watch/live1" } }],
      airings: [airing(live, "AWAY at HOME", "2026-10-03T17:00:00Z", "2026-10-03T20:35:00Z")]
    })
    const game = snapshot({ status: "live", kickoff: DateTime.makeUnsafe("2026-10-03T17:00:00Z") })

    const availability = guide.availabilityOf(game, DateTime.add(readAt, { minutes: 20 }))

    assert.deepStrictEqual(availability, ChannelAvailability.NotCarried({ why: "NotInGuide" }))
  })
})
```

- [ ] **Step 3: Run the tests to watch them fail**

Run: `pnpm vitest run packages/domain/src/Guide.test.ts`
Expected: the typecheck fails or the tests fail (`"Twitch"` is not a `SourceName`, `network` is not a channel field,
`availabilityOf` takes one argument).

- [ ] **Step 4: Implement**

`packages/domain/src/Channel.ts`:

```ts
/** The sources Sportal can play video from, by the name people know them by. */
export const SourceName = Schema.Literals(["YouTube TV", "Twitch"])
```

`packages/domain/src/Guide.ts`. Change the import to `import { type GameSnapshot, Network } from "./Game.ts"`, add the
channel field, and replace `availabilityOf`, `airs` and the class doc as below. `channelOf` and the helpers below the
class stay as they are.

```ts
/**
 * One reading of a source's guide: the channels this account gets, each with its live address while it is
 * on the air and, for a channel that is one network's stream, that network; and what each airs.
 */
export class Guide extends Schema.Class<Guide>("sportal/Guide")({
  source: SourceName,
  readAt: Schema.DateTimeUtc,
  channels: Schema.Array(
    Schema.Struct({
      id: ChannelId,
      name: Schema.String,
      live: Schema.optional(StreamLocator),
      network: Schema.optional(Network)
    })
  ),
  airings: Schema.Array(Airing)
}) {
  /**
   * How far past its reading a guide's airings are complete. The first page of YouTube TV's guide reached 3h46m past
   * the half hour before the read (spike, 2026-10-03); a later kickoff may not be listed yet.
   */
  static readonly reach = Duration.hours(3)

  /**
   * Where this source shows a game at `now`, from the airing that names both its teams, has not ended, and begins near
   * kickoff or is on now while the game is under way. Of several, the one on a channel named for one of the game's
   * networks wins, then the first in the guide. With no such airing, a channel that carries one of the game's networks
   * shows it as if it aired from kickoff, until the game is over. Either is carried once its channel is on the air and
   * it begins at most half an hour from `now`; until then it is upcoming. With neither, a kickoff past the reach of a
   * guide that lists airings is upcoming, and any other game is not carried.
   */
  availabilityOf(game: GameSnapshot, now: DateTime.Utc): ChannelAvailability {
    const matches = this.airings.filter((airing) => this.airs(airing, game, now))
    const [first] = matches
    if (first !== undefined) {
      const airing =
        matches.find((candidate) =>
          game.broadcasts.some(({ network }) => namesNetwork(this.channelOf(candidate).name, network))
        ) ?? first
      return this.from(this.channelOf(airing), airing.begin, now)
    }

    const carrier = this.channels.find((channel) =>
      game.broadcasts.some(({ network }) => channel.network === network)
    )
    if (carrier !== undefined && game.progress() !== "over") return this.from(carrier, game.kickoff, now)

    const pastReach = DateTime.isGreaterThan(game.kickoff, DateTime.addDuration(this.readAt, Guide.reach))
    if (this.airings.length > 0 && pastReach)
      return ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() })
    const streamingOnly =
      game.broadcasts.length > 0 && game.broadcasts.every(({ medium }) => medium === "streaming")
    return ChannelAvailability.NotCarried({ why: streamingOnly ? "StreamingOnly" : "NotInGuide" })
  }

  /** Carried on `channel` once it is on the air and `begin` is at most half an hour from `now`; else upcoming. */
  private from(
    channel: { readonly name: string; readonly live?: StreamLocator | undefined },
    begin: DateTime.Utc,
    now: DateTime.Utc
  ): ChannelAvailability {
    const soon = DateTime.isLessThanOrEqualTo(begin, DateTime.addDuration(now, startingSoon))
    return channel.live !== undefined && soon
      ? ChannelAvailability.Carried({ channel: { name: channel.name, source: this.source, locator: channel.live } })
      : ChannelAvailability.Upcoming({ channel: Option.some(channel.name), begin: Option.some(begin) })
  }

  private airs(airing: Airing, game: GameSnapshot, now: DateTime.Utc): boolean {
    const nearKickoff = DateTime.between(airing.begin, {
      minimum: DateTime.subtractDuration(game.kickoff, kickoffTolerance),
      maximum: DateTime.addDuration(game.kickoff, kickoffTolerance)
    })
    const onNow =
      game.progress() === "live" && DateTime.between(now, { minimum: airing.begin, maximum: airing.end })
    return (
      (nearKickoff || onNow) &&
      DateTime.isGreaterThan(airing.end, now) &&
      namesTeam(airing.title, game.home.team, game.league) &&
      namesTeam(airing.title, game.away.team, game.league)
    )
  }
```

`apps/hub/src/source/youtube-tv/YouTubeTv.ts`, inside `availability`: `onSome: (guide) => guide.availabilityOf(game, now)`.

- [ ] **Step 5: Run the tests to watch them pass**

Run: `pnpm vitest run packages/domain/src/Guide.test.ts apps/hub/src/source`
Expected: PASS. Every existing case passes too.

- [ ] **Step 6: Check and commit**

Run `pnpm check`, expected clean. Then:

```bash
git add packages/domain/src/Channel.ts packages/domain/src/Guide.ts packages/domain/src/Guide.test.ts apps/hub/src/source/youtube-tv/YouTubeTv.ts
git commit -m "feat(domain): a guide's channel can carry a network; answers are at a time

Twitch joins SourceName. A channel naming the network it carries shows that network's games from
kickoff; a guide answers at the time it is asked, keeping its reading time only for its reach.

Guide.test.ts: every existing test now passes the reading time as now; no assertion changed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: A refresh that changes nothing publishes nothing

**Files:**
- Modify: `packages/domain/src/Screen.ts` (`refresh`, a private equivalence at the end)
- Modify: `packages/domain/src/Screen.test.ts`
- Modify: `apps/hub/src/Director.ts` (`refresh`)
- Modify: `apps/hub/src/source/Source.ts` (add `layerTest`)
- Modify: `apps/hub/src/Director.test.ts`

**Interfaces:**
- Produces: `screen.refresh(f)` returns `screen` itself when no tile changes. Also
  `Source.layerTest(availabilityOf: (game: GameSnapshot) => ChannelAvailability, changes?: Stream.Stream<void>): Layer.Layer<Source>`.
  Task 3 rewrites `Source.ts` and must keep `layerTest` exactly as written here.

- [ ] **Step 1: Write the failing Screen test**

In `packages/domain/src/Screen.test.ts`, inside `describe("Screen#refresh")`, add the test below. It uses the
file's `noGuide` helper and `assign`/`bama` from `./TestScreen.ts`, which the file already imports.

```ts
  it("should return the same Screen when no tile changes", () => {
    const screen = assign(Screen.initial, 0, bama, noGuide)

    const refreshed = screen.refresh(() => Option.some(noGuide()))

    assert.strictEqual(refreshed, screen)
  })
```

Run: `pnpm vitest run packages/domain/src/Screen.test.ts`
Expected: FAIL (`refresh` builds a new Screen).

- [ ] **Step 2: Implement in Screen**

In `packages/domain/src/Screen.ts` `refresh`, replace `return settle({ ...this, tiles })` with:

```ts
    return Arr.makeEquivalence(tileEquivalence)(tiles, this.tiles) ? this : settle({ ...this, tiles })
```

At the end of the file:

```ts
/** Whether two tiles say the same: a refreshed data tile is a new object even when nothing in it changed. */
const tileEquivalence = Schema.toEquivalence(Tile)
```

Extend the `refresh` doc comment with the sentence: "When no tile changes, it is this Screen."

Run: `pnpm vitest run packages/domain/src/Screen.test.ts`
Expected: PASS.

- [ ] **Step 3: Add `Source.layerTest`**

In `apps/hub/src/source/Source.ts`, give the class a body. The `effect` import becomes
`import { Context, Effect, Layer, Stream } from "effect"` (`Effect` and `Stream` are now values, not just types):

```ts
export class Source extends Context.Service<Source, { /* unchanged */ }>()("sportal/hub/source/Source") {
  /** A source answering `availabilityOf` for every game, which changes whenever `changes` emits. */
  static layerTest(
    availabilityOf: (game: GameSnapshot) => ChannelAvailability,
    changes: Stream.Stream<void> = Stream.never
  ): Layer.Layer<Source> {
    return Layer.succeed(
      Source,
      Source.of({ availability: Effect.succeed(availabilityOf), changes, readGuide: () => Effect.void })
    )
  }
}
```

`readGuide` is still a port member until Task 3, which removes it from the port and from this fake. Check that
`Layer.succeed(tag, value)` is the right call shape in `node_modules/effect/dist/Layer.d.ts`; use the curried
`Layer.succeed(Source)(value)` if that is what it declares.

- [ ] **Step 4: Write the failing Director test**

In `apps/hub/src/Director.test.ts`, inside the describe that holds "should refresh the screen when the source reads a
guide", add the test below (add `Queue` to the `effect` import if it is missing):

```ts
  it.live("should publish no Screen change when a refresh changes no tile", () =>
    Effect.gen(function* () {
      const pulses = yield* Queue.unbounded<void>()
      const answering = Source.layerTest(
        () => ChannelAvailability.NoGuide({ source: "YouTube TV" }),
        Stream.fromQueue(pulses)
      )

      const published = yield* Effect.gen(function* () {
        const director = yield* Director
        yield* director.dispatch({ _tag: "Assign", tile: 0, game: GameId.make("5") })
        const next = yield* director.screenChanges.pipe(
          Stream.drop(1),
          Stream.runHead,
          Effect.timeoutOption("200 millis"),
          Effect.forkScoped
        )
        yield* Effect.yieldNow

        yield* Queue.offer(pulses, undefined)

        return yield* Fiber.join(next)
      }).pipe(Effect.provide(listed(games).pipe(Layer.provideMerge(directorOver), Layer.provideMerge(answering))))

      assert.isTrue(Option.isNone(published))
    })
  )
```

Run: `pnpm vitest run apps/hub/src/Director.test.ts -t "no Screen change"`
Expected: FAIL (the refresh publishes an equal Screen).

- [ ] **Step 5: Implement in the Director**

In `apps/hub/src/Director.ts`, replace the `refresh` const:

```ts
      // When what the sources answer changes, every tile it affects changes on every Display; nothing is published
      // when no tile changed.
      const refresh = SubscriptionRef.updateSomeEffect(screen, (current) =>
        availabilityOnSlate.pipe(
          Effect.map((availabilityOf) => {
            const next = current.refresh(availabilityOf)
            return next === current ? Option.none() : Option.some(next)
          })
        )
      )
```

Run: `pnpm vitest run apps/hub/src/Director.test.ts`
Expected: PASS, all of it.

- [ ] **Step 6: Check and commit**

Run `pnpm check`, expected clean.

```bash
git add packages/domain/src/Screen.ts packages/domain/src/Screen.test.ts apps/hub/src/Director.ts apps/hub/src/Director.test.ts apps/hub/src/source/Source.ts
git commit -m "feat: a refresh that changes no tile publishes nothing

So a source can say it may have changed as often as it likes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Guide reading moves to GuideReader; Source.layerYouTubeTv

**Files:**
- Create: `apps/hub/src/source/GuideReader.ts`
- Create: `apps/hub/src/source/GuideReader.test.ts` (from most of `YouTubeTv.test.ts`)
- Create: `apps/hub/src/source/Source.test.ts` (the rest of `YouTubeTv.test.ts`)
- Rename: `apps/hub/src/source/youtube-tv/YouTubeTv.ts` → `YouTubeTvGuide.ts` (`git mv`)
- Delete: `apps/hub/src/source/youtube-tv/YouTubeTv.test.ts` (its tests move)
- Modify: `apps/hub/src/source/youtube-tv/TestYouTubeTv.ts`
- Modify: `apps/hub/src/source/Source.ts`, `apps/hub/src/HubServer.ts`, `apps/hub/src/main.ts`
- Modify: `apps/hub/src/Director.test.ts`, `apps/hub/src/HubServer.test.ts`
- Modify: `.dependency-cruiser.cjs`

**Interfaces:**
- Consumes: `Guide#availabilityOf(game, now)` (Task 1), `Source.layerTest` (Task 2).
- Produces:
  - `YouTubeTvGuide.source: SourceName` (`"YouTube TV"`) and
    `YouTubeTvGuide.decode(response: string): Effect<{ channels, airings }, Schema.SchemaError>`.
  - `GuideReader` (`"sportal/hub/source/GuideReader"`) with `latest: Effect<Option<Guide>>`,
    `changes: Stream<void>`, `readGuide(guide: string): Effect<void, GuideUnreadable>`, and
    `static layerYouTubeTv: Layer<GuideReader>`.
  - `Source` with only `availability` and `changes`, plus `static layerYouTubeTv: Layer<Source, never, GuideReader>`
    and `layerTest`.
  - `TestYouTubeTv.recordedAt` (epoch millis) and `TestYouTubeTv.readRecordedGuide: Effect<void, GuideUnreadable, GuideReader>`.

- [ ] **Step 1: Turn the adapter into a guide decoder**

`git mv apps/hub/src/source/youtube-tv/YouTubeTv.ts apps/hub/src/source/youtube-tv/YouTubeTvGuide.ts`. In it:
- delete the `layer` export and its doc, `staleAfter`, and the imports only they used (`ChannelAvailability`,
  `GameSnapshot`, `FiberHandle`, `Layer`, `Duration`, `DateTime` if unused, `Stream`, `SubscriptionRef`, `Guide`'s
  class import if unused, `GuideUnreadable`, `Source`);
- make the top of the file:

```ts
/** YouTube TV, as its guide names it. */
export const source: SourceName = "YouTube TV"
```

  (delete the old private `const source` further down);
- replace `const decodeGuide = Schema.decodeEffect(GuideListing)` with:

```ts
/** A guide response as the channels and airings it lists. */
export const decode = Schema.decodeEffect(GuideListing)
```

  This stays at the bottom: it reads `GuideListing` when the module loads.

Update the namespace doc at the top of the file, before `source`:
`/** YouTube TV's guide: its responses, read as the channels and airings they list. */` (a namespace module may
open with one doc comment above its first export).

- [ ] **Step 2: Write `GuideReader.ts`**

```ts
import { Guide, GuideUnreadable } from "@sportal/domain/Guide"
import { Context, DateTime, Duration, Effect, FiberHandle, Layer, Option, Stream, SubscriptionRef } from "effect"
import * as YouTubeTvGuide from "./youtube-tv/YouTubeTvGuide.ts"

/**
 * Reads the guide responses the shell fetches from a source's guide page, and keeps the latest guide while it is
 * fresh. Only YouTube TV has a guide to read.
 */
export class GuideReader extends Context.Service<
  GuideReader,
  {
    /** The latest guide while it is fresh; none before the first read, and once the last is stale. */
    readonly latest: Effect.Effect<Option.Option<Guide>>
    /** Emits once after every guide read, and when the latest guide goes stale. */
    readonly changes: Stream.Stream<void>
    /** Reads a guide response as the source's guide page received it; it is the latest guide next. */
    readGuide(guide: string): Effect.Effect<void, GuideUnreadable>
  }
>()("sportal/hub/source/GuideReader") {
  /** YouTube TV's guide, read by the shell from the guide page; a guide is fresh for 45 minutes after its reading. */
  static readonly layerYouTubeTv: Layer.Layer<GuideReader> = Layer.effect(
    GuideReader,
    Effect.gen(function* () {
      // At most one fiber waiting to retire the latest guide; a newer read replaces it.
      const expiry = yield* FiberHandle.make<void>()
      const latest = yield* SubscriptionRef.make(Option.none<Guide>())

      const fresh = Effect.fn("GuideReader.latest")(function* () {
        const now = yield* DateTime.now
        const current = yield* SubscriptionRef.get(latest)
        return Option.filter(current, (guide) =>
          DateTime.isLessThan(now, DateTime.addDuration(guide.readAt, staleAfter))
        )
      })

      const readGuide = Effect.fn("GuideReader.readGuide")(function* (response: string) {
        const decoded = yield* YouTubeTvGuide.decode(response).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("YouTubeTv: a guide response did not decode", error.message)
          ),
          Effect.mapError(() => new GuideUnreadable())
        )
        const readAt = yield* DateTime.now
        const read = new Guide({ source: YouTubeTvGuide.source, readAt, ...decoded })
        if (read.channels.length === 0) {
          yield* Effect.logWarning("YouTubeTv: a guide response listed no channels")
          return yield* new GuideUnreadable()
        }

        yield* Effect.logInfo(
          `YouTubeTv: read a guide of ${read.channels.length} channels and ${read.airings.length} airings`
        )
        yield* SubscriptionRef.set(latest, Option.some(read))

        // Retire this guide once it is stale, unless a newer one has replaced it, so tiles hear of it too.
        const retire = SubscriptionRef.updateSome(latest, (current) =>
          Option.exists(current, (guide) => guide === read) ? Option.some(Option.none<Guide>()) : Option.none()
        )
        yield* FiberHandle.run(expiry, Effect.sleep(staleAfter).pipe(Effect.andThen(retire)))
      })

      return GuideReader.of({
        latest: fresh(),
        // The ref's current value comes first on every subscription; only later values are changes.
        changes: SubscriptionRef.changes(latest).pipe(Stream.drop(1), Stream.as(undefined)),
        readGuide
      })
    })
  )
}

/**
 * How long a guide answers after its reading: three missed 15-minute reads. After that a guide may list a
 * channel that has moved on, so it is no longer the latest until the next read.
 */
const staleAfter = Duration.minutes(45)
```

- [ ] **Step 3: Reshape `Source.ts`**

```ts
import { ChannelAvailability } from "@sportal/domain/Channel"
import type { GameSnapshot } from "@sportal/domain/Game"
import { Context, DateTime, Effect, Layer, Option, Stream } from "effect"
import { GuideReader } from "./GuideReader.ts"
import * as YouTubeTvGuide from "./youtube-tv/YouTubeTvGuide.ts"

/** A way to obtain video for a game. It says whether and where each game can be shown, and when that may change. */
export class Source extends Context.Service<
  Source,
  {
    /** Whether and where this source can show a game, as of now. */
    readonly availability: Effect.Effect<(game: GameSnapshot) => ChannelAvailability>
    /** Emits whenever what this source answers may have changed. */
    readonly changes: Stream.Stream<void>
  }
>()("sportal/hub/source/Source") {
  /** YouTube TV: from the latest guide its reader keeps while it is fresh; otherwise no guide. */
  static readonly layerYouTubeTv: Layer.Layer<Source, never, GuideReader> = Layer.effect(
    Source,
    Effect.gen(function* () {
      const reader = yield* GuideReader

      const availability = Effect.fn("Source.youTubeTvAvailability")(function* () {
        const now = yield* DateTime.now
        const latest = yield* reader.latest
        return (game: GameSnapshot) =>
          Option.match(latest, {
            onNone: () => ChannelAvailability.NoGuide({ source: YouTubeTvGuide.source }),
            onSome: (guide) => guide.availabilityOf(game, now)
          })
      })

      return Source.of({ availability: availability(), changes: reader.changes })
    })
  )

  /** A source answering `availabilityOf` for every game, which changes whenever `changes` emits. */
  static layerTest(
    availabilityOf: (game: GameSnapshot) => ChannelAvailability,
    changes: Stream.Stream<void> = Stream.never
  ): Layer.Layer<Source> {
    return Layer.succeed(Source, Source.of({ availability: Effect.succeed(availabilityOf), changes }))
  }
}
```

- [ ] **Step 4: HubServer and main take GuideReader**

`apps/hub/src/HubServer.ts`: import `GuideReader` from `./source/GuideReader.ts` instead of `Source`. In the layer's
requirement union (line ~40) replace `| Source` with `| GuideReader`. In `guideHandlers`:

```ts
    const reader = yield* GuideReader
    return handlers.handleAll({
      read: ({ payload }) =>
        reader
          .readGuide(payload.guide)
          .pipe(/* the existing tapError, unchanged */)
    })
```

`apps/hub/src/main.ts`: replace the YouTube TV import and provide with:

```ts
import { GuideReader } from "./source/GuideReader.ts"
import { Source } from "./source/Source.ts"
…
  Layer.provide(Director.layer),
  Layer.provide(Source.layerYouTubeTv),
  Layer.provide(GuideReader.layerYouTubeTv),
  Layer.provide(Telemetry.layer),
```

(HubServer and `Source.layerYouTubeTv` both need `GuideReader`. The one provide below them serves both, so they share
one reader.)

- [ ] **Step 5: Dependency rules**

In `.dependency-cruiser.cjs`, rule `only-main-names-adapters`:

```js
      comment:
        "Only main.ts, the source ports' layer variants, and tests know which concrete providers and sources exist, ESPN's through Espn.ts.",
      severity: "error",
      from: {
        path: "^apps/hub/src/",
        pathNot:
          "(^apps/hub/src/main\\.ts$|^apps/hub/src/source/(Source|GuideReader)\\.ts$|\\.test\\.ts$|^apps/hub/src/provider/[^/]+/|^apps/hub/src/source/[^/]+/)"
      },
      to: {
        path: "^apps/hub/src/(provider/[^/]+/|source/[^/]+/)"
      }
```

- [ ] **Step 6: Test helpers**

`apps/hub/src/source/youtube-tv/TestYouTubeTv.ts` becomes:

```ts
import { readFileSync } from "node:fs"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"
import { GuideReader } from "../GuideReader.ts"

/** The first page of YouTube TV's live guide, read 2026-10-03T20:24:45Z, for tests of other modules. */
export const recordedGuide = readFileSync(
  new URL("./fixtures/guide-2026-10-03T2024Z.json", import.meta.url),
  "utf8"
)

/** When the recorded guide was read, in epoch milliseconds for the test clock. */
export const recordedAt = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-03T20:24:45Z"))

/** Reads the recorded guide on the test clock at the moment it was recorded. */
export const readRecordedGuide = Effect.gen(function* () {
  yield* TestClock.setTime(recordedAt)
  const reader = yield* GuideReader

  yield* reader.readGuide(recordedGuide)
})
```

- [ ] **Step 7: Move YouTube TV's tests**

Split `apps/hub/src/source/youtube-tv/YouTubeTv.test.ts` into two files, keeping every assertion. Then delete it.

**`apps/hub/src/source/GuideReader.test.ts`** gets the whole `describe("YouTubeTv source reading its guide")`, renamed
`describe("GuideReader.layerYouTubeTv")`, with the helpers `guideReadAtRecording`, `counted` and `oneRowGuide`.
Mechanical changes:
- Every test is provided `youTubeTv` instead of `YouTubeTv.layer`, where
  `const youTubeTv = Source.layerYouTubeTv.pipe(Layer.provideMerge(GuideReader.layerYouTubeTv))` sits at the top of the
  file. The logging test merges it the same way:
  `Effect.provide(Layer.merge(youTubeTv, Logger.layer([collector])))`.
- `yield* source.readGuide(x)` → `yield* reader.readGuide(x)`, with `const reader = yield* GuideReader` beside
  `const source = yield* Source`. Assertions on `source.availability` stay as they are.
- `source.changes` → `reader.changes` in the two change-counting tests.
- The logging test: `Source.use((source) => Effect.flip(source.readGuide(response)))` →
  `GuideReader.use((reader) => Effect.flip(reader.readGuide(response)))`.
- `readAt` → `recordedAt` from `./youtube-tv/TestYouTubeTv.ts`. `guideReadAtRecording` becomes:

```ts
/** The source once its reader has read the recorded guide, on the test clock at the moment it was recorded. */
function guideReadAtRecording() {
  return Effect.gen(function* () {
    yield* readRecordedGuide
    return yield* Source
  })
}
```

**`apps/hub/src/source/Source.test.ts`** gets:
- `describe("Source.layerYouTubeTv")`: "should answer no guide before any guide is read", provided `youTubeTv` (the same
  const as above, declared at the top of this file too). Two lines of declaration duplicated across two test files is
  acceptable; if a reviewer objects, move it to `TestYouTubeTv.ts` as `youTubeTv`.
- `describe("matching the 2026-10-03 slates to the guide read at 20:24:45Z")`, both tests unchanged, with `tallied`,
  `matchingLayer` and `recordedScoreboard`. In `tallied`, `const source = yield* guideReadAtRecording()` becomes
  `yield* readRecordedGuide` then `const source = yield* Source`. In `matchingLayer`, `YouTubeTv.layer` becomes
  `youTubeTv`.

- [ ] **Step 8: Move the Director's and HubServer's tests onto the new layers**

`apps/hub/src/Director.test.ts`:
- Imports: drop `* as YouTubeTv`; add `GuideReader` from `./source/GuideReader.ts`, and
  `readRecordedGuide, recordedGuide` from `./source/youtube-tv/TestYouTubeTv.ts`.
- Delete the file's own `recordedAt` and `guideReadAtRecording`; call sites use `yield* readRecordedGuide`.
- `directed` becomes:

```ts
/** The Director over a fed provider, against YouTube TV with nothing read yet; it and the guide reader provided too. */
const directed = directorOver.pipe(
  Layer.provideMerge(Source.layerYouTubeTv),
  Layer.provideMerge(GuideReader.layerYouTubeTv)
)
```

- Every `yield* source.readGuide(recordedGuide)` → `yield* reader.readGuide(recordedGuide)`, with
  `const reader = yield* GuideReader` (drop `const source = yield* Source` where it then goes unused).
- `countingSource` and `availabilityHeldOnce`: `.pipe(Layer.provide(YouTubeTv.layer))` →
  `.pipe(Layer.provide(Source.layerYouTubeTv))`. Each layer built from them adds `Layer.provideMerge(GuideReader.layerYouTubeTv)`
  last, so the test's `GuideReader` is the one the source reads.
- "should log at Error when the provider's frames end": `Layer.provide(YouTubeTv.layer)` →
  `Layer.provide(Source.layerTest(() => ChannelAvailability.NoGuide({ source: "YouTube TV" })))`.

`apps/hub/src/HubServer.test.ts`: drop the `YouTubeTv` import. `hubUnderTest` becomes:

```ts
function hubUnderTest() {
  return directorOver.pipe(
    Layer.provideMerge(Source.layerYouTubeTv),
    Layer.provideMerge(GuideReader.layerYouTubeTv),
    Layer.provideMerge(HubConfig.layerTest({ SPORTAL_VERSION: "1.2.3" }))
  )
}
```

- [ ] **Step 9: Run everything**

Run: `pnpm vitest run apps/hub`
Expected: PASS, with the same number of tests as before this task (`git stash` and run first if in doubt; the count
must not drop).

Run: `pnpm check`
Expected: clean (lint, types, depcruise, knip).

- [ ] **Step 10: Commit**

The body lists the moved tests:

```bash
git add -A apps/hub .dependency-cruiser.cjs
git commit -m "refactor(hub): guide reading is GuideReader's; Source.layerYouTubeTv answers from it

Source is now only whether-and-where and when-it-may-change, so every source shares it. YouTube
TV's pushed guide is held by GuideReader.layerYouTubeTv, which /guide feeds; its decode is
YouTubeTvGuide.

source/youtube-tv/YouTubeTv.test.ts:
- \"should answer no guide before any guide is read\" -> Source.test.ts, same name
- every test in \"YouTubeTv source reading its guide\" -> GuideReader.test.ts, \"GuideReader.layerYouTubeTv\", same names
- both tests in \"matching the 2026-10-03 slates …\" -> Source.test.ts, same names
Director.test.ts, HubServer.test.ts: same tests over GuideReader and Source.layerYouTubeTv; no assertion changed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Twitch, and every source as one

**Files:**
- Create: `apps/hub/src/source/twitch/Twitch.ts`
- Modify: `apps/hub/src/source/Source.ts` (`layerTwitch`, `layerAll`, private ranking)
- Modify: `apps/hub/src/source/Source.test.ts`
- Modify: `apps/hub/src/main.ts`

**Interfaces:**
- Consumes: `Source.layerYouTubeTv`, `Source.layerTest`, `GuideReader.layerYouTubeTv`, `readRecordedGuide`,
  `recordedAt`.
- Produces: `Twitch.lineup: Guide`, `Source.layerTwitch: Layer<Source>`, and
  `Source.layerAll<R>(sources: ReadonlyArray<Layer.Layer<Source, never, R>>): Layer.Layer<Source, never, R>`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/hub/src/source/Source.test.ts`. Imports needed: `ChannelAvailability`, `type ChannelAvailability`
from `@sportal/domain/Channel`, `broadcast, snapshot, team` from `@sportal/domain/TestGame`, and
`DateTime, Effect, Fiber, Layer, Option, Ref, Stream` from `effect`, plus `TestClock` from `effect/testing`.

```ts
const thursdayKickoff = DateTime.makeUnsafe("2026-10-09T00:15:00Z")
const thursdayNight = snapshot({
  league: "nfl",
  kickoff: thursdayKickoff,
  away: { team: team("NYJ", "nfl", { name: "New York Jets", shortName: "Jets" }), score: 0 },
  home: { team: team("DEN", "nfl", { name: "Denver Broncos", shortName: "Broncos" }), score: 0 },
  broadcasts: [broadcast("Prime Video", "streaming")]
})
const onPrimeVideo = ChannelAvailability.Carried({
  channel: {
    name: "Prime Video",
    source: "Twitch",
    locator: { _tag: "WebView", url: "https://player.twitch.tv/?channel=primevideo&parent=twitch.tv&player=popout" }
  }
})

describe("Source.layerTwitch", () => {
  it.effect("should carry a Prime Video game on primevideo from 30 minutes before kickoff", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.subtract(thursdayKickoff, { minutes: 30 })))
      const source = yield* Source

      const availabilityOf = yield* source.availability

      assert.deepStrictEqual(availabilityOf(thursdayNight), onPrimeVideo)
    }).pipe(Effect.provide(Source.layerTwitch))
  )

  it.effect("should say it may have changed once a minute", () =>
    Effect.gen(function* () {
      const source = yield* Source
      const changes = yield* Ref.make(0)
      yield* source.changes.pipe(Stream.runForEach(() => Ref.update(changes, (n) => n + 1)), Effect.forkChild)
      yield* Effect.yieldNow

      yield* TestClock.adjust("1 minute")

      const signalled = yield* Ref.get(changes)
      assert.strictEqual(signalled, 1)
    }).pipe(Effect.provide(Source.layerTwitch))
  )
})

describe("Source.layerAll", () => {
  const carried = (source: "YouTube TV" | "Twitch") =>
    ChannelAvailability.Carried({
      channel: { name: source, source, locator: { _tag: "WebView", url: `https://example.test/${source}` } }
    })
  const upcomingOn = ChannelAvailability.Upcoming({
    channel: Option.some("Prime Video"),
    begin: Option.some(thursdayKickoff)
  })
  const upcomingUnknown = ChannelAvailability.Upcoming({ channel: Option.none(), begin: Option.none() })
  const noGuide = ChannelAvailability.NoGuide({ source: "YouTube TV" })
  const streamingOnly = ChannelAvailability.NotCarried({ why: "StreamingOnly" })
  const notInGuide = ChannelAvailability.NotCarried({ why: "NotInGuide" })

  it.effect("should answer a later source's carried over an earlier source's not carried", () =>
    Effect.gen(function* () {
      const answer = yield* answerOf([streamingOnly, carried("Twitch")])

      assert.deepStrictEqual(answer, carried("Twitch"))
    })
  )

  it.effect("should answer carried over upcoming", () =>
    Effect.gen(function* () {
      const answer = yield* answerOf([upcomingOn, carried("Twitch")])

      assert.deepStrictEqual(answer, carried("Twitch"))
    })
  )

  it.effect("should answer upcoming on a named channel over upcoming with nothing known", () =>
    Effect.gen(function* () {
      const answer = yield* answerOf([upcomingUnknown, upcomingOn])

      assert.deepStrictEqual(answer, upcomingOn)
    })
  )

  it.effect("should answer upcoming over no guide", () =>
    Effect.gen(function* () {
      const answer = yield* answerOf([noGuide, upcomingUnknown])

      assert.deepStrictEqual(answer, upcomingUnknown)
    })
  )

  it.effect("should answer no guide over not carried", () =>
    Effect.gen(function* () {
      const answer = yield* answerOf([streamingOnly, noGuide])

      assert.deepStrictEqual(answer, noGuide)
    })
  )

  it.effect("should answer streaming only over not in the guide", () =>
    Effect.gen(function* () {
      const answer = yield* answerOf([notInGuide, streamingOnly])

      assert.deepStrictEqual(answer, streamingOnly)
    })
  )

  it.effect("should change whenever any of its sources changes", () =>
    Effect.gen(function* () {
      const all = Source.layerAll([
        Source.layerTest(() => notInGuide, Stream.make(undefined)),
        Source.layerTest(() => notInGuide, Stream.make(undefined))
      ])

      const changes = yield* Source.use(({ changes }) => Stream.runCount(changes)).pipe(Effect.provide(all))

      assert.strictEqual(changes, 2)
    })
  )

  it.effect("should carry Thursday's Prime Video game on Twitch while YouTube TV's guide has it nowhere", () =>
    Effect.gen(function* () {
      yield* readRecordedGuide
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.subtract(thursdayKickoff, { minutes: 10 })))
      const source = yield* Source

      const availabilityOf = yield* source.availability

      assert.deepStrictEqual(availabilityOf(thursdayNight), onPrimeVideo)
    }).pipe(
      Effect.provide(
        Source.layerAll([Source.layerYouTubeTv, Source.layerTwitch]).pipe(
          Layer.provideMerge(GuideReader.layerYouTubeTv)
        )
      )
    )
  )
})

/** What every source answering one of `answers`, in order, answers as one. */
function answerOf(answers: ReadonlyArray<ChannelAvailability>) {
  const all = Source.layerAll(answers.map((answer) => Source.layerTest(() => answer)))
  return Effect.gen(function* () {
    const source = yield* Source

    const availabilityOf = yield* source.availability
    return availabilityOf(thursdayNight)
  }).pipe(Effect.provide(all))
}
```

The last test reads the recorded guide (2026-10-03), then moves the clock to Thursday 2026-10-09 00:05Z. By then
YouTube TV's guide is stale, so it answers no guide, and Twitch's carried wins. Remove `Fiber` from the imports if
nothing uses it.

Run: `pnpm vitest run apps/hub/src/source/Source.test.ts`
Expected: FAIL (`layerTwitch`, `layerAll` do not exist).

- [ ] **Step 2: Twitch's lineup**

`apps/hub/src/source/twitch/Twitch.ts`:

```ts
import { Network } from "@sportal/domain/Game"
import { ChannelId, Guide } from "@sportal/domain/Guide"
import { DateTime } from "effect"

/**
 * Twitch's channels the Hub plays, each with the network whose every broadcast it carries. A lineup is never read,
 * so its reading time is the epoch; it lists no airings, so the guide's reach never applies to it.
 */
export const lineup = new Guide({
  source: "Twitch",
  readAt: DateTime.makeUnsafe(0),
  channels: [
    {
      id: ChannelId.make("primevideo"),
      name: "Prime Video",
      live: {
        _tag: "WebView",
        url: "https://player.twitch.tv/?channel=primevideo&parent=twitch.tv&player=popout"
      },
      network: Network.make("Prime Video")
    }
  ],
  airings: []
})
```

- [ ] **Step 3: `layerTwitch` and `layerAll`**

In `apps/hub/src/source/Source.ts`, add `import * as Twitch from "./twitch/Twitch.ts"`, add `Array as Arr` to the
`effect` import, and add these statics between `layerYouTubeTv` and `layerTest`:

```ts
  /**
   * Twitch: its lineup, which is always current. It says it may have changed once a minute, so a game reaching the
   * half hour before kickoff reaches its tile.
   */
  static readonly layerTwitch: Layer.Layer<Source> = Layer.effect(
    Source,
    Effect.gen(function* () {
      const availability = Effect.fn("Source.twitchAvailability")(function* () {
        const now = yield* DateTime.now
        return (game: GameSnapshot) => Twitch.lineup.availabilityOf(game, now)
      })

      return Source.of({ availability: availability(), changes: Stream.tick("1 minute").pipe(Stream.drop(1)) })
    })
  )

  /**
   * Every source given, as one: for each game the most useful answer any of them gives, whatever their order, and a
   * change whenever any of them changes.
   */
  static layerAll<R>(sources: ReadonlyArray<Layer.Layer<Source, never, R>>): Layer.Layer<Source, never, R> {
    return Layer.effect(
      Source,
      Effect.gen(function* () {
        const each = yield* Effect.forEach(sources, (source) =>
          Layer.build(source).pipe(Effect.map((context) => Context.get(context, Source)))
        )

        const availability = Effect.fn("Source.availability")(function* () {
          const answers = yield* Effect.forEach(each, (source) => source.availability)
          return (game: GameSnapshot) => mostUseful(answers.map((availabilityOf) => availabilityOf(game)))
        })

        return Source.of({
          availability: availability(),
          changes: Stream.mergeAll(
            each.map((source) => source.changes),
            { concurrency: "unbounded" }
          )
        })
      })
    )
  }
```

If `@effect/tsgo` flags the `Effect.gen` in `layerTwitch` for having no `yield*` at its top level, use
`Layer.sync(Source, () => …)` with the same body instead. Check `Layer.sync`'s signature in
`node_modules/effect/dist/Layer.d.ts`.

Below the class, as private helpers in first-use order:

```ts
/** The answer that says most of several: ties go to the first, and only ever between answers of one kind. */
function mostUseful(answers: ReadonlyArray<ChannelAvailability>): ChannelAvailability {
  return Arr.reduce(answers, ChannelAvailability.NotCarried({ why: "NoStream" }), (best, answer) =>
    usefulness(answer) > usefulness(best) ? answer : best
  )
}

/**
 * How much an answer tells: carried; upcoming on a known channel; upcoming with nothing known; no guide (it may yet be
 * carried); streaming only; not in the guide; no stream.
 */
function usefulness(answer: ChannelAvailability): number {
  return ChannelAvailability.$match(answer, {
    Carried: () => 6,
    Upcoming: ({ channel }) => (Option.isSome(channel) ? 5 : 4),
    NoGuide: () => 3,
    NotCarried: ({ why }) => (why === "StreamingOnly" ? 2 : why === "NotInGuide" ? 1 : 0)
  })
}
```

- [ ] **Step 4: Wire both sources**

`apps/hub/src/main.ts`: `Layer.provide(Source.layerYouTubeTv)` becomes
`Layer.provide(Source.layerAll([Source.layerYouTubeTv, Source.layerTwitch]))`.

- [ ] **Step 5: Run and check**

Run: `pnpm vitest run apps/hub/src/source`
Expected: PASS.

Run: `pnpm check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/source apps/hub/src/main.ts
git commit -m "feat(hub): Twitch carries Prime Video; every source answers as one

Twitch's lineup is one channel, primevideo, carrying Prime Video from 30 minutes before kickoff.
Source.layerAll gives each game the most useful answer any source gives, whatever their order.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Data tiles name the source only when waiting for its guide

**Files:**
- Modify: `packages/domain/src/Screen.ts` (`Tile.DataTile.why.NoGuide`, `tileFor`)
- Modify: `packages/domain/src/Screen.test.ts:32,636`
- Modify: `apps/hub/src/Director.test.ts` (`noGuideTile`)
- Modify: `apps/hub/src/HubServer.test.ts:43` (`noGuide`)
- Modify: `apps/web/src/screen/TileBody.tsx` (`noStream`)

**Interfaces:**
- Produces: `DataTile.why` case `NoGuide: { source: SourceName }`. Its other cases are unchanged.

This changes the spec's "Data tiles name their source" section. With no preferred source, a "not carried" answer
could come from either source, so naming one would be arbitrary. Only "no guide" is about one source. Its copy names
that source, and the rest says "your sources".

- [ ] **Step 1: Update the expectations (they fail first)**

`packages/domain/src/Screen.test.ts`, line 32: `why: { _tag: "NoGuide" }` → `why: { _tag: "NoGuide", source: "YouTube TV" }`.
Line 636 (the wire table): `{ _tag: "DataTile", game: "401856800", why: { _tag: "NoGuide", source: "YouTube TV" } }`.
`apps/hub/src/Director.test.ts` `noGuideTile`: `why: { _tag: "NoGuide" as const, source: "YouTube TV" as const }`.
`apps/hub/src/HubServer.test.ts` line 43: `why: { _tag: "NoGuide", source: "YouTube TV" }`.

Run: `pnpm vitest run packages/domain/src/Screen.test.ts`
Expected: FAIL (the tile has no `source`).

- [ ] **Step 2: Implement**

`packages/domain/src/Screen.ts`: import `SourceName` beside `Channel, ChannelAvailability` from `./Channel.ts`. In
`Tile`, `NoGuide: {},` → `NoGuide: { source: SourceName },`. In `tileFor`:

```ts
    NoGuide: ({ source }): Tile => ({ _tag: "DataTile", game, why: { _tag: "NoGuide", source } }),
```

`apps/web/src/screen/TileBody.tsx` `noStream`:

```ts
    NoStream: () => "No stream for this game on your sources",
    StreamingOnly: () => "Streaming only: not on your sources",
    NotInGuide: () => "Not on your sources' channels",
    NoGuide: ({ source }) => `Waiting for the ${source} guide`,
    NotYet: ({ channel, begin }) =>
      Option.match(channel, {
        onNone: () => "Not in your sources' guides yet",
        onSome: (channel) =>
          `On ${channel}${Option.match(begin, { onNone: () => "", onSome: (begin) => ` at ${localTime(begin)}` })}`
      })
```

- [ ] **Step 3: Run and check**

Run: `pnpm vitest run packages/domain apps/hub apps/web`
Expected: PASS.

Run: `pnpm check`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/domain/src/Screen.ts packages/domain/src/Screen.test.ts apps/hub/src/Director.test.ts apps/hub/src/HubServer.test.ts apps/web/src/screen/TileBody.tsx
git commit -m "feat: a no-guide tile names its source; other copy speaks of your sources

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The shell lets a tile play Twitch's player

**Files:**
- Create: `apps/desktop/src/main/Twitch.ts`
- Modify: `apps/desktop/src/main/ProviderSession.ts`
- Modify: `apps/desktop/src/main/ProviderSession.test.ts:176-181`

**Interfaces:**
- Produces: `Twitch.allowedHosts: ReadonlyArray<string>` (desktop).

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/main/ProviderSession.test.ts`, add to the "should allow %s" list:

```ts
    "https://player.twitch.tv/?channel=primevideo&parent=twitch.tv&player=popout"
```

and to the "should refuse %s" list:

```ts
    "https://www.twitch.tv/primevideo",
    "http://player.twitch.tv/"
```

Run: `pnpm vitest run apps/desktop/src/main/ProviderSession.test.ts`
Expected: FAIL on the player address.

- [ ] **Step 2: Implement**

`apps/desktop/src/main/Twitch.ts`:

```ts
/** The hosts a provider view may visit for Twitch: its popout player, which plays a channel with nothing around it. */
export const allowedHosts = ["player.twitch.tv"]
```

`apps/desktop/src/main/ProviderSession.ts`: replace `import { allowedHosts, signInUrl } from "./YouTubeTv.ts"` with
`import * as Twitch from "./Twitch.ts"` and `import * as YouTubeTv from "./YouTubeTv.ts"`. Use `YouTubeTv.signInUrl`
where `signInUrl` was used. `allows` becomes:

```ts
/** Provider views may visit each source's pages: YouTube TV and its sign-in, and Twitch's player. */
function allows(url: string): boolean {
  if (!URL.canParse(url)) return false
  const { protocol, hostname } = new URL(url)
  return protocol === "https:" && [...YouTubeTv.allowedHosts, ...Twitch.allowedHosts].includes(hostname)
}
```

Update `apps/desktop/src/main/YouTubeTv.ts`'s `allowedHosts` doc to "The hosts a provider view may visit for YouTube TV:
its pages and the pages its sign-in passes through."

- [ ] **Step 3: Run and check**

Run: `pnpm vitest run apps/desktop`
Expected: PASS.

Run: `pnpm check`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/Twitch.ts apps/desktop/src/main/ProviderSession.ts apps/desktop/src/main/ProviderSession.test.ts apps/desktop/src/main/YouTubeTv.ts
git commit -m "feat(desktop): provider views may play Twitch's popout player

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Vocabulary, rules and architecture docs

**Files:**
- Modify: `CONTEXT.md`, `AGENTS.md`, `docs/technical-spec.md`

- [ ] **Step 1: CONTEXT.md**

- **Source** row: "A way you obtain **video** (YouTube TV, Twitch)."
- **Channel** row: "A station as a source names it ("News 3", "ESPN2"), with the address that plays it live, and, for
  a channel that is one network's stream (Twitch's Prime Video), the network whose every broadcast it carries."
- **Guide** row: "One reading of a source's listing of the channels this account gets, with their live addresses, and
  what each airs. Twitch's is a fixed lineup, never read."
- **Guide reader** row: "What reads a source's guide. The shell's (`GuideReader` in the desktop app) fetches it with
  the source's own request, sent on the provider session. The Hub's (`GuideReader` in `source/`) reads what the shell
  fetched and keeps the latest guide while it is fresh."
- **Director** row: "…and refreshes the Screen when a source changes, publishing only when a tile changed."

- [ ] **Step 2: AGENTS.md**

Replace "In the Hub, only `main.ts` and tests name concrete providers and sources (ESPN's only through
`provider/espn/Espn.ts`)" with "In the Hub, only `main.ts` and tests name concrete providers and sources (ESPN's only
through `provider/espn/Espn.ts`); a source port's layer variants (`Source.layerYouTubeTv`,
`GuideReader.layerYouTubeTv`) name theirs too, and only the port modules import a source's folder".

- [ ] **Step 3: docs/technical-spec.md**

- Rule 9 (line ~136): the same amendment as AGENTS.md.
- The `main.ts` tree line (~192): "…the only file that chooses providers and sources, ESPN's through `Espn`".
- The `source/` tree (~221): replace it with the tree from the spec's "Hub" section: `Source.ts` "The port, its
  variants, and how several answer as one", `GuideReader.ts` "Reads the guide the shell fetches, keeps it while
  fresh", `youtube-tv/YouTubeTvGuide.ts` "A guide response as channels and airings", and `twitch/Twitch.ts` "Twitch's
  lineup".
- The desktop tree (~254): add `Twitch.ts        Twitch's player host`.
- The **Source** section (~325-341): replace the class sketch with the new two-member `Source`. Add one paragraph:
  "`Source.layerAll` runs every source and answers each game with the most useful answer any gives: carried, upcoming,
  no guide, then not carried; the order sources are listed in never decides between kinds. YouTube TV answers from
  the guide `GuideReader` keeps; Twitch from its lineup, a guide whose one channel carries Prime Video." Change
  "`main.ts` provides it over ESPN as the provider and YouTube TV as the source" to "…and YouTube TV and Twitch as the
  sources".

- [ ] **Step 4: Check and commit**

Run: `pnpm check`
Expected: clean.

```bash
git add CONTEXT.md AGENTS.md docs/technical-spec.md
git commit -m "docs: Twitch as a source; GuideReader in the Hub; source variants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Tonight's game (the user runs this)

Thursday 2026-10-08 has a TNF game on Prime Video. Agent-launched Electron misreports rendering on this machine, so
the user runs this check.

- [ ] Start everything with `pnpm dev` from the branch. Restart the shell with the Hub: the tile wire shape changed.
- [ ] Before kickoff−30min: assign the TNF game to a tile. It reads "On Prime Video at <kickoff>".
- [ ] At kickoff−30min, without touching anything: within a minute the tile becomes Twitch's player, full-bleed,
      playing the Prime Video stream, with sound when it has audio focus.
- [ ] A YouTube TV game in another tile still plays.
- [ ] Note anything Twitch shows that YouTube TV doesn't (ads, a "click to unmute" overlay, mature-content gate) for a
      follow-up. Do not script around it: players stay unmodified.
