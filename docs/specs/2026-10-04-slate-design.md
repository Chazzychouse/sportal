# The Slate Over the Game Actors — Design

Date: 2026-10-04
Status: Approved 2026-10-04

The slate becomes a view over the game actors. Today Ingest sends each poll's snapshots to the game actors, reads
them back, and overwrites its own slate with what they hold. A change inside an actor reaches clients only on
Ingest's next poll. After this change, one `Slate` module joins what each league last listed with what each game's
actor holds, folds watchability over it, and publishes both, whenever either side changes.

Nobody sees a difference today: the wire is unchanged and the poll is still the only feed. What changes is that a
second feed (ESPN FastCast, the roadmap's next piece) only has to call `GameActors.receive`, and its snapshots reach
every client within a quarter of a second, between polls.

Source: architecture review of 2026-10-04, candidate 1. The decisions below were settled with the user in two
grilling rounds.

## Goal

- Each game has one owner of its latest snapshot: its actor. Nothing else keeps a newer copy.
- A snapshot an actor takes, from any feed, reaches `GET /api/slate`, StageSessions, and the live stream without
  waiting for a poll.
- A poll's burst of actor changes reaches clients as one live message, not one per game.
- Ingest only polls: at the Cadence, keeping each league's last good listing, sending what it got to the actors.
- `Watch` is gone. Slate and watchability are published together, as the live stream already sends them.

## Today

| What | Where |
| --- | --- |
| Ingest polls, keeps `byLeague`, sends to the actors, reads `liveGames` back, overwrites, publishes `current` | `ingest/Ingest.ts:31-64` |
| `GameActors.changes`: every running actor's live game on each change. No production consumer | `GameActors.ts:30` |
| Watch folds watchability on each Ingest slate | `watch/Watch.ts` |
| `GET /api/slate` reads `ingest.slate`; `/api/live` reads `watch.changes`; StageSessions reads `ingest.slate` | `http/HubServer.ts:50,135`, `stage/StageSessions.ts:24` |
| Cadence reads the slate Ingest just built | `ingest/Ingest.ts:70` |

## Shape

```mermaid
flowchart LR
  P[Provider] --> I[Ingest]
  I -- receive --> GA[GameActors]
  I -- listed --> S[Slate]
  GA -- changes --> S
  GA -. liveGames, for Cadence .-> I
  S --> API[GET /api/slate]
  S --> LIVE[/api/live]
  S --> SS[StageSessions]
```

There is no cycle: Ingest depends on Provider and GameActors, and Slate depends on Ingest and GameActors.

## Decisions

### What is on the slate

The slate's **membership and order** come from Ingest's listing: the games of each league's last good poll, in poll
order, leagues in configured order (ADR 0004, unchanged). Each listed game's **snapshot** is its actor's, if its actor
is running, and otherwise the listed one. A game an actor knows but no listing has does not appear. A finished game
falls back to its listed snapshot once its actor stops.

The wire is unchanged. `LiveMessage.SlateChanged` still carries `GameSnapshot[]` and `Watchability[]`. `LiveGameState`
does not reach clients; showing staleness is its own piece of work.

### Ingest: `apps/hub/src/ingest/Ingest.ts`

```ts
class Ingest extends Context.Service<Ingest, {
  /** The games each league's last good poll listed, in poll order: the current listing first, then one per poll,
   *  even when nothing changed. */
  readonly listed: Stream.Stream<ReadonlyArray<GameSnapshot>>
}>()("sportal/hub/Ingest") {
  static readonly layer: (leagues: ReadonlyArray<LeagueId>) => Layer.Layer<Ingest, never, Provider | GameActors>
}
```

- `slate` and `changes` are gone. Ingest no longer reads `gameActors.liveGames` to build anything.
- Each poll still sends only that poll's successful games to the actors, so a failed league's kept games go stale.
- **Cadence** reads `gameActors.liveGames` after the poll's sends: each listed game as its actor has it, as today.
  A FastCast "now live" can then speed up polling. This is one read, with no dependency on Slate.
- The listing is published on **every** poll, even an unchanged one. Watchability's 60-second lull depends on this
  (see below). The plan must confirm that a `SubscriptionRef` set with an equal value still emits on `changes`. If it
  does not, Ingest publishes through a `PubSub`.
- Spans, `sportal_poll_duration`, and `sportal_provider_errors` are unchanged.

### Slate: `apps/hub/src/Slate.ts`

```ts
/** The current slate and every game's watchability: each listed game as its actor has it, published on every
 *  listing and every burst of actor changes. */
class Slate extends Context.Service<Slate, {
  readonly latest: Effect.Effect<{
    readonly slate: ReadonlyArray<GameSnapshot>
    readonly watchability: ReadonlyArray<Watchability>
  }>
  /** The latest first, then each new one. */
  readonly changes: Stream.Stream<{
    readonly slate: ReadonlyArray<GameSnapshot>
    readonly watchability: ReadonlyArray<Watchability>
  }>
}>()("sportal/hub/Slate") {
  static readonly layer: Layer.Layer<Slate, never, Ingest | GameActors>
}
```

- It sits at the Hub's top level, like `GameActors.ts`. One file is one concept, and there is no folder for one file.
- **Inputs.** The latest of `ingest.listed` and of `gameActors.changes`, combined. A new value on either side makes a
  new slate.
- **Bursts.** Recomputing is debounced by **250 ms** on the layer's clock. A poll makes one listing and up to one
  actor change per game, so it settles into one publication. In a scenario the window is in scenario time.
- **Watchability.** It is folded with `Watchability.fold(previous, slate, now)` on every publication, with `now` from
  the layer's clock. Refolding an unchanged snapshot is safe: `next` keeps `activeAt` when nothing was played. Because
  Ingest publishes its listing on every poll, the "no play for a minute" lull keeps appearing on the poll's cadence,
  as it does today. That coupling is deliberate. A tick of Slate's own is a later change if it ever matters.
- Only `Slate.ts` publishes the listing combined with the actors. Cadence reads the same `LiveGame.asActorsHaveThem` once per poll and keeps nothing.

### GameActors: unchanged

Its interface, its `LiveGames` registry, and its gauges stay as they are. `changes` gets its first production
consumer. The registry's writes and gauges belong to the actors' lifecycle, so they stay with the actors.

### Readers

| Reader | Before | After |
| --- | --- | --- |
| `GET /api/slate` | `ingest.slate` | `slate.latest`, its `slate` |
| `/api/live` | `watch.changes` | `slate.changes` |
| StageSessions' availability on the slate | `ingest.slate` | `slate.latest`, its `slate` |

### Hub mode: `apps/hub/src/HubMode.ts`

`Slate.layer` replaces `Watch.layer` in both modes, in the same place. In a scenario it shares the scenario clock with
Ingest, the actors, and the scenario provider, so the debounce and the fold run in scenario time.

## Restarts and failures

- **A provider fails for a league:** the listing keeps that league's last good games, and their actors go stale.
  This is unchanged.
- **An actor stops:** its game, if still listed, falls back to the listed snapshot on the next actor change.
- **Restart:** the first listing publishes the slate with polled snapshots. Nothing is stored, as before.

## Testing

TestClock throughout, through each module's own interface.

**`Ingest.test.ts`**, rewritten against `listed`:
- The first poll lists the provider's games in poll order.
- It polls again after the live cadence and lists the new games.
- It keeps the last listing when the provider fails.
- It retries after 30 s when the first poll fails.
- It lists on every poll, even one that changes nothing. The first poll runs before a subscriber attaches, so the test
  sees that listing and then one per poll, never the initial `[]`.
- A poll's snapshots reach the actors.
- A failed league's games are not resent, so its actor goes stale.
- Cadence follows the actors: the provider lists a game as scheduled, the test sends a live snapshot of it to its
  actor, and Ingest polls at the live interval.
- The span and metric tests are unchanged.

**`Slate.test.ts`**, new. Ingest runs over a scripted provider with the real actors on `Cluster.inMemory`:
- The slate keeps the listing's order.
- Each game's snapshot is its actor's: a game listed at period 1 whose actor holds period 2 shows period 2. This
  replaces Ingest's "the slate takes each game's snapshot from its live game".
- A snapshot sent to an actor between polls is on the slate after 250 ms, with no poll. This is the FastCast case.
- A poll of three games publishes once, not three times.
- A game an actor holds but no listing has is not on the slate.
- Watch's two tests move here unchanged in substance: the tied drive leads in `two-minute-drill-tie`, and lulls and
  red zones on `recorded-red-zones`.

**`HubServer.test.ts`**: `firstSlate` waits on `Slate.changes` instead of `ingest.changes`. Nothing else changes.

## Documents that change

- `CONTEXT.md`:
  - **Ingest:** "The Hub's loop that polls providers, keeps each league's last good listing, and sends what it polled
    to the game actors."
  - **Slate:** add "The Hub's `Slate` publishes it: each listed game as its game actor has it, with its watchability."
- `docs/technical-spec.md`: the Hub tree (`Slate.ts` at the top level, no `watch/`, Ingest's line becomes "The poll
  loop: listings to the slate, snapshots to the actors"), and the GameActors section's first bullet ("Slate, not
  Ingest, publishes the slate…").
- `docs/specs/2026-10-04-game-actors-design.md` is history and is left alone.

## Not in this piece

- `LiveGameState` on the wire, or a stale indicator in the UI.
- FastCast itself.
- StageSessions refreshing tiles when the slate changes (review candidate 5). Slate's `changes` makes it possible;
  it is not done here.
- `TestCluster` and the Hub composition in tests (review candidate 7).
