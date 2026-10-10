import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { GameSnapshot } from "@sportal/domain/Game"
import { Option } from "effect"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut
} from "@/design/command"
import * as AutopilotState from "../autopilot/AutopilotState.ts"
import { AutopilotInput } from "../autopilot/AutopilotState.ts"
import { GameStatus } from "../game/GameStatus.tsx"
import { TeamLogo } from "../game/TeamLogo.tsx"
import * as LiveStream from "../hub/LiveStream.ts"
import { Layout } from "../layout/Layout.ts"
import { LayoutGlyph } from "../layout/LayoutGlyph.tsx"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { LayoutName, type ScreenCommand, Tile } from "../screen/Screen.ts"
import { TileAction } from "../screen/TileAction.ts"
import { DisplayInput } from "./Display.ts"
import * as DisplayState from "./DisplayState.ts"

/** Every Screen command by name: watch a game, act on a tile, change layout, go full screen. */
export function CommandPalette(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const input = useAtomSet(DisplayState.display)
  const toggleFullScreen = useAtomSet(DisplayState.toggleFullScreen)
  const autopilot = useAtomValue(AutopilotState.autopilot)
  const steer = useAtomSet(AutopilotState.autopilot)
  const display = useAtomValue(DisplayState.display)
  const screen = useAtomValue(DisplayScreen.screen)
  const { slate } = useAtomValue(LiveStream.live)
  const selected = display.selectedOn(screen)
  const run = (command: ScreenCommand) => {
    input(DisplayInput.Commanded({ command }))
    props.onOpenChange(false)
  }
  const snapshots = slate.games.map(({ snapshot }) => snapshot)
  const occupied = screen.onScreen().flatMap((tile, slot) => {
    if (Tile.guards.Empty(tile)) return []
    const name = Option.match(slate.gameOf(tile.game), {
      onNone: () => `Tile ${slot + 1}`,
      onSome: ({ snapshot }) => snapshot.scoreline()
    })
    return [{ slot, name }]
  })

  return (
    <CommandDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Command palette"
      description="Watch a game, act on a tile, or change the layout"
      showCloseButton={false}
      className="top-20 translate-y-0 border-border bg-popover sm:max-w-xl"
    >
      <CommandInput placeholder={`Watch a game in tile ${selected + 1}, or run a command…`} />
      <CommandList className="max-h-[min(60vh,28rem)]">
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading={`Watch in tile ${selected + 1}`}>
          {snapshots.toSorted(GameSnapshot.watchOrder).map((game) => (
            <CommandItem
              key={game.id}
              value={`watch ${game.scoreline()} ${game.away.team.name} ${game.home.team.name} ${game.networks()} ${game.id}`}
              onSelect={() => run({ _tag: "Assign", tile: selected, game: game.id })}
            >
              <TeamLogo team={game.away.team} size={16} />
              <span className="font-mono">{game.scoreline()}</span>
              <TeamLogo team={game.home.team} size={16} />
              <GameStatus game={game} className="text-[11px]" />
              <CommandShortcut>{game.networks()}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
        {occupied.length > 0 && (
          <CommandGroup heading="Tiles">
            {occupied.flatMap(({ slot, name }) =>
              // The Display group below has the Unsolo.
              TileAction.of(screen, slot, slot === selected)
                .filter((action) => action.id !== "unsolo")
                .map((action) => {
                  const shortcut = action.shortcut()
                  return (
                    <CommandItem
                      key={`${action.id}-${slot}`}
                      value={`${action.verb} ${tileWords[action.id]} ${name} tile ${slot + 1}`}
                      onSelect={() => run(action.command)}
                    >
                      {action.verb} {name}
                      {shortcut !== undefined && <CommandShortcut>{shortcut}</CommandShortcut>}
                    </CommandItem>
                  )
                })
            )}
          </CommandGroup>
        )}
        <CommandGroup heading="Layout">
          {LayoutName.literals.map((layout) => (
            <CommandItem
              key={layout}
              value={`layout ${Layout.label(layout)} ${layout}`}
              onSelect={() => run({ _tag: "SetLayout", layout })}
            >
              <LayoutGlyph name={layout} />
              {Layout.label(layout)}
              {screen.layout === layout && <CommandShortcut>current</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Display">
          {Option.isSome(screen.solo) && (
            <CommandItem value="unsolo" onSelect={() => run({ _tag: "Unsolo" })}>
              Unsolo
              <CommandShortcut>Esc</CommandShortcut>
            </CommandItem>
          )}
          <CommandItem
            value="full screen fullscreen"
            onSelect={() => {
              toggleFullScreen(undefined)
              props.onOpenChange(false)
            }}
          >
            Full screen
            <CommandShortcut>F11</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="autopilot auto follow"
            onSelect={() => {
              steer(AutopilotInput.Toggled())
              props.onOpenChange(false)
            }}
          >
            {autopilot.on ? "Turn the autopilot off" : "Turn the autopilot on"}
            <CommandShortcut>A</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="remote phone join qr"
            onSelect={() => input(DisplayInput.Opened({ overlay: "JoinRemote" }))}
          >
            Control from a phone
          </CommandItem>
          <CommandItem
            value="keys keyboard shortcuts help"
            onSelect={() => input(DisplayInput.Opened({ overlay: "Keys" }))}
          >
            Keys
            <CommandShortcut>?</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

// What else a tile's action is searched by.
const tileWords = { hear: "audio sound", promote: "main", solo: "full", unsolo: "", clear: "remove" }
