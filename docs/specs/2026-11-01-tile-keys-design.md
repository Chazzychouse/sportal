# Tile keys

Removing, moving and swapping tiles from the keyboard is hard today: clearing a tile needs the palette, swapping
needs a mouse drag, and moving goes only to the main slot (`Shift+1–9`, promote). This makes the selected tile the
thing the keyboard acts on.

## Keys

While the guide is closed. While it is open, the guide keeps its keys as today.

| Key | Does |
|---|---|
| `Alt+1–9` | Select tile N (unchanged) |
| `←` `↑` `→` `↓` | Select the neighbouring tile that way |
| `Shift+←` `↑` `→` `↓` | Carry the selected tile that way: swap it with its neighbour; the selection goes with it |
| `Shift+1–9` | Carry the selected tile to slot N: swap the two; the selection goes with it |
| `X`, `Delete`, `Backspace` | Clear the selected tile |
| `1–9`, `F`, `I`, `L`, `G`, `Esc` | Unchanged |

`Shift+N` replaces promote. With the main tile selected it does what promote did, except for sound (below).

At an edge, an arrow with no neighbour that way does nothing. Carrying onto the selected slot itself does nothing.
Carrying or clearing with an empty tile selected: carry swaps (an empty tile can be moved like any other); clear
does nothing.

## Hotkey (`packages/api/src/Hotkey.ts`)

- `Promote { slot }` becomes `Carry { slot }`.
- New: `CarryToward { direction }`, `SelectToward { direction }`, `ClearTile`.
- `Hotkey.of`, guide closed: an arrow is `SelectToward`, `Shift`+arrow is `CarryToward`, `KeyX`, `Delete` and
  `Backspace` are `ClearTile`. Guide open: arrows stay `Move`, `Delete` and `Backspace` stay `Remove`;
  `Shift`+arrow and `KeyX` are `CarryToward` and `ClearTile` as when closed.
- `Hotkey.keys` gains the new rows and the `Shift+1–9` row is reworded; the key help reads it, so it follows.

## Display (`apps/web/src/display/Display.ts`)

- `Carry { slot }`: a `Swap` of the selected slot and `slot`, and the selection moves to `slot`. A slot past the
  last on screen does nothing.
- `CarryToward { direction }`: the same, to the neighbour that way.
- `SelectToward { direction }`: `select` the neighbour that way.
- `ClearTile`: a `Clear` of the selected slot, unless it is empty.

Moving the selection keeps or ends interacting as `select` does today.

**Neighbour.** A pure function of the layout's slot rectangles (`Layout.of(screen).slots()`): among the slots whose
centre lies strictly that way from the selected slot's centre, those that overlap it across the axis come first (in
Main + 5, up from the bottom middle tile is the main tile, not the nearer tile at the right); then the nearest along
the axis; then the nearest across it; then slot order. None when no slot lies that way. It is `Layout#neighbour`,
beside `slots()`.

## Sound

Promote moved the sound to the promoted tile. `Carry` does not: the tile heard stays heard, wherever it goes.

## Stream views (`apps/desktop/src/main/TileViews.ts`)

No change. A non-interactive view forwards whatever `Hotkey.of` returns, so arrows and `X` pressed there become
Sportal's instead of the player's. An interactive view still gets every key but `Esc` and `Ctrl+K`.

## Palette (`apps/web/src/display/CommandPalette.tsx`)

The Tiles group gains "Swap with …" for each other on-screen slot, run as the `Carry` hotkey so the selection goes
with the tile, as it does from the keyboard; each shows its `⇧N`. The stale comment in `TileChrome.tsx` ("every swap
is also in the command palette") becomes true. The palette's promote action stays: it still sends `Promote`, which
moves the sound.

## Tile actions (`apps/web/src/screen/TileAction.ts`)

Promote loses its `Shift+N` key: that key now carries the selected tile, which is promote only when the main tile is
selected. Clear gains `X` when its tile is selected, as Solo shows `F`.

## Tests

- `Hotkey.of`: each new key, guide open and closed; `Shift+N` is `Carry`.
- `Display.press`: carry to N, carry toward, select toward, clear; an edge does nothing; selection follows a carry.
- `TileAction`: promote has no key; clear shows `X` only on the selected tile.
- Neighbour: each layout, each direction, including edges.
- Palette's swap entries are not unit-tested (React view).
