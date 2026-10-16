import { useAtomSet } from "@effect/atom-react"
import type { GameId } from "@sportal/domain/Game"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/design/button"
import { GameStatsView } from "../stats/GameStats.tsx"
import { DisplayInput } from "./Display.ts"
import * as DisplayState from "./DisplayState.ts"
import { useOverlayRef } from "./OverlayRef.ts"

/** A game's stats page over the whole Display, every video under it hidden; Escape or Back returns to where it opened. */
export function GamePage(props: { game: GameId }) {
  const ref = useOverlayRef()
  const input = useAtomSet(DisplayState.display)
  return (
    <div ref={ref} className="fixed inset-0 z-40 overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 flex items-center border-b bg-background/90 px-4 py-2 backdrop-blur">
        <Button
          variant="ghost"
          size="sm"
          aria-keyshortcuts="Escape"
          onClick={() => input(DisplayInput.Closed())}
        >
          <ArrowLeft />
          Back
        </Button>
      </header>
      <GameStatsView game={props.game} fit="page" />
    </div>
  )
}
