# Domain slate — design

Status: approved 2026-10-09.

## Goal

Make the slate one domain type that the Hub folds, the live stream sends, and the web holds, instead of three shapes of the
same concept:

| Where | Today |
|---|---|
| Hub `apps/hub/src/Slate.ts` | `Data.Class { games: Game[] }` with `take(deliveries)` |
| Wire `LiveMessage.SlateChanged` | an unnamed `games: { game, availability }[]` |
| Web `LiveStream`'s `Live` | `slate: Game[]` beside `availability: Map<GameId, …>`, re-split from the pairs |

"The domain schema is the wire format" holds only once the slate itself is what crosses the wire.

## Decisions

- **The domain `Slate` is the fold state.** It holds the listed games with their full plays. It has no availability and
  knows nothing of sources: availability depends on the time and the Source, not on the games.
- **Availability is joined on the wire, not in the slate.** `SlateChanged` carries the slate and an availability record
  beside it.
- **Availability stays frozen at send time.** The live route evaluates it once per message, as today. An `Upcoming`
  airing reaching its begin shows on the client only at the next slate or source change. This is a known gap, not fixed
  here.
- **The fold moves to domain without `Delivery`.** `Delivery` is the provider port's vocabulary and stays beside
  `Provider`. The domain owns what a listing and a play list do to the slate. The Director reduces each frame's
  deliveries onto those operations.
- **The Director keeps its telemetry.** Its gauges and play logs stay where they are, fed by the slate changes its take
  gets back. Director-slate-only stands: the port still offers only `slate: Stream<Slate>`.
- The Hub and the web ship together, so the `SlateChanged` change needs no compatibility path.

## Domain

`packages/domain/src/Slate.ts`, a class module:

```ts
export class Slate extends Schema.Class<Slate>("sportal/Slate")({
  games: Schema.Array(Game)
}) {
  static readonly empty: Slate
  relisted(league: LeagueId, snapshots: ReadonlyArray<GameSnapshot>): readonly [Slate, ReadonlyArray<SlateChange>]
  playsTaken(game: GameId, plays: ReadonlyArray<Play>): readonly [Slate, ReadonlyArray<SlateChange>]
  recent(): Slate
}

export type SlateChange = Data.TaggedEnum<{
  Progressed: { readonly game: Game }
  Delisted: { readonly game: Game }
  Played: { readonly game: Game; readonly play: Play }
}>
export const SlateChange = Data.taggedEnum<SlateChange>()
```

- `relisted` and `playsTaken` carry today's `relisted` and `changed` behaviour unchanged: leagues in
  `LeagueId.literals` order, each league's games in its listing's order; snapshots taken through `Game#snapshotTaken`,
  plays through `Game#playsTaken`; plays of a game the slate does not have are dropped; an operation that changes nothing
  returns this slate itself and no changes, and a game it does not change stays the same `Game`.
- `recent()` is this slate with every game trimmed by `Game#recent`, or this slate itself when none is trimmed.
- `SlateChange` is a member type beside the class. It never crosses the wire, so it stays a `Data.TaggedEnum`.
- `apps/hub/src/Slate.test.ts` moves to `packages/domain/src/Slate.test.ts`. Its assertions are kept; tests of
  `take` over several deliveries become tests of the domain operations, or move to `Director.test.ts` where what they
  assert is the order of a frame's deliveries. The commit body maps each old test name to its new one.

## Hub

- `apps/hub/src/Slate.ts` is deleted.
- `Director`'s `take` reduces a frame's deliveries in order, starting from the slate it holds, collecting changes:
  `Listing` → `slate.relisted(league, games)`, `Plays` → `slate.playsTaken(game, plays)`, through `Delivery.$match`.
  It sets the Ref only when the final slate is not the one it started from, then observes the changes as today.
- The live route builds `SlateChanged` from `slate.recent()` and a record of each listed game's availability, evaluated
  at `now` as today. Settling, de-duplication and replay are unchanged.

## API

`packages/api/src/LiveMessage.ts`:

```ts
SlateChanged: {
  slate: Slate,
  availability: Schema.Record(GameId, Schema.Array(ChannelAvailability))
}
```

Every game on the slate has an entry. `LiveMessage.test.ts`'s encoding test is updated to the new fields.

## Web

- `Live` becomes `{ connection, slate: Slate, availability: Record<GameId, ReadonlyArray<ChannelAvailability>> }`,
  set from `SlateChanged` as decoded, with no rebuilding. The initial value is `Slate.empty` and an empty record.
- Readers of `live.slate` read `live.slate.games` where they need the list. Lookups of a game's availability read the
  record (`availability[game] ?? []`).
- `TestLiveStream`'s message builder takes a slate and an availability record.

## Docs

- `CONTEXT.md`: **Slate** points at `packages/domain/src/Slate.ts` and describes `relisted`, `playsTaken`, `recent`;
  **Slate change** moves with it; **Slate changed** carries the slate and the availability record.
- `docs/technical-spec.md`: the file map and the Director section follow the move.

## Out of scope

- Making the ESPN folds pure (`GameTopics.take` decoding and logging inside the fold, `FastCastDocuments.advance`
  failing with `SchemaError`): its own spec after this one.
- Moving the Director's telemetry out of the Director.
- Re-sending availability on a clock.

## Verification

- `pnpm check` passes before every commit.
- Every existing assertion of `Slate.test.ts`, `Director.test.ts`, `HubServer.test.ts`, `LiveMessage.test.ts`, and the
  web's `LiveStream` and `DisplayScreen` tests is kept or mapped.
- A run of `pnpm dev` shows the slate and channel availability in the web as before.
