# Each Display owns its Screen

2026-10-09. Supersedes ADR 0003 (the Hub owns Stage state).

## The problem

The Director holds one Screen that every Display shares, and applies every screen command on the Hub. ADR 0003 put it
there for two reasons: a phone must be able to change what a TV shows, and automation must be able to change the Screen
while no client is focused.

Neither holds up now:

- Automation does not exist. The Director's rules are planned, and when they come their output is better as a ranking
  of games by watchability than as screen commands. The Hub says what is worth watching; each Display decides how its
  layout shows it.
- The Remote is the one real user, and it is parked (below).
- One shared Screen contradicts the product plan, where the desk and the TV each run their own Screen.

The Hub also decides which source wins for a game: `Source.layerAll` collapses every source's answer into one with
`mostUseful`. That is a choice about what to show, made on the server.

## 1. The Hub publishes the slate and each game's availability

The Director holds only the slate.

- Gone: the `screen` `SubscriptionRef`, `dispatch`, `screen`, `screenChanges`, and the refresh on `source.changes`.
- It still yields `Source`. It publishes each game beside its availability, and publishes again when the slate takes
  a change or `source.changes` emits. Nothing is published when neither the slate nor any game's availability changed.
- A game's availability is every source's answer for it, in `Source.layerAll` order:
  `ReadonlyArray<ChannelAvailability>`. `layerAll` no longer picks one; `mostUseful` and `usefulness` leave
  `Source.ts`. A source's answers carry its name where a Display needs it: a `Carried` answer's `channel.source`.
- `ChannelAvailability` in `Channel.ts` becomes a `Schema.TaggedUnion`, so it can go on the wire. `Tile.DataTile.why`
  reuses its shapes where they match.

The API:

- `SportalApi` loses the `screen` group (`GET /api/screen`, `POST /api/screen/commands`), and `HubServer` its handlers.
- `LiveMessage` loses `ScreenChanged`. `SlateChanged` becomes
  `{ games: Array<{ game: Game, availability: Array<ChannelAvailability> }> }`, a shape written inline and not named.

## 2. The Display owns its Screen

`packages/domain/src/Screen.ts` and `TestScreen.ts`, with `Screen.test.ts`, move to `apps/web/src/screen/`. After the
move only the web app imports them: the desktop shell takes tile placements over `ShellBridge`, not Screens.

- `apply`, `settle`, and the invariants are unchanged. `ScreenRejection` drops `httpApiStatus`.
- Choosing between sources moves here. `apply` and `refresh` take a game's availability (the array). On assign, a
  tile is built from the most useful answer, by the ranking `Source.ts` had (carried; upcoming on a known channel;
  upcoming; no guide; streaming only; not in the guide; no stream). On refresh, a stream tile is replaced only when an
  answer `Carried` on its own source names another channel; every other answer leaves it as it is. A data tile is
  rebuilt from the most useful answer. A game with no availability (off the slate) keeps its tile, as today.
- A screen atom in `apps/web/src/screen/` holds the Display's Screen. A screen command runs `Screen.apply` against
  the availability on the live slate; a rejection goes to the rejection toasts. Each slate change runs `Screen.refresh`.
- The atom writes the Screen to localStorage on every change and reads it on start, falling back to `Screen.initial`
  when nothing is stored or it does not decode; the first slate's refresh corrects any stale channel. It is marked
  `TODO(Chase): fix this once persistence layers are added`.
- `HubClient` loses `dispatch` and `screenFailures`. The toasts keep the rejection texts and lose "The Hub did not
  get that". `LiveStream`'s `Live` keeps the connection and the slate, now with availability.

## 3. The Remote is parked

Removed: `apps/web/src/remote/` (`RemoteView`, `ScreenMap`, `JoinRemote`), the `/remote` route in `main.tsx`, the
`JoinRemote` overlay and the Display and command palette entries that open it, and the Hub's `host` group
(`hostAddresses`), whose only user was `JoinRemote`. It comes back with its own design.

## 4. Records

- ADR 0015, "Each Display owns its Screen", supersedes 0003. It records the two things left for later: automation
  delivers a ranking of games, not screen commands; and a stream budget shared across Displays will need the Hub's
  coordination.
- ADR 0003 gains a note pointing to 0015.
- CONTEXT.md: **Director**, **Screen**, **Screen command**, **Screen rejection**, **Live message**, **Hub client**,
  and **Display** follow this; **Remote** moves under Planned.
- `docs/technical-spec.md` follows where it describes the Screen on the Hub.

## 5. Tests

- `Screen.test.ts` moves with its module. New cases: assign picks the most useful of several answers; refresh keeps a
  stream tile when another source carries the game; refresh replaces it when its own source carries it on another
  channel.
- `Source.test.ts` loses its most-useful cases (they move to `Screen.test.ts`); `layerAll` is tested to give every
  source's answer in order.
- The Director loses its screen tests. New: a source change republishes the slate with the new availability; no
  change in availability publishes nothing.
- The screen atom: a command applies against the slate's availability; a slate change refreshes; a stored Screen is
  restored; an undecodable one falls back to `Screen.initial`.
- `LiveStream`, `LiveMessage`, `HubServer`, and `HubClient` tests lose their Screen and Remote parts.

## Out of scope

Classification and watchability ranking; persistence beyond localStorage; the Remote's redesign; a stream budget
across Displays.
