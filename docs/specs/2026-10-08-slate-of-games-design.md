# A slate of games, one Director, the Screen

2026-10-08. Follows ADR 0012 (no persistence, one take). Persistence waits for this.

## The problem

The `Slate` keeps three maps keyed by game id that must agree with each other:

```ts
listed: ReadonlyMap<LeagueId, ReadonlyArray<GameId>>  // order
games:  ReadonlyMap<GameId, GameSnapshot>            // the game
plays:  ReadonlyMap<GameId, ReadonlyArray<Play>>     // the game's plays
```

A dropped game has to be removed from `games` and `plays` by hand (`without`), the order lives apart from the
games it orders, and plays are a parallel record rather than part of a game. The same split reaches the wire
(`SlateChanged { games, recentPlays }`, `RecentPlays.ts`) and the web (`Live.slate`, `Live.recentPlays`,
`usePlays(id)`).

Around it, the Hub has two holders of state where one will do: the `Board` holds the slate, the `Switcher` holds the
Stage and reads the Board. And "Stage" names a thing the Hub does not have: it is a description of what a Display
shows, so it is renamed Screen.

## 1. The slate is an ordered list of games

A game has its snapshot and its plays; a slate is the listed games, in order.

```ts
// packages/domain/src/Game.ts — the file's own class at last
export class Game extends Schema.Class<Game>("sportal/Game")({
  snapshot: GameSnapshot,
  plays: Schema.Array(Play) // in Play.order
}) {
  /** A game first seen as `snapshot`, with no plays yet. */
  static of(snapshot: GameSnapshot): Game

  /** This game with `snapshot` taken, unless it is behind (`GameSnapshot#isBehind`): then this game itself. */
  snapshotTaken(snapshot: GameSnapshot): Game

  /** As `snapshotTaken`, for a listing's snapshot: the push wins a tie (`GameSnapshot#tiesLive`). */
  listed(snapshot: GameSnapshot): Game

  /** This game with its whole list of plays replaced, sorted; this game itself when nothing changed. */
  playsTaken(plays: ReadonlyArray<Play>): Game

  /** This game with only its last ten plays: what the live stream sends. */
  recent(): Game
}
```

```ts
// apps/hub/src/slate/Slate.ts
export class Slate extends Data.Class<{
  /** The listed games: leagues in `LeagueId.literals` order, each league's in its listing's order. */
  readonly games: ReadonlyArray<Game>
}> {
  static readonly empty: Slate
  take(deliveries: ReadonlyArray<Delivery>): Slate // same slate back when nothing changed
  published(): SlateChanged                         // each game, recent()
}
```

- A value, not a service: `take` is a pure fold from one slate to the next, tested without layers. The Director
  (section 2) holds the current one. `Game` is a value for the same reason, and a `Schema.Class` because it crosses
  the wire.
- A league's listing replaces that league's run of games with its snapshots, each `had?.listed(s) ?? Game.of(s)`; a
  game the listing no longer names is simply not there. `listed`, `plays`, `without`, and `listedGames` go.
- A `Snapshot` or `Plays` delivery replaces its game where it is; a game no listing names is dropped, as today.
- The "behind" and "tied live" rules become `GameSnapshot` methods (`isBehind(had)`, `tiesLive(had)`), beside the
  `isAheadOf` and `isAheadOfOver` they are built from. `Slate` keeps only slate rules: listing, order, dropping.
- Identity is kept: a take that changes nothing returns the same `Slate`, and a game a take does not change is the same
  `Game`, so the gauge compares by reference.

The wire: `SlateChanged: { games: Schema.Array(Game) }`, each with its last ten plays. `RecentPlays.ts` goes.

The web: `Live.slate` becomes `ReadonlyArray<Game>`; `Live.recentPlays` and `usePlays` go. A component that takes the
slate takes games and reads `game.snapshot` / `game.plays` from the game it already has; a function that only needs a
snapshot (score, logo, status) keeps taking `GameSnapshot`.

## 2. One Director

`Board` and `Switcher` become one service, `Director` (`apps/hub/src/Director.ts`): it runs the provider's deliveries
into the slate and holds the one Screen, applying commands against where each game can be streamed.

```ts
export class Director extends Context.Service<Director, {
  readonly slate: Effect.Effect<Slate>
  /** The latest first, then each change. */
  readonly slateChanges: Stream.Stream<Slate>
  readonly screen: Effect.Effect<Screen>
  /** The latest first, then each change. */
  readonly screenChanges: Stream.Stream<Screen>
  dispatch(command: ScreenCommand): Effect.Effect<Screen, ScreenRejection>
}>()("sportal/hub/Director") {
  static readonly layer: Layer.Layer<Director, never, Provider | Source>
  static layerTest(slate: Slate): Layer.Layer<Director> // replaces Board.layerTest
}
```

- Two `SubscriptionRef`s, as today: the slate and the screen change independently and stream separately.
- Everything Board and Switcher do moves unchanged: `Director.take` (was `Board.take`) with its span, defect log, and
  `sportal_game_state` gauge (its id never changes); the frames-ended log; `Director.dispatch` as one atomic step; the
  refresh when the source's answers change.
- `HubMode` provides `Provider | Source` instead of `Board | Source`; `main.ts` provides `Director.layer` over it. The
  scenario clock stays on the provider, which runs itself (the plan checks the scenario test still plays on it).
- `slate/` keeps `Slate.ts` and `Delivery.ts`; `Board.ts`, `Switcher.ts`, and `TestBoard.ts` go (the test helper
  becomes `TestDirector.ts`).
- CONTEXT.md: **Board** and **Switcher** go; **Director** is added and takes over **Producer**'s planned job (the
  Producer becomes the Director's rules, when built); "director" leaves Producer's avoid list.

## 3. Stage is renamed Screen

A rename only, no behaviour change: what a Display shows (layout, split, tiles, bench, solo, audio) is a `Screen`.

- Domain: `Stage.ts` → `Screen.ts` (`Screen`, `ScreenCommand`, `ScreenRejection`, `TestStage.ts` → `TestScreen.ts`).
- API: `/api/stage` → `/api/screen`, the `stage` group → `screen`, `StageChanged` → `ScreenChanged`.
- Web: `stage/` → `screen/` (`StageView` → `ScreenView`, …), `remote/StageMap` → `ScreenMap`, `Live.stage` →
  `Live.screen`; desktop's `Transition.ts` comments.
- CONTEXT.md: every Stage row (**Stage**, **Stage command**, **Stage rejection**, **Stage transition**, and their use
  in Display, Split, Solo, Bench, Pick…) says Screen. **Full screen** stays: it is the window filling its monitor, and
  its row says so beside Screen. ADR 0003 gets a note that the Stage is now called the Screen and the Director holds it.

## Not changing

`Delivery`, the providers, the decode, the 250 ms settle, what a Screen can do, the phone Remote.

## Docs

CONTEXT.md as above; technical-spec's diagram, tree, and Board/Switcher sections. No new ADR: this refines 0012's
model and renames 0003's subject.

## Tests

Every rewritten test keeps its assertions (the commit body maps old names to new). `Slate.test.ts` reads
`slate.games` and `game.plays`; the tie and behind cases move to `GameSnapshot#isBehind` / `#tiesLive` and
`Game` tests. `Board.test.ts` and `Switcher.test.ts` become `Director.test.ts`. The rename touches tests by name
only. `pnpm check` green after each section, one commit each.
