# The web UI on Effect and atoms

2026-10-10. A cleanup of `apps/web` with no change in behaviour.

## The problem

The web UI's state is split three ways. Some lives in atoms (`LiveStream.live`, `DisplayScreen.screen`), some in React
state (`Display` in `useDisplay`), and some in hand-rolled mutable stores (`OverlayHost`'s `makeHost`,
`FullScreen.ts`'s module `let`). Effects on the outside world are scattered through views:

- `window.sportalShell` is read in six files. ScreenView alone syncs tile placements, listens for video presses, relays
  guide reads to the Hub, and asks the shell to read again on reconnect, beside measuring and rendering.
- Five components write screen commands to the screen atom themselves; `DisplayView` loops over a step's commands.
- `HubRuntime.ts` is a `ManagedRuntime` that a view runs with `runFork`; `FullScreen.ts` calls `Effect.runFork`.
- Change detection is done with refs and `JSON.stringify`.

Smaller defects: loose exported functions (`tileRects`, `placements`, `coveredGames`, `tileActions`, `keyText`,
`layoutLabel`, `scoreline`, `sendGuide`), the rectangle shape written out about eight times, three copies of finding a
slate game by id, a class module named for a plural (`StripCards.ts`), ten copies of
`new DisplayStep({ display, commands: [] })`, `settle` called in every branch of `Screen.apply`, and the Field's
drawing state machine hidden untested in a 372-line component file.

## The shape

Views render and say what a person did. State, and every effect on the window, the shell, the Hub, and storage, is
an atom over one `Atom.runtime` of Effect services. React keeps only what needs an element: measuring, and a
component's own animation state.

Behaviour does not change: every key, click, drag, transition, toast, and stored Screen works as today. Every existing
test assertion is kept, moving with its code.

The tree after (`*` new or renamed, `✗` deleted):

```
apps/web/src/
  main.tsx
  WebRuntime.ts*        the one Atom.runtime: HubClient, Shell, FetchHttpClient
  TestWeb.ts
  design/               unchanged
  hub/      HubClient.ts · LiveStream.ts · GuideRelay.ts* · HubRuntime.ts✗
  shell/*   Shell.ts*
  display/  Display.ts · DisplayState.ts* · Covering.ts* · OverlayRef.ts* · DisplayView.tsx · TopBar.tsx · Brand.tsx
            CommandPalette.tsx · KeysDialog.tsx · OverlayHost.tsx✗ · FullScreen.ts✗ · Hotkeys.ts✗
  screen/   Screen.ts · DisplayScreen.ts · Rejections.ts · TileRects.ts (pure geometry) · TilePlacements.ts* (atoms)
            TileAction.ts* (was TileActions.tsx) · ScreenView.tsx · TileChrome.tsx · TileBody.tsx · Dividers.tsx
  slate/    StripCard.ts* (was StripCards.ts) · SlateView.tsx · PlaceBadge.tsx
  layout/   Layout.ts · LayoutGlyph.tsx · LayoutPicker.tsx
  game/     Field.tsx · FieldDrawing.ts* · GameStatus.tsx · Score.tsx · TeamLogo.tsx
```

`knip --production` fails on an export only tests use. So pure functions stay exported from a module the atoms
import (`TileRects.ts`), and an atom a hook writes is written from a sibling module (`OverlayRef.ts` writes
`Covering.overlays`), so each export has a production user.

## 1. Shell

`shell/Shell.ts` is the web UI's edge to its window and the desktop shell, and the only module that reads
`window.sportalShell`, `document` full screen, or `window` key events.

```ts
export class Shell extends Context.Service<Shell, {
  /** Hotkeys from the page (not repeats, not typed into a field, not already handled; Ctrl+K always) and from the shell. */
  readonly hotkeys: Stream.Stream<Hotkey>
  readonly fullScreen: Stream.Stream<boolean>
  readonly tilePressed: Stream.Stream<GameId>
  readonly guideRead: Stream.Stream<string>
  readonly setFullScreen: (on: boolean) => Effect.Effect<void>
  readonly syncTiles: (
    placements: ReadonlyArray<TilePlacement>,
    transition: Option.Option<ScreenTransition>
  ) => Effect.Effect<void>
  readonly setHidden: (games: ReadonlyArray<GameId>) => Effect.Effect<void>
  readonly readGuide: Effect.Effect<void>
  /** Opens the YouTube TV sign-in; none in a plain browser. */
  readonly openSignIn: Option.Option<Effect.Effect<void>>
}>()("sportal/web/shell/Shell") {
  static readonly layer: Layer.Layer<Shell> = Layer.unwrap(/* the bridge when present, else the browser */)
  static layerTest(/* event streams, and an effect that records each call */)
}
```

- Every callback becomes a stream through `Stream.callback`, its unsubscribe released by `acquireRelease`, as
  `LiveStream` already does.
- Page keys: the rules in today's `Hotkeys.ts`, unchanged — `Hotkey.of(…, "page")`, no repeats, a key typed into an
  input, textarea, or editable element or already handled is skipped unless it is the command palette's, and a taken
  key's default is prevented. Merged with the shell's forwarded hotkeys.
- Browser layer: `fullScreen` follows `fullscreenchange`; `setFullScreen` requests or exits full screen and logs a
  warning when the browser refuses, as today; `tilePressed` and `guideRead` are empty; `syncTiles`, `setHidden`,
  and `readGuide` do nothing; `openSignIn` is none.
- `layerTest` takes its event streams and a `record` effect that sees each call, and imports no fixture.

## 2. One runtime and the Hub client

`src/WebRuntime.ts`:

```ts
export const runtime = Atom.runtime(
  Layer.mergeAll(HubClient.layer, Shell.layer).pipe(Layer.provide(FetchHttpClient.layer))
)
```

`HubRuntime.ts` and its `ManagedRuntime` go. `HubClient`'s service becomes `{ sendGuide }`, an
`Effect.fn("HubClient.sendGuide")` member; the answer-did-not-decode defect handling moves inside it. The raw `api`
and the loose `sendGuide`/`answerRead` go.

`hub/GuideRelay.ts` exports `relay`, a `runtime.atom` mounted by DisplayView:

- Each `shell.guideRead` is sent with `HubClient.sendGuide`; a refusal is logged as a warning, as today.
- `shell.readGuide` runs each time the live connection becomes `Connected`: the live atom's stream, mapped to whether
  it is connected, `Stream.changes`, filtered to true.
- The shell's first read waits for the web UI to ask, so the guide listener is forked with `startImmediately` before
  the connection loop starts.

## 3. The Display atom

`DisplayInput` sits in `Display.ts` beside the class, a `Data.taggedEnum` of what a person does on a Display:

| Case | From |
|---|---|
| `Pressed { hotkey }` | `inputs`, every hotkey but `FullScreen` |
| `Selected { slot }` | a tile header's button |
| `VideoPressed { game }` | the shell's tile press; `Display` finds the slot with `screen.slotOf` and selects it, or does nothing |
| `Dropped { card }` | a slate card |
| `Commanded { command }` | tile action buttons, the layout picker, a divider drop, a header drag-swap, palette items |
| `Opened { overlay }`, `Closed`, `SlateToggled` | the top bar, the palette, a dialog closing |

- `Display#apply(input, screen, cards): DisplayStep` is the one entry; `press`, `select`, and `drop` stay as the
  methods it calls.
- `DisplayStep.of(display, commands = [])` replaces the ten hand-built steps.
- `Overlay` is exported as `Display`'s member type; `Exclude<Overlay["_tag"], "None">` goes.

`display/DisplayState.ts`:

```ts
/** This Display's local state. An input written to it is applied against the Screen and the strip; the step's commands go to the Screen. */
export const display: Atom.Writable<Display, DisplayInput> = Atom.writable(
  (get) => get(kept),
  (ctx, input) => {
    const step = ctx.get(kept).apply(input, ctx.get(DisplayScreen.screen), ctx.get(cards))
    ctx.set(kept, step.display)
    step.commands.forEach((command) => ctx.set(DisplayScreen.screen, command))
  }
)

/** The slate strip's cards for this Screen and the live slate. */
export const cards = Atom.make((get) => StripCard.of(get(DisplayScreen.screen), get(LiveStream.live).slate))
```

Beside them:

- `fullScreen`: a `runtime.atom` of `shell.fullScreen`, read as `false` until the first value. `toggleFullScreen`: a
  `runtime.fn` asking `shell.setFullScreen` for the opposite of `fullScreen`.
- `inputs`: a `runtime.atom` mounted by DisplayView. It runs `shell.hotkeys` and `shell.tilePressed` merged: `FullScreen`
  goes to `toggleFullScreen`, every other hotkey to `display` as `Pressed`, a tile press as `VideoPressed`.
- `signIn`: whether `shell.openSignIn` is some; `openSignIn`: a `runtime.fn` running it. TopBar shows its YouTube TV
  button from them.

Views:

- Each view reads the atoms it needs. DisplayView stops threading `screen`, `slate`, `connection`, `selected`, and
  `cards`; TopBar, ScreenView, SlateView, and CommandPalette lose most of their props.
- No view writes `DisplayScreen.screen`; all goes through `display`. `useDisplay` and the precomputed `toggleSolo`
  step in DisplayView go; TopBar asks the Display whether `ToggleSolo` would send anything, as DisplayView does today.
- SlateView's `droppable` is `card.pickable()`, which is what a drop's having commands comes to.
- The palette's Watch still sends `Assign` to the selected tile (`Commanded`), then `Closed`. Routing it through
  `Display.drop` would pick the game, move the selection, and refuse a game on screen: a behaviour change, left for a
  follow-up.

## 4. Tile placements and covering

ScreenView still measures its element with a `ResizeObserver`, and writes the result to the `area` atom. Dividers write
the dragged split to `dragged`.

`screen/TileRects.ts` stays the pure geometry (`tileRects`, `placements`, `coveredGames`, `gap`, `tileHeader`),
imported as a namespace, its rectangles typed `TileBounds`. `screen/TilePlacements.ts` holds `screenTransition` and:

| Atom | Value |
|---|---|
| `area` (writable) | the Screen area's size and place in the window |
| `dragged` (writable) | `Option<Split>`, the split being dragged until its drop |
| `shown` | the Screen with the dragged split (`withSplit`) |
| `rects` | `tileRects(shown, area)` |
| `placements` | `placements(shown, rects, area, display.interactingOn(screen))` |
| `sync` (mounted) | each changed set of placements to `shell.syncTiles` |

`sync` keeps today's rules, without refs or `JSON.stringify`:

- Nothing is sent while the area has no width.
- Placements are compared by an equivalence derived from `TilePlacement`'s schema; only a change is sent, so a
  re-render never cuts a transition short.
- The transition is sent when the arrangement (the layout, its split, solo, and the game in each slot, read from the
  Screen without the dragged split) differs from the one sent with the last placements, there was one, and nothing is
  being dragged. Otherwise none: a resize or a drag moves the views at once.

`display/Covering.ts` and `display/OverlayRef.ts` replace `OverlayHost.tsx`, its context, and `makeHost`:

- `overlays` (writable): each open overlay element's rectangle.
- `useOverlayRef()` (in `OverlayRef.ts`, was `useCovering`) is the ref callback an overlay's content takes. While the element is mounted, a `ResizeObserver`
  and an `animationend` listener write its rectangle; unmounting removes it.
- `hidden` (private): `TileRects.coveredGames(overlays, placements)`. The videos come from `TilePlacements.placements`;
  `useVideoAreas` goes.
- `sync` (mounted): each change of `hidden` to `shell.setHidden`, starting from nothing hidden, so nothing is sent
  until something is covered.

Rectangles have two names and are never written out inline:

- `Slot` in `Layout.ts`: a rectangle as fractions of the Screen area, the layout's slots and the glyph's.
- `TileBounds` from the api package for pixels; its glossary row widens to a tile's rectangle in the Screen area or a
  tile view's in the window.

ScreenView keeps measuring and rendering tiles and Dividers, about 80 lines, with no shell code.

## 5. Mechanical cleanups

1. `StripCards.ts` → `StripCard.ts`, with its test.
2. `TileActions.tsx` → `screen/TileAction.ts`: a `TileAction` `Data.Class` with `static of(screen, slot, selected)` and
   `shortcut()` (was `keyText`). The views pick each action's icon by `id`, and the hear icon by `screen.hears`. The
   palette's search words stay in the palette.
3. `layoutLabel` → `Layout.label(name)`; `LayoutGlyph.tsx` keeps only its component.
4. `scoreline` → `GameSnapshot#scoreline()` in the domain, beside `matchup()`; its tests move to `Game.test.ts`.
5. `Slate#gameOf(id): Option<Game>` in the domain; CommandPalette, ScreenView, and `StripCard.of` use it, and views take
   the `Slate`, not its games.
6. `Screen.apply`: each branch gives the next fields, and `Result.map(…, settle)` runs once. A private `holds(tile, game)`
   replaces the inline occupied-and-this-game checks.
7. `game/FieldDrawing.ts` takes `Drawing`, `FieldEvent`, `step`, `nextOf`, and the queue length out of `Field.tsx`,
   which keeps rendering with `useReducer(FieldDrawing.step, …)`.
8. Comments that restate the code are trimmed wherever code moves; those that explain a constraint stay.

Left alone: `localTime` in `GameStatus.tsx`, `design/`, and `TestWeb`'s builders beyond imports that follow renames.

## 6. Glossary

`CONTEXT.md` gains **Display input**, **Slot**, **Shell** (the web UI's edge to its window and the shell bridge),
**Field drawing**, and **Field event**.
**Hub client** (its runtime is `WebRuntime.ts`), **Tile bounds**, **Display**, and **Strip card** follow the new files.
`AGENTS.md`'s mention of `HubRuntime.ts`, if any, follows too.

## 7. Tests

Moved with their code, every assertion kept: `TileRects.test.ts` stays, `StripCards.test.ts` →
`StripCard.test.ts`, `TileActions.test.ts` → `TileAction.test.ts`, the `scoreline` tests → `Game.test.ts`.

New:

- `Display#apply`: each case that is not a plain delegate, and one delegate check each for press, select, and drop.
- `DisplayState`: an input sets the next Display and applies its commands to the screen; `fullScreen` follows the
  shell; the toggle asks for the opposite; `inputs` routes `FullScreen`, other hotkeys, and tile presses.
- `GuideRelay`: each guide is sent; a read is asked on each change to `Connected` and not otherwise; the listener is
  subscribed before the first ask.
- `Shell`'s page keys: each skip rule, and Ctrl+K passing.
- `TilePlacements.sync`: a transition on an arrangement change; none on a resize or a drag; nothing when the placements
  are unchanged or the area has no width.
- `Covering`: an open overlay hides the videos it covers; closing shows them; nothing is sent while `hidden` is
  unchanged.
- `FieldDrawing.step`: settles on first sight; animates a fresh play; queues only the newest three; skips plays with no
  spots; settles when the feed starts over; ignores a `Drawn` for another play.

Atom tests run in an `AtomRegistry` whose runtime layer is swapped for `Shell.layerTest` and a fake `HubClient`.

## 8. Order

On branch `web-effect-atoms` in its own worktree, each phase one or more commits with `pnpm check` green:

1. Mechanical cleanups (section 5).
2. Shell, the runtime, the Hub client, the guide relay.
3. `DisplayInput`, `Display#apply`, `DisplayState`; views write inputs; `FullScreen.ts` and `Hotkeys.ts` go.
4. Tile placements and covering; `OverlayHost.tsx` goes; ScreenView slims.
5. Glossary and doc references.

A commit rewriting a test lists each old test name and the new ones carrying its assertions.

Agent-launched Electron misreports on this machine, so after phases 3 and 4 the user checks in `pnpm dev`: hotkeys in
the page and with a video focused; clicking a video selects its tile; a layout change animates and a drag or resize
does not; the palette and the keys dialog hide the videos beneath and bring them back; full screen in the shell and a
browser; the guide read again after a Hub restart; the Screen kept across a reload.

## Follow-ups

- The palette's Watch through `Display.drop` (a behaviour change).
