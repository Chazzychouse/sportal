import type { GameSnapshot } from "@sportal/domain/Game"
import { cn } from "@/design/ClassName"
import { statusText } from "./game/GameStatus.tsx"
import { TeamLogo } from "./game/TeamLogo.tsx"

/**
 * A scenario stream's scorebug, across the top: each team with its score and a dot on the team with the ball, and
 * between them the status and the down and distance, or "GOAL" when the line to gain is the goal line.
 */
export function ScenarioStrip(props: { game: GameSnapshot }) {
  const { game } = props
  const situation = game.situation
  const down = situation?.down

  return (
    <div className="flex items-center justify-between gap-[3vmin] px-[4vmin] py-[2vmin] font-sans">
      <Side game={game} side="away" />
      <div className="flex flex-col items-center gap-[1vmin] font-mono">
        <p className="text-[4vmin]">{statusText(game)}</p>
        {down !== undefined && situation?.distance !== undefined && (
          <p className="text-[3.5vmin] opacity-80">
            {["1st", "2nd", "3rd", "4th"][down - 1]} &amp;{" "}
            {situation.goalToGo() ? "GOAL" : situation.distance}
          </p>
        )}
      </div>
      <Side game={game} side="home" />
    </div>
  )
}

function Side(props: { game: GameSnapshot; side: "home" | "away" }) {
  const { game } = props
  const { team, score } = game[props.side]
  return (
    <div
      className={cn(
        "flex items-center gap-[2vmin] font-semibold text-[7vmin] tabular-nums leading-none",
        props.side === "home" && "flex-row-reverse"
      )}
    >
      <TeamLogo team={team} size={56} />
      <span>{team.abbreviation}</span>
      <span>{game.scored() ? score : null}</span>
      <span
        className={cn(
          "text-[3.5vmin] text-yellow-300",
          game.situation?.possession !== team.id && "invisible"
        )}
      >
        ●
      </span>
    </div>
  )
}
