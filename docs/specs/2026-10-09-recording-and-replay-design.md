# Recording and replay

2026-10-09. Designs the persistence ADR 0012 left for later and the offline play ADR 0013 removed. Comes after the ESPN
one-writer cleanup (`2026-10-09-espn-one-writer-design.md`), though it does not depend on it.

## What it gives

- **Recovery.** A restarted Hub shows the day it had (listings, snapshots, plays) before its first poll.
- **Replay.** A Hub can play a recorded day as its provider, from a time of day, at a speed.

Not history queries, retention, or replay of sources: during a replay, tiles show no stream.

## Where it records: the `Provider` port

The Hub records what its provider delivers: each batch of `ReadonlyArray<Delivery>`, as domain values. Not raw frames
(ADR 0008's feed log, removed by ADR 0012: tied to ESPN's wire format, larger, and recovery would rebuild `EspnState`).
Not each `Slate` (replay would bypass `Slate.take`, and every change would store the whole slate).

So `Director`, `Slate`, `HubServer` and the ESPN provider do not change. A replay replaces the whole provider, so
nothing that reads the time during a replay cares what day it is, except availability, which answers for today: a
replayed game has no channel. There is no substitute clock.

## What it stores: changes, not deliveries

Deliveries can't be stored as they are. On the NFL Sunday recording, 13 game topics took 17,565 pushes; each is a
`Plays` of the game's whole list (about 90 plays of about 400 bytes on average), about 600 MB for one window. An FBS
listing sends about 300 games on every poll.

The log stores each batch as changes against what it last held:

| Delivery | Stored as |
|---|---|
| `Listing { league, games }` | `Listed { league, ids, changed }`: the listing's ids in order, and only the snapshots that differ from what the log held |
| `Snapshot { snapshot }` | `Snapshot`, only when it differs from what the log held |
| `Plays { game, plays }` | `Played { game, upserted, removed }`: plays new or changed (by `PlayId`), and the ids gone |

A batch that changes nothing stores nothing. Reading a day folds the changes back into full batches. **Reading a day
gives back exactly the batches recorded, less those that changed nothing**; the slate ignores those anyway.

`Delivery` gets a Schema (it is a `Data.taggedEnum` now), as do the three changes.

## How it stores: SQLite

One database, `<dataDir>/sportal.sqlite`, through `@effect/sql-sqlite-node` (Node's built-in `node:sqlite`; no native
dependency), migrated by `SqliteMigrator`:

```sql
CREATE TABLE changes (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,          -- 2026-10-04
  received_at INTEGER NOT NULL,
  line TEXT NOT NULL          -- one change, encoded as JSON by its Schema
);
CREATE INDEX changes_by_time ON changes (day, received_at);
```

A batch's changes are written in one transaction. One generic table, not a table per game or play: history can add
those if it is ever wanted.

A **day** runs from 5 AM to 5 AM local time and is named for the date it starts on, so an overtime past midnight
stays in its day.

## Components

```
            live                                       replay
 Espn.layer ──► Provider                    Recording.day(d, from) ──► paced batches
                  │                                          │
     Recording.provider(live): today's recorded batches,    │
     then live ones, each one recorded ──────────────────► Provider ──► Director (unchanged)
```

**`Recording`** (`apps/hub/src/Recording.ts`, a class module, a service):

- `record(deliveries, receivedAt): Effect<void>`: one batch, as changes against what it last held, in one
  transaction. A batch that changes nothing writes nothing.
- `day(day, from?): Stream<{ deliveries, receivedAt }>`: a day's changes in order, folded back into full batches.
- `Recording.layer`: SQLite at `HubConfig.dataDir`, migrated at startup. `Recording.layerTest`: in memory, for tests and
  for a day written by hand.
- The change codec and what the log last held are private to it.

**`Recording.provider(live)`**: a `Layer.unwrap` over `HubConfig.replay`, the Hub's one choice of provider.

- **No replay.** `deliveries` gives today's recorded batches first (recovery), then the live provider's, recording each
  live one. Reading today also primes what the log last held, so the first live batch is compared against it.
  Recovered batches are not recorded again.
- **A replay.** `deliveries` comes from `Recording.day(day, from)`. Batches before `from` come at once, so the slate is
  right at the start; after it they are paced at their recorded spacing divided by `speed`. When the day runs out it
  logs that the replay finished and stays idle: a stream that ends is a failure to the Director. The live provider is
  never built, and nothing is recorded.

**`main.ts`**: `Espn.layer` becomes `Recording.provider(Espn.layer)`, and `Recording.layer` is provided.

**`HubConfig`**:

- `dataDir`: `SPORTAL_DATA_DIR`, by default `~/.local/share/sportal`.
- `replay: Option<{ day, from, speed }>`: `SPORTAL_REPLAY=2026-10-04`; `SPORTAL_REPLAY_FROM=15:30`, by default the start of
  the day; `SPORTAL_REPLAY_SPEED=4`, by default 1.

## Errors

- A write that fails is logged and counted (`sportal_recording_errors`); the live batch still reaches the Director.
  Recording never stops the slate.
- A recovery read that fails is logged, and the Hub starts empty, as it does today.
- A replay of a day that is missing or empty fails the Hub at startup, saying so.
- A stored line that does not decode is skipped and logged; the rest of the day is read.

## Words

In `CONTEXT.md`, in the commit that builds it:

- **Recording** replaces the planned *Persistence*: every day's changes, as the Hub's provider delivered them.
- **Replay** replaces the planned *Scenario*: a Hub playing a recorded day as its provider.
- **Day**: 5 AM to 5 AM local time, named for the date it starts on.

ADR 0016 records the decision, superseding ADR 0012's "nothing is kept between runs".

## Testing

One thing per test, "should" descriptions, Arrange-Act-Assert; fakes are each service's `layerTest`.

`Recording.test.ts`, against `Recording.layerTest`, and one suite against SQLite at `:memory:`:

- Reading a day should give back the batches recorded from the NFL Sunday recording (its frames through `EspnState`),
  less those that changed nothing.
- A batch that changes nothing should write nothing.
- A listing with one game changed should store one snapshot, not the league.
- A play changed or removed by a later `Plays` should come back changed or removed.
- `day(d, from)` should start with the state as of `from`.
- Changes at 4:59 AM and 5:01 AM should be in different days.
- A line that does not decode should be skipped, and the rest of the day read.

`Recording.provider`, with `Provider.layerTest` as the live provider and `TestClock`:

- With today recorded, it should give today's batches, then the live ones.
- It should not record recovered batches again.
- A write that fails should still deliver the live batch, and count the error.
- A replay at speed 4 should give batches at a quarter of their spacing; those before `from` at once.
- A replay should stay idle after its last batch, not end.
- With a replay set, the live provider should not start.

`HubConfig.test.ts`:

- `SPORTAL_REPLAY` alone should replay from the start of the day at speed 1.
- A replay day that is not a date should fail.

## Before shipping

- Record the NFL Sunday and CFB Saturday recordings and check each day is tens of MB. If not, the codec is revisited
  first.
- Game-day checklist: record a few minutes live, restart, and see the slate and plays back before the first poll; then
  replay that day at speed 10 and eye-check the field and plays.
