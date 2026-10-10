# Remote

2026-10-10. The phone Remote comes back ([parked](2026-10-09-display-owns-screen-design.md#3-the-remote-is-parked)
when the Screen moved to each Display), now with the prompts ([Prompts](2026-10-10-prompts-design.md)). A phone scans a
Display's join code and controls that Display's Screen: layout, tiles, sound, solo, the autopilot and prompts toggles,
and the prompt, answered with Watch or Skip.

The phone is an iPhone in Safari, on the home network at `http://<lan-address>:<port>`, as before. Plain HTTP is not a
secure context, so there is no service worker, Push API, Notification API or Screen Wake Lock: a prompt shows in the
page, with a chime, only while the Remote is open and the phone unlocked. A phone that comes back to the page reconnects
and shows the prompt that still holds; prompts have no timer.

Not in this spec: a lock-screen push (needs HTTPS: Tailscale or the home box), a Display picker on the phone, names for
Displays, and two Displays sharing one id.

## 1. The Hub relays

The Screen stays on the Display (ADR 0015). The Hub passes a Display's report to its remotes and their inputs to the
Display without reading either: both ends are the web app, and only the web decodes them. Nothing about the Screen
moves to `packages/api`.

### `apps/hub/src/Displays.ts`

A service (`sportal/hub/Displays`) holding in memory, per Display id, the latest report (opaque JSON, or none yet) and
a queue of inputs waiting for that Display.

- `connect(id)`: the Display's input stream. Opening it registers the Display; closing it removes the Display and its
  report.
- `report(id, json)`: keeps the report and passes it to the Display's followers. Fails with `DisplayOffline` when no
  input stream for `id` is open.
- `follow(id)`: a stream of `Reported { report }` and `Offline`: the current state, then each change. `Offline` while
  no Display with that id is connected, or while it is connected but has not reported yet.
- `send(id, json)`: queues an input for the Display. Fails with `DisplayOffline` when it is not connected; inputs are
  never held for a Display that may not come back.

Nothing is persisted. A restarted Hub knows no Displays until they reconnect.

### The `displays` group in `SportalApi`

| Endpoint | Caller | Does |
| --- | --- | --- |
| `GET /api/displays/:id/inputs` (SSE) | Display | The inputs sent to it, one per `input` event, and a `keep-alive` every 20 s |
| `PUT /api/displays/:id` | Display | Its report. 204, or 404 `DisplayOffline` |
| `GET /api/displays/:id` (SSE) | Remote | `Reported` / `Offline` events, and a `keep-alive` every 20 s |
| `POST /api/displays/:id/inputs` | Remote | One input. 204, or 404 `DisplayOffline` |

Bodies that carry a report or an input are JSON the Hub does not decode beyond "is JSON". `DisplayOffline` is a
`Schema.TaggedError` in `packages/api`. The keep-alives let the server notice a Display or Remote that vanished without
closing its stream.

### Join addresses

`GET /api/host/addresses`: the LAN addresses a phone can reach the Hub at, none of them loopback, home ranges first.
Restored from git (`HubServer.lanAddresses` and its tests, removed in 1e81ce2).

## 2. The Display's side

### Display id

Each Display makes a random id once and keeps it in its browser: an `Atom.kvs` under `sportal/display-id`. In the
shell this is the shell's own storage, so the desk and the TV each have their own.

### `apps/web/src/remote/RemoteReport.ts`

A `Schema.Class` (`sportal/RemoteReport`): what a Display tells its remotes.

- `screen`: the `Screen`;
- `autopilot`: whether the autopilot is on;
- `prompts`: whether prompts are on;
- `prompt`: `Option<Prompt>`.

`Prompt` becomes a `Schema.Class` now that it crosses the wire; its fields, `commands()` and `words(nameOf)` are
unchanged. The slate is not in the report: the Remote has the live stream.

### `apps/web/src/remote/RemoteInput.ts`

A `Schema.TaggedUnion`: what a remote sends a Display.

- `Commanded { command: ScreenCommand }`: set on `AutopilotState.yours`, as a command from this Display is, so it lands
  on the Screen and is yours to the autopilot (suspending it as any command you send does).
- `Pressed { hotkey: Hotkey }`: goes through the same `route` in `DisplayState` as the shell's hotkeys, so
  `ToggleAutopilot`, `TogglePrompts`, `AcceptPrompt`, `DismissPrompt` and `ToggleSolo` mean what their keys mean.

### `apps/web/src/remote/RemoteLink.ts`

The Display's link to its remotes, an atom the Display mounts beside `inputs`, `pilot` and `log`:

1. Open `GET /api/displays/:id/inputs`.
2. Once it is open, `PUT` the current report, then each report that differs from the last one sent
   (`Schema.toEquivalence(RemoteReport)`).
3. Decode each input and apply it as above. One that does not decode is logged as a warning and dropped.
4. When the stream drops, reconnect on the live stream's schedule; the Hub forgot the report, so step 2 sends it again.

### Join Remote

`apps/web/src/remote/JoinRemote.tsx` is restored and adapted: an overlay with a QR code and the URL
`http://<address>:<port>/remote/<display-id>`, one per join address. Opened from the command palette and a top-bar
button; the `JoinRemote` overlay comes back in `Display`. `uqr` comes back as a dependency.

## 3. The Remote

### Route

`main.tsx` shows `RemoteView` for `/remote/:displayId` and the Display for every other path.

### `apps/web/src/remote/RemoteState.ts`

- `followed`: the Display as the Remote sees it, a `Data.TaggedEnum`: `Connecting`, `Offline`, or
  `Reported { report }`, from `GET /api/displays/:id`. A report that does not decode is `Offline`, with a warning.
- `send`: a `runtime.fn` posting one `RemoteInput`. `DisplayOffline` shows a toast: "The Display is offline".
- The Remote's own `Display` value (the selected tile), applied with `select` and `drop` against the reported Screen;
  the commands it gives go out as `Commanded`.
- `chime`: a new prompt (another game or `since` than the last one) plays a short chime through Web Audio. iOS lets a
  page play sound only after a tap, so until the first tap the page shows "Tap to enable sound".

### `apps/web/src/remote/RemoteView.tsx`

Restored and adapted, top to bottom:

1. **The prompt** (`RemotePrompt.tsx`), pinned at the top while the report has one: its `words`, and two large buttons,
   **Watch** (`Pressed AcceptPrompt`) and **Skip** (`Pressed DismissPrompt`).
2. **The header**: brand, connection, the autopilot and prompts toggles (`Pressed ToggleAutopilot` /
   `TogglePrompts`), and Unsolo while the Screen is soloed.
3. `LayoutPicker` (its `fill` prop comes back) and `ScreenMap` (restored), sending their commands as `Commanded`.
4. The slate in tabs; tapping a game puts it in the selected tile and selects the next empty one.

While `followed` is `Connecting` or `Offline`, a line reads "Display offline, waiting…" and every control is
disabled; the slate stays readable.

## 4. Records

- CONTEXT.md: **Remote** moves up from Planned: a phone's view and control of one Display, at `/remote/:displayId`.
  New rows: **Display id**, **Remote report** (what a Display tells its remotes: its Screen, its toggles, its prompt),
  **Remote input** (a screen command or a hotkey a remote sends a Display), **Displays** (the Hub's in-memory relay
  between Displays and their remotes). **Phone push** stays Planned: a prompt delivered to a phone's lock screen,
  which needs HTTPS.
- ADR 0017: the Hub relays between a Display and its remotes without reading what it relays; the Screen stays on the
  Display.
- `docs/technical-spec.md`: the `displays` group and `host/addresses`.

## 5. Tests

- `Displays.test.ts`: an input sent reaches its Display; sending to an unconnected Display fails with
  `DisplayOffline`; reporting without an open input stream fails with `DisplayOffline`; a follower gets the current
  report, then each new one; a follower sees `Offline` when its Display disconnects; a disconnect forgets the report.
- `HubServer.test.ts`: each `displays` route end to end; the restored `addresses` and `lanAddresses` tests.
- `RemoteLink.test.ts`: it reports once its input stream opens; it does not send an unchanged report again; it
  reports again after reconnecting; a `Commanded` input lands on the Screen and is yours to an autopilot that is on;
  `Pressed AcceptPrompt` accepts the prompt; an input that does not decode changes nothing.
- `RemoteState.test.ts`: `followed` goes `Reported`, `Offline`, `Reported`; tapping a slate game sends
  `Commanded Assign` on the selected tile; a new prompt chimes and the same prompt again does not.
- `Prompt.test.ts`: a prompt round-trips through its schema.

Then, on the iPhone over the LAN: join by QR code, answer a prompt from the phone, and see the autopilot suspend.
