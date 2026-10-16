import type { GameSnapshot } from "@sportal/domain/Game"
import { Situation } from "@sportal/domain/Situation"
import { cn } from "@/design/ClassName"
import { useTheme } from "../ui/Theme.ts"
import { GameStatus } from "./GameStatus.tsx"
import { standing, trails } from "./Score.tsx"
import { teamEdge, teamHalf } from "./TeamColors.ts"
import { TeamLogo } from "./TeamLogo.tsx"

interface GameCardProps {
  game: GameSnapshot
  focused: boolean
  onChoose: () => void
}

/**
 * A game as the full guide shows it, in the theme's shape: both teams with their logos, rankings or records, and
 * scores; its status; the situation's short line while it is live; and its networks.
 */
export function GameCard({ game, focused, onChoose }: GameCardProps) {
  const theme = useTheme()
  return (
    <button
      type="button"
      tabIndex={-1}
      data-focused={focused}
      aria-label={game.scoreline()}
      onClick={onChoose}
      className="guide-focus shrink-0 rounded-card text-left"
    >
      {theme === "glass" ? <GlassCard game={game} /> : <TeamCard game={game} />}
    </button>
  )
}

function GlassCard({ game }: { game: GameSnapshot }) {
  return (
    <div className="relative w-60 overflow-hidden rounded-card border border-card-edge px-3.5 py-3 backdrop-blur-[var(--guide-blur)] [background:var(--card-surface)]">
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: teamEdge(game) }}
      />
      {(["away", "home"] as const).map((side) => (
        <div key={side} className="flex items-center gap-2.5 py-0.5">
          <TeamLogo team={game[side].team} size={30} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[15px]",
              trails(game, side) && "text-muted-foreground"
            )}
          >
            {game[side].team.name}
            <span className="ml-1.5 text-muted-foreground text-xs">{standing(game, side)}</span>
          </span>
          <span
            className={cn(
              "font-mono font-semibold text-[22px]",
              trails(game, side) && "text-muted-foreground"
            )}
          >
            {game.scored() ? game[side].score : null}
          </span>
        </div>
      ))}
      <div className="mt-1.5 flex justify-between gap-2 text-muted-foreground text-xs">
        <GameStatus game={game} className="shrink-0" />
        <span className="truncate">{footer(game)}</span>
      </div>
    </div>
  )
}

function TeamCard({ game }: { game: GameSnapshot }) {
  return (
    <div className="w-64 overflow-hidden rounded-card">
      <div className="grid h-24 grid-cols-2">
        {(["away", "home"] as const).map((side) => (
          <div
            key={side}
            className="flex flex-col items-center justify-center gap-0.5"
            style={{ background: teamHalf(game[side].team, side) }}
          >
            <span className="drop-shadow-md">
              <TeamLogo team={game[side].team} size={40} />
            </span>
            <span className="font-bold font-mono text-2xl text-white drop-shadow">
              {game.scored() ? game[side].score : game[side].team.abbreviation}
            </span>
            <span className="text-[10px] text-white/75">{standing(game, side)}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-between gap-2 bg-card-footer px-2.5 py-1.5 text-muted-foreground text-xs">
        <GameStatus game={game} className="shrink-0" />
        <span className="label-caps truncate">{footer(game)}</span>
      </div>
    </div>
  )
}

/** The card's footer after the status: the situation's short line while live, then the networks. */
function footer(game: GameSnapshot): string {
  return [situationLine(game), game.networks()]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ")
}

/** Down and distance ("2nd & 7", "1st & Goal"), or the count and outs ("2-1, 1 out"); none unless live. */
function situationLine(game: GameSnapshot): string | undefined {
  if (game.progress() !== "live" || game.situation === undefined) return undefined
  return Situation.match(game.situation, {
    Football: (football) =>
      football.down === undefined
        ? undefined
        : `${ordinals[football.down - 1] ?? `${football.down}th`} & ${football.goalToGo() ? "Goal" : (football.distance ?? "")}`,
    Baseball: ({ balls, strikes, outs }) => `${balls}-${strikes}, ${outs} ${outs === 1 ? "out" : "outs"}`
  })
}

const ordinals = ["1st", "2nd", "3rd", "4th"]
