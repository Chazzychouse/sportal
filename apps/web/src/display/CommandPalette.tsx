import { useAtomSet } from "@effect/atom-react"
import { type Game, type GameId, GameSnapshot } from "@sportal/domain/Game"
import { LayoutName, type Screen, type ScreenCommand, Tile } from "@sportal/domain/Screen"
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
import { GameStatus } from "../game/GameStatus.tsx"
import { scoreline } from "../game/Score.tsx"
import { TeamLogo } from "../game/TeamLogo.tsx"
import { LayoutGlyph, layoutLabel } from "../layout/LayoutGlyph.tsx"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { keyText, tileActions } from "../screen/TileActions.tsx"

/** Every Screen command by name: watch a game, act on a tile, change layout, go full screen. */
export function CommandPalette(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  screen: Screen
  slate: ReadonlyArray<Game>
  selected: number
  onFullScreen: () => void
  onKeys: () => void
}) {
  const dispatch = useAtomSet(DisplayScreen.screen)
  const run = (command: ScreenCommand) => {
    dispatch(command)
    props.onOpenChange(false)
  }
  const snapshots = props.slate.map(({ snapshot }) => snapshot)
  const gameOn = (id: GameId) => snapshots.find((game) => game.id === id)
  const occupied = props.screen.onScreen().flatMap((tile, slot) => {
    if (Tile.guards.Empty(tile)) return []
    const game = gameOn(tile.game)
    return [{ slot, name: game === undefined ? `Tile ${slot + 1}` : scoreline(game) }]
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
      <CommandInput placeholder={`Watch a game in tile ${props.selected + 1}, or run a command…`} />
      <CommandList className="max-h-[min(60vh,28rem)]">
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading={`Watch in tile ${props.selected + 1}`}>
          {snapshots.toSorted(GameSnapshot.watchOrder).map((game) => (
            <CommandItem
              key={game.id}
              value={`watch ${scoreline(game)} ${game.away.team.name} ${game.home.team.name} ${game.networks()} ${game.id}`}
              onSelect={() => run({ _tag: "Assign", tile: props.selected, game: game.id })}
            >
              <TeamLogo team={game.away.team} size={16} />
              <span className="font-mono">{scoreline(game)}</span>
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
              tileActions(props.screen, slot, slot === props.selected)
                .filter((action) => action.id !== "unsolo")
                .map((action) => {
                  return (
                    <CommandItem
                      key={`${action.id}-${slot}`}
                      value={`${action.verb} ${tileWords[action.id]} ${name} tile ${slot + 1}`}
                      onSelect={() => run(action.command)}
                    >
                      {action.verb} {name}
                      {action.key !== undefined && <CommandShortcut>{keyText(action.key)}</CommandShortcut>}
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
              value={`layout ${layoutLabel(layout)} ${layout}`}
              onSelect={() => run({ _tag: "SetLayout", layout })}
            >
              <LayoutGlyph name={layout} />
              {layoutLabel(layout)}
              {props.screen.layout === layout && <CommandShortcut>current</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Display">
          {Option.isSome(props.screen.solo) && (
            <CommandItem value="unsolo" onSelect={() => run({ _tag: "Unsolo" })}>
              Unsolo
              <CommandShortcut>Esc</CommandShortcut>
            </CommandItem>
          )}
          <CommandItem
            value="full screen fullscreen"
            onSelect={() => {
              props.onFullScreen()
              props.onOpenChange(false)
            }}
          >
            Full screen
            <CommandShortcut>F11</CommandShortcut>
          </CommandItem>
          <CommandItem value="keys keyboard shortcuts help" onSelect={props.onKeys}>
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
