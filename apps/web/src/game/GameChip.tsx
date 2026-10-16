import type { GameSnapshot } from "@sportal/domain/Game"
import { useTheme } from "../ui/Theme.ts"
import { GameStatus } from "./GameStatus.tsx"
import { Score } from "./Score.tsx"
import { teamEdge, teamHalf } from "./TeamColors.ts"
import { TeamLogo } from "./TeamLogo.tsx"

interface GameChipProps {
  game: GameSnapshot
  focused: boolean
  onChoose: () => void
}

/** A game as the ribbon shows it, in the theme's shape: the two teams and their score, over the game's status. */
export function GameChip({ game, focused, onChoose }: GameChipProps) {
  const theme = useTheme()
  return (
    <button
      type="button"
      tabIndex={-1}
      data-focused={focused}
      aria-label={game.scoreline()}
      onClick={onChoose}
      className="guide-focus h-full max-h-32 w-52 shrink-0 rounded-card text-left"
    >
      {theme === "glass" ? <GlassChip game={game} /> : <TeamChip game={game} />}
    </button>
  )
}

function GlassChip({ game }: { game: GameSnapshot }) {
  return (
    <div className="relative flex h-full flex-col justify-center gap-1.5 overflow-hidden rounded-card border border-card-edge py-2 pr-3 pl-4 backdrop-blur-[var(--guide-blur)] [background:var(--card-surface)]">
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: teamEdge(game) }}
      />
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 font-mono text-sm">
        <Score game={game} side="away" />
        <Score game={game} side="home" />
      </div>
      <GameStatus game={game} className="truncate text-[11px]" />
    </div>
  )
}

function TeamChip({ game }: { game: GameSnapshot }) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-card">
      <div className="grid min-h-0 flex-1 grid-cols-2">
        {(["away", "home"] as const).map((side) => (
          <div
            key={side}
            className="flex items-center justify-center gap-1.5 px-1"
            style={{ background: teamHalf(game[side].team, side) }}
          >
            <TeamLogo team={game[side].team} size={26} />
            <span className="font-bold font-mono text-lg text-white drop-shadow">
              {game.scored() ? game[side].score : game[side].team.abbreviation}
            </span>
          </div>
        ))}
      </div>
      <div className="bg-card-footer px-2 py-1">
        <GameStatus game={game} className="block truncate text-[11px]" />
      </div>
    </div>
  )
}
