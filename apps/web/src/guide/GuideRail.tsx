import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Expand, Keyboard, LogIn, Minimize2, Smartphone } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/design/button"
import { cn } from "@/design/ClassName"
import { ToggleGroup, ToggleGroupItem } from "@/design/toggle-group"
import { BrandMark, ConnectionPill } from "../display/Brand.tsx"
import { Display, DisplayInput, type GuideEntry } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import * as Games from "../hub/Games.ts"
import { LayoutPicker } from "../layout/LayoutPicker.tsx"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import * as Theme from "../ui/Theme.ts"

interface GuideRailProps {
  entry: GuideEntry
  focused: boolean
}

/**
 * The full guide's left rail: Sportal's mark; the guide's entries, the one shown lit, All live with its count of live
 * games; and at its foot the Display's controls: theme, layout, YouTube TV, Remote, keys, full screen, and the Hub.
 */
export function GuideRail({ entry, focused }: GuideRailProps) {
  const input = useAtomSet(DisplayState.display)
  const shelves = useAtomValue(DisplayState.shelves)
  const live = shelves.shelves("AllLive", "Ribbon")[0]?.length ?? 0

  return (
    <nav aria-label="Guide entries" className="flex min-h-0 flex-col gap-1 border-r bg-guide-rail px-3 py-4">
      <div className="px-2 pb-5">
        <BrandMark />
      </div>
      {shelves.entries.map((each) => (
        <button
          key={each}
          type="button"
          tabIndex={-1}
          data-focused={focused && each === entry}
          onClick={() => input(DisplayInput.GuideEntryChosen({ entry: each }))}
          className={cn(
            "guide-focus flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm",
            each === entry
              ? "bg-foreground font-semibold text-background"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          {Display.entryName(each)}
          {each === "AllLive" && live > 0 && (
            <span className="flex items-center gap-1 font-mono text-live text-xs" title="Games live now">
              <span className="size-1.5 rounded-full bg-live" />
              {live}
            </span>
          )}
        </button>
      ))}
      <RailFoot />
    </nav>
  )
}

function RailFoot() {
  const input = useAtomSet(DisplayState.display)
  const screen = useAtomValue(DisplayScreen.screen)
  const { connection } = useAtomValue(Games.today)
  const fullScreen = useAtomValue(DisplayState.fullScreen)
  const toggleFullScreen = useAtomSet(DisplayState.toggleFullScreen)
  const signIn = useAtomValue(DisplayState.signIn)
  const openSignIn = useAtomSet(DisplayState.openSignIn)
  const theme = Theme.useTheme()
  const setTheme = useAtomSet(Theme.theme)

  return (
    <div className="mt-auto flex flex-col gap-2 border-t pt-3">
      <ToggleGroup
        type="single"
        size="sm"
        value={theme}
        onValueChange={(value) => {
          const name = Theme.ThemeName.literals.find((each) => each === value)
          if (name !== undefined) setTheme(name)
        }}
        aria-label="Theme"
        className="w-full"
      >
        {Theme.ThemeName.literals.map((name) => (
          <ToggleGroupItem
            key={name}
            value={name}
            className="label-caps flex-1 text-[11px] text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground"
          >
            {themeLabels[name]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <LayoutPicker
        current={screen.layout}
        onChoose={(layout) => input(DisplayInput.Commanded({ command: { _tag: "SetLayout", layout } }))}
      />
      {signIn && (
        <RailButton onClick={() => openSignIn(undefined)}>
          <LogIn />
          YouTube TV
        </RailButton>
      )}
      <RailButton onClick={() => input(DisplayInput.Opened({ overlay: "JoinRemote" }))}>
        <Smartphone />
        Remote
      </RailButton>
      <RailButton keys="?" onClick={() => input(DisplayInput.Opened({ overlay: "Keys" }))}>
        <Keyboard />
        Keys
      </RailButton>
      <RailButton keys="F11" onClick={() => toggleFullScreen(undefined)}>
        {fullScreen ? <Minimize2 /> : <Expand />}
        Full screen
      </RailButton>
      <div className="px-2 pt-1">
        <ConnectionPill connection={connection} />
      </div>
    </div>
  )
}

function RailButton(props: { keys?: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-keyshortcuts={props.keys}
      className="label-caps w-full justify-start text-muted-foreground text-xs"
      onClick={props.onClick}
    >
      {props.children}
      {props.keys !== undefined && (
        <kbd className="ml-auto font-mono text-[10px] text-muted-foreground">{props.keys}</kbd>
      )}
    </Button>
  )
}

const themeLabels: Record<Theme.ThemeName, string> = { glass: "Glass", team: "Team" }
